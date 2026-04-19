# Gateway-proxied realtime voice architecture

Status: design note (pre-implementation).
Scope: iOS realtime voice conversations that run as real OpenClaw agent sessions.

This document describes the target architecture for iOS realtime voice. Today iOS
can reach Azure OpenAI realtime directly ("Tier 2"), which ships audio but bypasses
the agent pipeline (system prompt, tools, memory, session history). The gateway
bridge described here replaces that direct path so a voice conversation is a real
agent session that happens to use Azure realtime as the transport for audio and
LLM turns.

## Goals

- iOS connects to the gateway over WSS; the gateway connects to Azure realtime.
- The gateway injects the active agent's system prompt, tool schemas, recent
  history, and a memory snapshot into `session.update` so the realtime model
  behaves as that agent, not a stock realtime persona.
- Tool calls emitted by the realtime model are executed inside the gateway's
  normal agent tool pipeline (subagents, MCP, core tools) and results are fed
  back to the realtime model.
- Turns appear in `sessions.list` / `sessions.history` like any other agent
  session.
- The iOS audio pipeline (AVAudioEngine, voiceChat mode, semantic VAD, barge-in)
  stays transport-agnostic; only the transport module changes.

## Non-goals

- Rewriting the Tier 1 discrete voice path (record-then-send).
- Replacing `extensions/voice-call` (phone/Twilio) realtime — that stays on
  g711_ulaw and its own provider config.
- Making realtime turns participate in automatic compaction or long-running
  agent scheduling; voice sessions are short-lived and capped.

## Reused seams

The gateway already has most of the building blocks:

- `src/realtime-voice/provider-types.ts` defines `RealtimeVoiceBridge`,
  `RealtimeVoiceBridgeCallbacks`, and `RealtimeVoiceTool`. The contract already
  accepts `instructions`, `tools`, and `submitToolResult(callId, result)`, and
  emits `onToolCall` events. It is agnostic to who the caller is.
- `extensions/openai/realtime-voice-provider.ts` implements that contract for
  Azure / OpenAI realtime. Today it is only wired for the Twilio / `voice-call`
  path, so it hardcodes `g711_ulaw` for `input_audio_format` /
  `output_audio_format`. iOS needs `pcm16`; we must make the audio format
  configurable on the bridge create request.
- `src/plugin-sdk/realtime-voice.ts` re-exports the provider types and
  registry. Any new public seam should extend the existing types here rather
  than inventing a parallel API.

Nothing in the tool registry or system-prompt composition is realtime-aware
today. The text chat path composes prompts via `src/agents/cli-runner`,
`src/agents/system-prompt-params.ts`, and the per-attempt composer
`composeSystemPromptWithHookContext` in `src/agents/pi-embedded-runner/run/
attempt.thread-helpers.ts`. The tool registry is plugin-owned through
`src/plugins/tools.ts` + `AnyAgentTool` (ultimately `@mariozechner/pi-agent-core`
`AgentTool`).

## Session model

A voice session is an agent session with a distinct session kind.

- Session key: `agent:<agentId>:main:voice:<uuid>` (appears in
  `sessions.list` beside text sessions).
- Persistence: turn transcripts land on the standard session sink so the
  session looks like a chat session. Audio frames are never persisted.
- Lifecycle caps: 15 min wall-clock, 50 realtime turns, 3 MB buffered input
  audio pre-`session.ready`. Any cap breach closes the WS with code 4009 and a
  `session.end` event.
- Multi-device: exactly one active voice session per agent at a time; a second
  `talk.realtime.start` closes the prior session with code 4010.

## Transport

Two seams on the gateway WS.

### Control RPC: `talk.realtime.start`

Request (operator-authenticated, existing paired iOS socket):

```json
{
  "agentId": "main",
  "providerId": "openai",
  "voiceId": "alloy"
}
```

Response:

```json
{
  "sessionKey": "agent:main:voice:9b7c…",
  "ticket": "<short-lived jwt, 60s TTL>",
  "wsUrl": "wss://<gateway-host>/talk/realtime",
  "audio": {
    "sampleRateHz": 24000,
    "format": "pcm16",
    "channels": 1
  },
  "cap": {
    "wallClockMs": 900000,
    "maxTurns": 50
  }
}
```

The ticket is single-use, bound to the operator's connect client id, and only
valid for opening a WS to `/talk/realtime`. This keeps the control plane socket
free for `talk.mode` / `sessions.*` / `chat.*` and isolates realtime lifetimes.

