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

- Session key: voice turns write into the agent's normal chat session (the
  same `session.mainKey` text chat writes to) so `sessions.list` and
  `sessions.history` show voice and text interleaved. The realtime WS uses a
  separate ephemeral id (`voiceRunId`) for its own lifecycle tracking, but
  that id is not a session key.
- Persistence: turn transcripts land on the standard session sink so the
  session looks like a chat session. Audio frames are never persisted.
- Lifecycle caps: none enforced in v1. Ship without wall-clock / turn /
  buffer caps; revisit if abuse shows up.
- Multi-device: exactly one active voice run per agent at a time; a second
  `talk.realtime.start` closes the prior run with code 4010.

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
  "voiceRunId": "9b7c…",
  "sessionKey": "agent:main:main",
  "ticket": "<short-lived random token, 60s TTL>",
  "wsPath": "/talk/realtime",
  "expiresAtMs": 1700000120000,
  "audio": {
    "sampleRateHz": 24000,
    "format": "pcm16",
    "channels": 1
  }
}
```

The `sessionKey` uses the agent's configured `session.mainKey`; when unset,
it falls back to `"main"` (the `DEFAULT_MAIN_KEY` constant in
`src/routing/session-key.ts`), producing the shape `agent:<agentId>:main`.

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

| event                                                 | payload                             |
| ----------------------------------------------------- | ----------------------------------- |
| `session.ready`                                       | `{ voiceRunId, sessionKey, audio }` |
| `response.audio.delta`                                | `{ audio: base64 pcm16 }`           |
| `response.audio.done`                                 | `{ itemId }`                        |
| `conversation.item.input_audio_transcription.partial` | `{ text }`                          |
| `conversation.item.input_audio_transcription.final`   | `{ text }`                          |
| `response.output_text.delta`                          | `{ text }`                          |
| `response.output_text.done`                           | `{ text }`                          |
| `response.tool_call.started`                          | `{ callId, name }`                  |
| `response.tool_call.finished`                         | `{ callId, name, durationMs, ok }`  |
| `fallback.activated`                                  | `{ from, to, reason }`              |
| `error`                                               | `{ code, message, recoverable }`    |
| `closed`                                              | `{ reason, code }`                  |
| `ping`                                                | `{ ts }`                            |

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

A memory snapshot is injected once, as a single `conversation.item.create`
before the first `response.create`, at session start only. It is never
re-injected on subsequent turns.

Sources:

- `memory-core` active summary (most recent agent-chosen summary).
- `lossless-claw` conversation-history compression output for the matching
  agent's default text session (recent-history compression, not full rewind).

Explicitly excluded: `active-memory`. Its per-turn cost on this user's
workload is 20-30 s and it returns empty summaries; spending that latency
once at session start produces no useful signal for voice.

Size budget: 4 KB for the memory summary + 8 KB for compressed history,
measured by character count not tokens. If budgets are exceeded, compressed
history is trimmed oldest-first.

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

Auth: the voice session inherits the same `senderIsOwner` and ambient scope
the agent already exposes. Tools that require an interactive approval prompt
are disabled in voice mode (they have no UI to display the prompt). The
bridge does NOT surface a deny list to the client; instead, when the
realtime model tries to call a disabled tool, the gateway returns a
function-call output of the shape:

```json
{
  "error": "approval_required",
  "message": "For that I'd need to run <toolName>. Easiest to switch to chat and I'll do it there.",
  "spokenHint": true
}
```

The `spokenHint: true` marker tells the realtime model to paraphrase the
`message` field in the next spoken turn rather than invent its own wording.
This is the v1 UX: a verbal nudge instead of companion-channel approval
plumbing.

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

No caps in v1. Ship without wall-clock / turn / buffered-audio limits and
without per-agent daily budgets. Revisit if abuse shows up.

Rate limit: one active voice run per agent. A second `talk.realtime.start`
closes the prior run with code 4010. This is for correctness (two realtime
WSs writing to the same chat session would interleave turns), not abuse
prevention.

## Config surface

Config surface (additions to `talk.providers[openai].*`):

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
      },
    },
  },
}
```

`realtimeBridge` is `false` by default; when true, `talk.realtime.start`
returns a valid ticket and iOS uses the gateway transport. When false, iOS
falls back to the existing Tier 1 discrete path.

The direct-to-Azure Tier 2 path is DELETED once the bridge lands in
TestFlight (see "Tier 2 retirement" below); it is not kept behind a debug
flag.

