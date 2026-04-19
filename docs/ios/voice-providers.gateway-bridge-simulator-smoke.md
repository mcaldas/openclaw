# iOS voice: gateway-bridge simulator smoke log

Branch: `feat/ios-voice-gateway-realtime-bridge`.
Scope: commits 6, 7, 9, 10 ship the iOS gateway realtime transport,
`TalkRealtimeSessionRuntime`, schema config keys, and the
`TalkModeManager` splice. This file records what is verified pre-
TestFlight and what still requires real-device TestFlight to prove
end-to-end.

## What is verified today

### Gateway TypeScript (pnpm)

All gateway surfaces around the realtime bridge:

```bash
pnpm test \
  src/gateway/talk-realtime \
  src/agents/list-channel-tools.test.ts \
  extensions/openai/realtime-voice-provider.test.ts \
  src/gateway/server-methods/talk.test.ts \
  src/config/config.talk-validation.test.ts \
  src/config/zod-schema.talk.test.ts
```

At commit 10 land (`065be6f0d3`): **84 passing tests** across 12 files
covering protocol encoding, ticket registry, voice-run registry,
session lifecycle, tool marshalling, tool dispatch, fallback and
close-code mapping, system-prompt composition, memory snapshot tail,
the `talk.realtime.start` RPC, and the new `realtimeBridge` schema
config key.

Drift + cycle gates green:

```bash
pnpm check:base-config-schema    # OK
pnpm config:docs:check           # OK
pnpm plugin-sdk:api:check        # OK
pnpm check:import-cycles         # 0 cycles
pnpm check:madge-import-cycles   # 0 cycles
```

### OpenClawKit Swift (swift test)

Realtime transport + reconnect policy + audio resampler + runtime
streaming:

```bash
cd apps/shared/OpenClawKit && \
  swift test --filter "GatewayRealtime|RealtimeReconnect|RealtimeAudio|TalkRealtime"
```

At commit 10 land: **36 passing tests** across 6 suites, ~30 ms total.

### iOS app (xcodebuild, iPhone 17 simulator)

Full iOS app build + the new splice test suite:

```bash
cd apps/ios && xcodegen generate
xcodebuild -project OpenClaw.xcodeproj -scheme OpenClaw \
  -destination 'platform=iOS Simulator,id=<iPhone 17 UDID>' \
  -only-testing:OpenClawTests/TalkModeRealtimeSpliceTests test
```

At commit 10 land (iPhone 17 simulator, UDID `08DA429B-8B39-4649-8F6C-80179D3E04E8`):

- Full app BUILD SUCCEEDED (Debug iphonesimulator, arm64).
- `TalkModeRealtimeSpliceTests`: **6 passing** across 1 suite, 0.09 s total:
  - `micTapFrameRoundTripsAsBase64InputAudioBufferAppend` — PCM16 frames
    from the mic-tap pathway serialize to `input_audio_buffer.append`
    with exact base64 round-trip.
  - `assistantAudioChunkRoutesToPCMPlayerBus` — realtime `onAssistantAudioChunk`
    delegates into the shared `PCMStreamingAudioPlayer` bus; feeder
    stays alive across multiple chunks; `isSpeaking` flips to `true`.
  - `startIsIdempotentWhenReEnteringTalkMode` — start → teardown →
    start dials cleanly without orphaned state.
  - `disabledRealtimeLeavesTier1FlagOff` — regression guard: when
    `realtimeBridge` is false (default), the splice never runs and
    Tier 1 owns the loop.
  - `enabledFlagPropagatesFromParsedConfig` — the
    `TalkModeGatewayConfigParser` lifts `talk.providers.<id>.realtimeBridge`
    from the `talk.config` payload into `realtimeBridgeEnabled` on the
    parsed state.
  - `bargeInCancelsInFlightResponseOverWS` — VAD-driven barge-in emits
    a `response.cancel` frame on the WS.
- Broader test suite run: 165 passing out of 168 ran. The 3 failures
  (`NodeAppModelInvokeTests.handleInvokeCanvasCommandsUpdateScreen`,
  `ShareToAgentDeepLinkTests.buildURLReturnsNilWhenPayloadEmpty` x2)
  are **pre-existing on `origin/main`**; they do not touch realtime
  voice code and are not caused by commits 9 or 10. Triage outside
  this branch.

## What a live simulator smoke exercises (pending VM deploy)

The automated splice tests above exercise every iOS-side code path
against a scripted WebSocket stub. A live simulator smoke additionally
validates the iOS app <-> VM-hosted gateway round-trip. That requires
the VM deployment runbook (commit 12) to complete first.

### Pre-flight

1. VM `az-openclaw-public` is running this branch's build, not
   `openclaw@latest`. See commit 12 runbook for the exact rsync +
   `npm link` + `systemctl --user restart openclaw-gateway` sequence.
2. `openclaw channels status --probe` on the VM is green.
3. On the VM: `openclaw config set talk.providers.openai.realtimeBridge true`
   and `talk.providers.openai.realtimeModel gpt-realtime-1-5` and
   `talk.providers.openai.realtimeApiVersion 2025-04-01-preview`.
4. iOS simulator has this branch's app installed (`xcodebuild build`
   against `iPhone 17` generic simulator, then install via
   `xcrun simctl install booted <.app>`).
