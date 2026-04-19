# talk-realtime module guide

Gateway-owned WS bridge between iOS and the Azure/OpenAI realtime API.
See `docs/voice/gateway-realtime-bridge.md` for the end-to-end design.

## Boundary

- Host-only surface. Not exported through `src/plugin-sdk/**`. Extensions
  plug into this flow only through the existing realtime-voice provider
  plugin contract (`src/realtime-voice/provider-types.ts`).
- `session.ts` speaks only to a generic `RealtimeVoiceBridge`. If you need
  provider-specific behavior, add it to the provider plugin or to the
  `TalkRealtimeBridgeFactory` the caller injects — not to this module.
- The bridge factory is intentionally generic: commit 2 wires the raw
  audio + transcript pipeline with an empty instructions string; commits
  3 and 4 add agent-aware system prompt composition, tool marshalling,
  and tool-call dispatch by expanding the factory caller, not by reaching
  into core agent internals from inside this module.

## Correctness invariants

- One active run per agent. `VoiceRunRegistry.register` evicts any prior
  run with `replaced_by_newer` before storing the new handle. Keep that
  behavior: two concurrent WSs would interleave transcript writes into
  the same chat session.
- Tickets are single-use. `TalkRealtimeTicketRegistry.redeem` deletes
  the entry on success, on expiry, and on wrong-operator rejection; a
  retry cannot pass a second redemption.
- Tickets are bound to the operator connect id. The upgrade host
  redeems with the connect id observed on the handshake, not with a
  value from the request URL.
- Client frames are bounded. `decodeClientFrame` rejects non-string
  input and frames above 2 MB. Do not bypass this cap.

## Prompt cache stability

- `session.update` is sent by the provider bridge, not this module. The
  factory composes `instructions` + `tools` once at bridge-build time;
  tool ordering is preserved verbatim from the agent registry and the
  voice preamble is a constant string, so turn-to-turn the prefix is
  byte-identical.
- `session-prompt.ts` appends the voice preamble at the TAIL of the
  composed system prompt. Adding voice-specific content anywhere other
  than the tail would invalidate the cached text-chat prefix.
- `tool-marshalling.ts` is a pure transform. Do not introduce sorts,
  set iteration, or map iteration that depend on insertion order of
  non-deterministic sources (plugin load timing, filesystem reads).

## Voice tool filter

- `listAgentToolsForChannel(agentId, "voice", ...)` in
  `src/agents/list-channel-tools.ts` is the only seam that decides which
  tools voice sees. It silent-disables approval-sensitive tools
  (`exec`, `process`, `write`, `edit`, `apply_patch`) because the
  realtime model has no approval UI; the v1 UX is a spoken nudge
  routed through `buildVoiceToolDisabledHint` when the model tries to
  call a disabled tool. The dispatch wiring for that nudge lands with
  the tool-execution loop.
- Do not extend this filter with ad-hoc voice-mode flags scattered
  around the bridge. If a new class of tools needs a voice-specific
  policy, extend the disabled set in `list-channel-tools.ts` and the
  nudge in `buildVoiceToolDisabledHint`.

## Memory snapshot

- `loadVoiceMemorySnapshot` reads the tail of the matching agent's
  normal text chat transcript and injects it as
  `conversation.item.create` entries. This picks up `lossless-claw`
  compression naturally when active (the compression rewrites the
  transcript in place).
- Direct `memory-core` summary injection is intentionally deferred.
  See `docs/voice/gateway-realtime-bridge.md` -> "A memory snapshot is
  injected" for the rationale. Do not add a second memory source
  without also deciding how it composes with the transcript tail.
- `active-memory` is explicitly excluded for voice; its per-turn cost
  is 20-30 s on this user's workload with empty output, and spending
  that latency at session start produces no useful signal for voice.