### Realtime WS: `wss://<gateway>/talk/realtime?ticket=<t>`

iOS opens this WS after receiving the ticket. The gateway validates the ticket,
resolves the agent + provider, opens the Azure realtime WS, and proxies events
in both directions.

Client to gateway events:

| event                       | payload                                         |
| --------------------------- | ----------------------------------------------- |
| `input_audio_buffer.append` | `{ audio: base64 pcm16 }`                       |
| `input_audio_buffer.commit` | `{}`                                            |
| `response.cancel`           | `{}`                                            |
| `session.end`               | `{ reason: "user_cancel" \| "app_background" }` |
| `ping`                      | `{ ts }`                                        |

Gateway to client events:

| event                                                 | payload                            |
| ----------------------------------------------------- | ---------------------------------- |
| `session.ready`                                       | `{ sessionKey, audio, cap }`       |
| `response.audio.delta`                                | `{ audio: base64 pcm16 }`          |
| `response.audio.done`                                 | `{ itemId }`                       |
| `conversation.item.input_audio_transcription.partial` | `{ text }`                         |
| `conversation.item.input_audio_transcription.final`   | `{ text }`                         |
| `response.output_text.delta`                          | `{ text }`                         |
| `response.output_text.done`                           | `{ text }`                         |
| `response.tool_call.started`                          | `{ callId, name }`                 |
| `response.tool_call.finished`                         | `{ callId, name, durationMs, ok }` |
| `fallback.activated`                                  | `{ from, to, reason }`             |
| `error`                                               | `{ code, message, recoverable }`   |
| `closed`                                              | `{ reason, code }`                 |
| `ping`                                                | `{ ts }`                           |

Rationale: this is intentionally a thin subset of OpenAI realtime so an iOS
adapter can map between them with a small lookup. Tool execution, memory
injection, and history hydration happen server-side and are invisible to the
client protocol.

## Session.update composition

When the gateway opens the Azure WS, it sends a single `session.update`
synthesized from the current agent state, not from voice-specific config.

```ts
session.update = {
  modalities: ["text", "audio"],
  voice,                     // talk.providers[openai].voiceId
  input_audio_format:  "pcm16",
  output_audio_format: "pcm16",
  input_audio_transcription: { model: "whisper-1" },
  turn_detection: { type: "semantic_vad", ... },
  temperature,               // agent-level override if set
  instructions: <composedSystemPrompt>,
  tools: <agentToolsAsRealtimeTools>,
  tool_choice: "auto",
}
```

`instructions` is built by reusing the same composition helpers as text chat:

1. `buildSystemPromptParams(...)` for the active agent.
2. `composeSystemPromptWithHookContext(...)` to run the same hook context
   (`system-prompt-cache-boundary`, `system-prompt-override`, etc.) so voice
   and text turns share the same system prompt prefix (prompt-cache
   stability).
3. A small voice-mode preamble appended last:
   - "You are speaking over a live voice call. Keep replies short and
     conversational. Use tools when they would produce a better answer."

The preamble is the ONLY voice-specific string. Everything else comes from the
agent's text-chat system prompt.

`tools` is built by walking the agent's tool registry (the same registry text
chat uses) and mapping each `AnyAgentTool` to a `RealtimeVoiceTool` via a new
helper `serializeToolsForRealtimeVoice(tools)` in the realtime-voice package.
Tools whose schemas cannot be losslessly expressed in the OpenAI realtime
`tools` shape (e.g. schemas with `oneOf`, non-`type:"object"` roots, or binary
inputs) are dropped and a gateway-side warning is logged. Voice mode never
auto-adds tools that text mode does not have.

A memory snapshot is injected as a final `conversation.item.create` before the
first `response.create`:

- `memory-core` active summary (most recent agent-chosen summary).
- Recent session history: last 6 text turns from the matching agent's default
  text session, rendered as alternating user/assistant `conversation.item`
  entries with text-only content.

Size budget: 4 KB for the memory summary + 8 KB for recent history, measured
by character count not tokens, to keep the first `response.create` latency
predictable. If budgets are exceeded, history is trimmed oldest-first.

## Tool dispatch

The bridge already emits `onToolCall({ itemId, callId, name, args })`. For the
gateway-side handler we need to execute that tool in the same way text chat
would.

Two layers:

1. Tool registration: a voice-session `ToolRunContext` is created when the WS
   opens. It is the same shape as the per-attempt `tool-run-context` in
   `src/agents/pi-embedded-runner/run/attempt.tool-run-context.ts`, but
   without a live `attempt` object. It reuses the agent's `fsPolicy`,
   `agentDir`, `sessionKey`, `deliveryContext` (voice origin marker), and
   ambient scopes.
2. Tool execution: when a `response.function_call_arguments.done` event
   arrives, the handler looks up the tool by name in the registry, runs its
   validator on the parsed args, and invokes `tool.run({ args, ctx })` under
   an `AbortSignal` scoped to the realtime session. The `AgentToolResult` is
   serialized to the same `tool.output` JSON shape text chat uses and posted
   back via `bridge.submitToolResult(callId, result)`. The resulting `response.create`
   is sent by the bridge; the gateway emits `response.tool_call.finished` to
   iOS.

Parallel tool calls: the realtime model can emit multiple function calls per
response. The handler tracks outstanding calls and does not send
`response.create` until all outputs are submitted (matches OpenAI realtime
contract).

Errors: tool-level errors become `function_call_output` with `{ error, code,
message }` so the realtime model can decide how to recover; the WS client sees
`response.tool_call.finished` with `ok: false`. Infrastructure errors (e.g.
the tool implementation throws) close the realtime session with code 4011 and
an `error` frame.

Auth: the voice session inherits the same `senderIsOwner`, ambient scope, and
`tools.disabledForVoice` deny list that the agent already exposes. Tools that
require an interactive approval prompt are disabled in voice mode (they have
no UI to display the prompt), and the bridge announces that in
`session.ready.disabledTools`.

Decision to confirm: should approval-required tools instead be routed to the
companion text channel (Control UI or iOS chat pane) so the user can approve
there while the voice session waits? This is out of scope for the first
gateway bridge cut but should be prototyped next.

## Fallback

The bridge upgrades the Azure realtime URL from the configured primary
(`OPENCLAW_AZURE_REALTIME_DEPLOYMENT=gpt-realtime-1-5`) to the fallback
(`OPENCLAW_AZURE_REALTIME_DEPLOYMENT_FALLBACK=gpt-realtime`) when the primary:

- Returns HTTP 503, 429, or 401 on upgrade.
- Closes with code 1011 or 1006 within 2 s of `session.ready`.

Fallback triggers emit a `fallback.activated` event on the client WS so the iOS
UI can show a subtle indicator. The gateway does not fall back a second time;
if the fallback fails, the session closes.

## Session caps and safety

- Hard cap: 15 min wall-clock, 50 realtime turns, 3 MB buffered pre-`session.ready`.
- Soft cap: after 10 min, emit a `cap.warning` event with remaining time; iOS
  overlay displays a timer.
- Cost cap: per-agent daily USD budget read from `talk.providers[openai].dailyUsdBudget`.
  When the running session's projected cost crosses the budget, the gateway
  emits `cap.warning` and, after 30 s, `closed` with reason `budget_exceeded`.
- Rate limit: one voice session per operator, one per agent. Second start
  closes the first.

## Config surface

One new config key (plus existing `talk.providers[openai].*`):

```jsonc
{
  "talk": {
    "providers": {
      "openai": {
        "realtimeBridge": true, // enable gateway bridge
        "realtimeModel": "gpt-realtime-1-5",
        "realtimeModelFallback": "gpt-realtime",
        "realtimeApiVersion": "2025-04-01-preview",
        "voiceId": "alloy",
        "dailyUsdBudget": 5,
      },
    },
  },
}
```

`realtimeBridge` is `false` by default; when true, `talk.realtime.start`
returns a valid ticket and iOS uses the gateway transport. When false, iOS
falls back to the existing Tier 1 discrete path. The direct-to-Azure Tier 2
path is disabled by default in the gateway-bridge build; it remains available
as a debug flag for bisecting regressions.

Schema drift: adding `realtimeBridge`, `realtimeModel`,
`realtimeModelFallback`, `realtimeApiVersion`, and `dailyUsdBudget` to the
config schema / help surfaces requires regenerating the config docs drift
hash (`pnpm config:docs:gen`) in the same commit that adds the fields.

## iOS adapter

New module `OpenClawKit/Sources/OpenClawKit/GatewayRealtimeTransport.swift`
(to be authored in this branch, not the Tier 2 branch).

- Owns the WSS to the gateway `/talk/realtime` endpoint plus the
  `talk.realtime.start` RPC on the existing operator socket.
