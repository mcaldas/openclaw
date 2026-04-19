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

- `session.update` is sent by the provider bridge, not this module. When
  commit 3 adds `instructions` + `tools`, keep the tool ordering
  deterministic and the instructions bytes stable across turns — see
  the prompt-cache rule in the root `CLAUDE.md`.
