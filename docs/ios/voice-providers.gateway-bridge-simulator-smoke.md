# iOS voice: gateway-bridge simulator smoke log

Branch: `feat/ios-voice-gateway-realtime-bridge`.
Scope: commits 6 and 7 ship the iOS gateway realtime transport +
`TalkRealtimeSessionRuntime`. This file records what was verified before
commit 9 (TestFlight) and what still requires the VM-deployed bridge

- real device to prove end-to-end.

## What is verified today (pre-simulator)

All commit 6/7 iOS surfaces are covered by `swift test`:

- `GatewayRealtimeCodecTests` (9 cases) — client-event encoding,
  server-event decoding, lossless round-trip, malformed-input handling,
  close-code pinning against `src/gateway/talk-realtime/protocol.ts`.
- `GatewayRealtimeCloseCodeTests` (5 cases) — reconnect decision matrix,
  4xxx range invariant, raw-value pinning.
- `GatewayRealtimeTicketIssuerTests` (3 cases) — ticket RPC response
  decoding, empty-params omission, malformed-response error path.
- `RealtimeReconnectPolicyTests` (6 cases) — default schedule matches
  the design-note spec, clamping, budget.
- `RealtimeAudioResamplerTests` (7 cases) — int16 clipping, little-
  endian byte order, frame buffering, 48 kHz -> 24 kHz decimation,
  flush zero-padding, reset.
- `TalkRealtimeTransportStreamingTests` (4 cases) — `sessionReady`
  emission, audio+transcript forwarding, tool-call frame surfacing,
  malformed-frame error surfacing.

Run command:

```bash
cd apps/shared/OpenClawKit && \
  swift test --filter "GatewayRealtime|RealtimeReconnect|RealtimeAudio|TalkRealtime"
```

Result at commit 7 land (`ea0a05f457`): 34 passing tests across 6
suites, total runtime ~30 ms.

Run command for the gateway side:

```bash
pnpm test src/gateway/talk-realtime \
  src/agents/list-channel-tools.test.ts \
  extensions/openai/realtime-voice-provider.test.ts \
  src/gateway/server-methods/talk.test.ts
```

Result at commit 7 land: 85 passing tests (67 talk-realtime + 5
list-channel-tools + 6 realtime-voice-provider + 5 talk RPC + 2
extension hookups).

## What the simulator path confirms (commit 8 itself)

When this smoke log is extended with a live simulator run, the
procedure is:

### Pre-flight

1. VM is running a build of this branch, not `openclaw@latest` from
   npm. (See "VM deployment proposal" in the commit 7/8 report.)
2. `openclaw channels status --probe` on the VM is green.
3. `openclaw config get talk` shows `realtimeBridge: true` and an
   `openai` realtime provider configured with the Azure keys.
4. iOS simulator has this branch's app installed (via
   `xcodegen generate && xcodebuild ...`) and the gateway connection
   is configured to point at the VM via Tailscale funnel.

### Simulator check-list

| step                                                                                                       | expected observation                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open app, tap the talk tab                                                                                 | Orb goes from `Offline` -> `Ready`. Gateway WS is connected (status pill green).                                                                                                                                                                              |
| Call `talk.realtime.start` via an in-app debug button (added alongside the runtime wiring post-TestFlight) | RPC returns within ~100 ms with a `GatewayRealtimeTicket`. `voiceRunId` is a UUID; `sessionKey` is `agent:main:main` (or the configured main key).                                                                                                            |
| Runtime opens `/talk/realtime?ticket=...`                                                                  | `session.ready` event received in the runtime consumer task. `onSessionReady` delegate fires; UI shows "Connected via bridge".                                                                                                                                |
| Speak into the simulator mic ("what day is today?")                                                        | `userTranscriptPartial` -> `userTranscriptFinal` surfaces within ~200 ms of speech end. Simulator mic routes through `AVAudioEngine` at its native rate; `RealtimeAudioResampler` decimates to 24 kHz pcm16.                                                  |
| First audio delta                                                                                          | First `assistantAudioDelta` event arrives in <2000 ms measured from the end of user speech. (User bar: "<2 s to first audio".)                                                                                                                                |
| Assistant finishes speaking                                                                                | `assistantAudioDone` then `assistantTextDone` events. Full assistant text appears in the chat pane under the same `sessionKey`.                                                                                                                               |
| Send a follow-up that would call a tool ("read ~/README.md")                                               | `toolCallStarted("read")` event arrives. Within 100-500 ms, `toolCallFinished("read", ok: true)`. Assistant speaks the result.                                                                                                                                |
| Try a voice-disabled tool ("run the tests")                                                                | `toolCallStarted("exec")` fires, then `toolCallFinished("exec", ok: true)` — `ok: true` because the spoken hint is a deterministic response, not an error. Assistant speaks: "For that I'd need to run exec. Easiest to switch to chat and I'll do it there." |
| Kill the app mid-turn (simulate `app_background` / simulator home)                                         | Runtime sends `session.end("app_background")`. Gateway closes the WS with 4020. `onClosed("session_ended", 4020)` fires.                                                                                                                                      |
| Start a second voice run from a separate simulator instance against the same agent                         | First run receives `closed("replaced_by_newer", 4010)`. `onClosed(_, 4010)` fires.                                                                                                                                                                            |

### Pass criteria

- Every checked row lands without manual intervention.
- First-audio latency is <2000 ms measured from final partial-
  transcript event to first `assistantAudioDelta`.
- Gateway session history (`openclaw sessions history agent:main:main`
  on the VM) shows the voice turns interleaved with any prior text
  turns, matching the design-note contract (voice and text share one
  session key).

## What this does not prove

The simulator path does NOT prove:

1. Real-device microphone routing and AEC behavior. `AVAudioSession
.voiceChat` mode behaves differently on device vs. simulator; echo
   cancellation is device-only.
2. Tailscale funnel stability under mobile-network switching. The
   simulator uses the Mac's network; a real device on LTE is a
   different latency profile.
3. Battery / thermal impact on sustained realtime sessions.
4. Barge-in quality (cutting the assistant off mid-speech). The
   simulator mic path is clean; on device the assistant's own audio
   picks up into the mic and VAD behavior changes.

Items 1-4 are what the real-device TestFlight (commit 9) validates.

## Runtime integration status

Commit 7 ships the `TalkRealtimeSessionRuntime` standalone but does
NOT yet wire it into `TalkModeManager`'s 2200-LOC state machine. The
simulator smoke above assumes an in-app debug button that instantiates
the runtime directly. `TalkModeManager` integration is intentionally
deferred to a post-TestFlight follow-up because:

- A broken mic-tap splice is invisible without a real-device round-
  trip; wiring the runtime into the manager without first proving the
  gateway bridge works end-to-end risks a regression in Tier 1 that
  would be hard to bisect.
- The manager's current Tier 1 STT + TTS flow remains the default for
  shipped users until the bridge is proven on TestFlight.
- The runtime's public `Delegate` surface is already the contract the
  manager will consume, so the integration commit is additive.

## References

- Gateway design note: `docs/voice/gateway-realtime-bridge.md`.
- Gateway protocol (TypeScript): `src/gateway/talk-realtime/protocol.ts`.
- iOS transport (Swift): `apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayRealtimeTransport.swift`.
- iOS runtime (Swift): `apps/ios/Sources/Voice/TalkRealtimeSessionRuntime.swift`.