Removed keys (previously shipped on the Tier 2 branch, replaced by this
surface): `enableRealtime`, `realtimeModel` (Tier 2 semantics),
`realtimeModelFallbacks`, `realtimeInstructions`. The retirement commit
drops them from the gateway config with a `legacy.migrations` entry so
existing configs continue to load.

Schema drift: adding `realtimeBridge`, `realtimeModel`,
`realtimeModelFallback`, and `realtimeApiVersion` to the config schema /
help surfaces requires regenerating the config docs drift hash
(`pnpm config:docs:gen`) in the same commit that adds the fields.

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

## Decisions (resolved)

- **Memory snapshot source.** `memory-core` summary + `lossless-claw`
  compressed history, at session start only. `active-memory` is excluded
  (20-30 s per-turn cost with empty output on this user's workload).
- **Approval-required tools.** Silent-disable with a verbal nudge routed
  through the spoken reply. No companion-channel approval plumbing in v1.
- **Session caps.** None in v1. Ship without wall-clock / turn / budget
  enforcement.
- **Companion text session.** Voice turns write into the normal chat session
  history; `sessions.list` and `sessions.history` surface them uniformly.
  There is no separate "voice session" key; the realtime WS uses an
  ephemeral `voiceRunId` for its own lifecycle only.
- **Tier 2 direct-to-Azure path.** Deleted after the bridge lands in
  TestFlight. Reusable iOS pieces (audio resampler, `.voiceChat` session
  config, PCM player, reconnect policy tests, `TalkSettingsDisplay`, splice
  tests, runtime facade) are cherry-picked onto this branch before the Tier
  2 transport is dropped. Direct-WSS transport, `VoiceProviderEndpoints
.build(capability: .realtime)`, Azure URL/header XCTests, iOS-side
  fallback ordering, and the `enableRealtime` / `realtimeModel` /
  `realtimeModelFallbacks` / `realtimeInstructions` gateway config keys are
  all removed.

## Tier 2 retirement

After the gateway bridge lands in TestFlight (commit 8), the Tier 2
direct-to-Azure transport is removed in a follow-up commit on this branch:

1. Delete `OpenAIRealtimeVoiceSession` (direct WSS transport), its Azure URL
   builder in `VoiceProviderEndpoints`, and the direct-WSS Azure
   URL/header XCTests.
2. Drop iOS-side realtime fallback ordering (gateway owns provider choice).
3. Remove gateway config keys `enableRealtime`, `realtimeModel` (Tier 2
   semantics), `realtimeModelFallbacks`, `realtimeInstructions`. Add a
   `legacy.migrations` entry so existing configs continue to load and
   `openclaw doctor --fix` repairs stale config files.
4. Regenerate config docs drift hash.

The cherry-picked pieces from the Tier 2 branch are retained:
`RealtimeAudioResampler`, `PCMStreamingAudioPlayer`, `TalkModeManager`'s
AVAudioSession `.voiceChat` + AEC setup, `TalkRealtimeSessionRuntime`
(retargeted at the new transport), barge-in wiring (mapped to the new
cancel event), `RealtimeReconnectPolicyTests`, `RealtimeAudioResamplerTests`,
`TalkSettingsDisplay`, and the splice tests in `TalkModeRealtimeSpliceTests`.

## Landing order

Each step should land as a single commit and pass scoped tests before the
next commit starts.

1. This design note.
2. Gateway WS bridge skeleton: `talk.realtime.start` RPC, `/talk/realtime`
   handler, ticket issuance, pcm16 audio format parameter on the existing
   OpenAI realtime provider, closed-code set, duplicate-run eviction. No
   tool dispatch and no memory injection yet; the bridge forwards audio and
   transcripts only.
3. Tool registry marshalling + system prompt composition + memory snapshot
   injection (`memory-core` + `lossless-claw`) on `session.update`.
   Deterministic ordering, size budgets enforced.
4. Tool call dispatch through the agent tool registry with parallel-call
   tracking, approval-required verbal-nudge response, and error
   classification.
5. iOS `GatewayRealtimeTransport` adapter + unit tests.
6. iOS runtime switch: `TalkRealtimeSessionRuntime` re-targeted at the
   gateway transport. Direct-to-Azure transport still present; feature flag
   selects between them for bisecting during the cut.
7. Simulator smoke log + real-device verification plan update.
8. TestFlight submission.
9. (Post-TestFlight) Tier 2 retirement commit per "Tier 2 retirement"
   section.