5. Pair the simulator to the VM via the setup-code flow
   (`openclaw devices pair` on VM, scan in iOS app).

### Simulator check-list

| step                                                                                         | expected observation                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open app, tap the Voice tab, enable Talk Mode                                                | Orb goes from `Offline` -> `Listening`. Gateway WS connected (status pill green). Diagnostic log shows `talk realtime-bridge: session started` (NOT Tier 1 "listening").                  |
| First frame round-trip                                                                       | `talk realtime-bridge: session.ready voiceRunId=<uuid> sessionKey=agent:main:main` in the gateway log within ~300 ms.                                                                     |
| Speak "what day is today?"                                                                   | Partial + final user transcript events surface within ~200 ms of speech end. AEC prevents the assistant's own TTS from re-triggering the VAD (voiceChat mode + `AUVoiceProcessingIO`).    |
| First audio delta                                                                            | First `assistantAudioDelta` arrives in <2000 ms measured from final user transcript.                                                                                                      |
| Follow-up: "read the top-level README"                                                       | `toolCallStarted("read")` -> gateway executes `read` against workspaceDir -> `toolCallFinished("read", ok: true)` -> assistant speaks the first few lines.                                |
| Voice-disabled tool attempt: "run the tests"                                                 | `toolCallStarted("exec")` -> gateway returns the spoken-hint `function_call_output` -> assistant speaks: "For that I'd need to run exec. Easiest to switch to chat and I'll do it there." |
| Barge-in: speak over the assistant mid-reply                                                 | `response.cancel` frame sent; assistant audio stops within ~150 ms; `.isSpeaking` flips to `false`.                                                                                       |
| Background the app for 10 s, foreground                                                      | Runtime tears down on background. On foreground, `resumeAfterBackground()` re-dials; new `voiceRunId`. Gateway evicts the prior run with `replaced_by_newer` (4010).                      |
| Gateway-side session history                                                                 | `openclaw sessions history agent:main:main` shows voice turns interleaved with any prior text turns, matching the design-doc contract (voice + text share one session key).               |
| Flip flag: `openclaw config set talk.providers.openai.realtimeBridge false` then reopen Talk | On next Talk Mode entry, the splice branch is skipped; Tier 1 STT + TTS path owns the loop. No `realtime-bridge` logs in the gateway; no mic-tap installation failures.                   |

### Pass criteria

- Every checked row lands without manual intervention.
- First-audio latency is <2000 ms measured from final user transcript
  event to first `assistantAudioDelta`.
- No regressions in the Tier 1 path when `realtimeBridge` is flipped
  off.
- `logger.info` and `GatewayDiagnostics.log` output for
  `talk realtime-bridge: session started`, `session.ready`,
  `tool.started`, `tool.finished`, `closed` each appear at least
  once during the run.

## What the simulator still does not prove

Even a successful simulator run does NOT prove:

1. Real-device microphone routing and AEC behavior. `AVAudioSession
.voiceChat` activates `AUVoiceProcessingIO` on device; simulator
   input is cleaner and sidesteps the echo loop the voice-chat mode
   exists to fix. Barge-in quality is a real-device question.
2. Tailscale funnel stability under mobile-network switching. The
   simulator uses the Mac's network; LTE is a different latency
   profile.
3. Battery / thermal impact on sustained realtime sessions.
4. BLE / wired-headset route-change behavior mid-session.

Items 1-4 are what the real-device TestFlight (commit 13) validates.

## Runtime integration status (post commit 10)

- `TalkModeManager.start()` now branches on `realtimeBridgeEnabled`:
  when true and the gateway is reachable, it installs the realtime
  mic tap, dials `/talk/realtime` via the gateway, and routes assistant
  audio into the `PCMStreamingAudioPlayer` bus. On unrecoverable
  error, `realtimeDegraded` flips and the same `start()` falls through
  to the Tier 1 path.
- `stop()` and `suspendForBackground()` both tear the realtime
  session down so no stale WS survives the transition.
- The runtime's `Delegate` is wired in `makeRealtimeDelegate()`:
  transcripts update `lastTranscript`, assistant text deltas extend
  `lastSpokenText`, assistant audio chunks flow through the feeder,
  tool-call events are logged and diagnostics'd, fallback events are
  logged, unrecoverable errors trigger degrade + re-entry into Tier 1.
- Default behavior: the flag is **off** by default
  (`talk.providers.*.realtimeBridge` defaults to false in the zod
  schema), so every shipped user keeps Tier 1 unchanged until the
  gateway operator explicitly flips it.

## References

- Gateway design note: `docs/voice/gateway-realtime-bridge.md`.
- Gateway protocol (TypeScript): `src/gateway/talk-realtime/protocol.ts`.
- iOS transport (Swift): `apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayRealtimeTransport.swift`.
- iOS runtime (Swift): `apps/ios/Sources/Voice/TalkRealtimeSessionRuntime.swift`.
- iOS splice + tests: `apps/ios/Sources/Voice/TalkModeManager.swift` (realtime-bridge block) + `apps/ios/Tests/TalkModeRealtimeSpliceTests.swift`.
- Schema config keys: `src/config/zod-schema.ts` (`TalkProviderEntrySchema`), `src/config/schema.labels.ts`, `src/config/schema.help.ts`.