- Exposes the same `OpenAIRealtimeVoiceSessionEvent` stream the existing
  `OpenAIRealtimeVoiceSession` emits so `TalkRealtimeSessionRuntime` does not
  need to know which transport is in use.
- Maps gateway events to the existing Swift enum: `session.ready` ->
  `.sessionReady`; `response.audio.delta` -> `.assistantAudioChunk(pcm16:)`;
  `response.tool_call.started` / `finished` -> new
  `.assistantToolCall(state:)` case; `fallback.activated` ->
  `.transportFallbackActivated(from:to:)`; `closed` -> `.sessionClosed(reason:)`.
- Handles ticket refresh: if the WS closes with 4401
  (`ticket_expired`) the adapter requests a fresh ticket via RPC and reopens.

Invariant: `VoiceProviderEndpoints.swift` stays the only `switch kind` on iOS.
The adapter layer selects between `directAzureTransport` and
`gatewayTransport` in one place, not scattered through runtime code.

## Test plan

Unit tests (TS):

- `session.update` payload shape for a given agent, including deterministic
  ordering of tools (prompt-cache stability).
- `serializeToolsForRealtimeVoice(tools)` drops unsupported tool schemas with
  a deterministic warning and preserves ordering.
- Memory snapshot size budget is enforced (4 KB summary, 8 KB history).
- Tool dispatch: a fake Azure WS emits a `function_call_arguments.done`, the
  bridge executes the matching registry tool, posts a
  `function_call_output`, and the gateway emits
  `response.tool_call.finished`.
- Fallback ordering: primary fails with 503 -> fallback opens -> iOS receives
  `fallback.activated`; fallback fails -> session closes.
- Session-key generation is deterministic given agentId and uuid, and voice
  sessions appear in `sessions.list`.
- Cap enforcement: wall-clock, turn count, pre-`session.ready` audio buffer.

Integration tests (TS):

- Fake iOS WS + fake Azure WS: pipe a full turn (audio in, transcript out,
  tool call dispatched to a fake tool, tool output returned, audio out).
- Ticket TTL: expired ticket is rejected and iOS reconnect succeeds after
  RPC refresh.

iOS tests:

- `GatewayRealtimeTransport` protocol adapter: maps gateway events to the
  existing `OpenAIRealtimeVoiceSessionEvent` enum.
- Ticket parsing and reconnect-with-refresh.

## Open questions (need explicit answers before implementation)

- **Memory snapshot source of truth.** Should we use `memory-core`'s active
  summary only, or also splice in `active-memory` working state? The design
  above proposes summary-only for a tighter size budget, but the brief
  mentions both.
- **Voice-mode tool deny list.** Do approval-required tools get silently
  disabled, routed to a companion text channel for approval, or errored with
  a "please approve in chat" response? Above defaults to silently disabled
  with a `session.ready.disabledTools` hint; this is the safest default for
  v1 but may feel broken.
- **Session cap defaults.** 15 min wall-clock, 50 turns, $5/day per-agent
  budget. All three are placeholders; confirm or override before landing the
  schema commit.
- **Companion text session.** When a voice session is active, should the iOS
  chat pane show the voice turns in real time (same session key), or keep
  voice sessions private and stitched into history only at close? The
  session-key plan assumes the former.
- **Direct-to-Azure flag.** After the bridge ships, do we remove the direct
  Tier 2 transport entirely, or keep it behind a hidden debug flag for
  troubleshooting? Above keeps it behind a debug flag for the first release,
  then removes it one release later.

## Landing order

Each step should land as a single commit and pass scoped tests before the
next commit starts.

1. This design note.
2. Gateway WS bridge skeleton: `talk.realtime.start` RPC, `/talk/realtime`
   handler, ticket issuance, audio format parameter on the existing OpenAI
   realtime provider, session caps, closed-code set. No tool dispatch yet;
   the bridge forwards audio and transcripts only.
3. Tool registry marshalling + system prompt + memory snapshot injection on
   `session.update`. Pure composition, deterministic ordering, size budgets
   enforced.
4. Tool call dispatch through the agent tool registry with parallel-call
   tracking and error classification.
5. iOS `GatewayRealtimeTransport` adapter + unit tests.
6. iOS runtime switch: feature-flag gated transport swap in
   `TalkRealtimeSessionRuntime`. Keeps the direct transport behind a debug
   flag.
7. Simulator smoke log + real-device verification plan update.
8. TestFlight submission.
