# Tier 2 voice provider smoke log

Records the simulator-level smoke for the Tier 2 bidirectional realtime voice
layer (`OpenAIRealtimeVoiceSession` + `TalkRealtimeSessionRuntime`) against the
`headstart-ai` Azure OpenAI deployments `gpt-realtime-1-5` (primary) and
`gpt-realtime` (auto-fallback).

Like the Tier 1 smoke, a real-device end-to-end PTT walkthrough is deferred
until the paired iPhone is unlocked. The simulator can build + install the app
and exercise all Swift code paths, but `AVAudioEngine` input taps on the
simulator are flaky for live Azure realtime sessions (no mic hardware; the
simulator uses the host's mic with extra latency + simulator-specific audio
routing quirks). Everything below either does not need a mic (unit tests,
dial-up smoke) or is honest about what was and was not covered.

## Gateway state

Unchanged from Tier 1. The realtime config keys are opt-in and read directly
by the iOS client from the resolved `talk.<provider>.config` block:

```
talk.<provider>.realtimeModel: gpt-realtime-1-5@2026-02-23
talk.<provider>.realtimeVoice: alloy
talk.<provider>.realtimeApiVersion: 2025-04-01-preview   # falls back to azureApiVersion
talk.<provider>.enableRealtime: true                     # opt-in; off by default
```

Auto-fallback: when `realtimeModel` matches `gpt-realtime-1-5*`, the iOS client
auto-populates `modelFallbacks: ["gpt-realtime"]` without any gateway change,
so old configs still benefit from the 1.5 -> 1.0 degrade without operator
action. Explicit `realtimeModelFallbacks: [...]` (top-level or nested under
`realtime.modelFallbacks`) overrides the auto-default.

## Code under exercise

- `apps/shared/OpenClawKit/Sources/OpenClawKit/OpenAIRealtimeVoiceSession.swift`
  — actor, fallback + reconnect orchestration, session.update shape.
- `apps/shared/OpenClawKit/Sources/OpenClawKit/RealtimeWebSocket.swift`
  — `URLSessionRealtimeWebSocket` adapter.
- `apps/shared/OpenClawKit/Sources/OpenClawKit/RealtimeReconnectPolicy.swift`
  — exp-backoff schedule (1000/2000/4000/8000/16000 ms, max 5, reset on
  success).
- `apps/shared/OpenClawKit/Sources/OpenClawKit/RealtimeAudioResampler.swift`
  — float -> 24 kHz s16le mono at 40 ms frames.
- `apps/shared/OpenClawKit/Sources/OpenClawKit/VoiceProviderEndpoints.swift`
  — still the only place that branches on provider kind (openai vs
  azure-openai). No duplication elsewhere.
- `apps/shared/OpenClawKit/Sources/OpenClawKit/TalkProviderSurface.swift`
  — `makeRealtimeConfig()` now plumbs `modelFallbacks` + auto-default.
- `apps/ios/Sources/Voice/TalkRealtimeSessionRuntime.swift`
  — thin facade that forwards realtime events to the TalkModeManager.
- `apps/ios/Sources/Voice/TalkModeManager.swift`
  — `isRealtimeEnabled` + `resolveRealtimeCapabilityConfig(directive:)`.

## Unit-test run

Tier 2 lands 26 new XCTest cases under `OpenClawKit/Tests/OpenClawKitTests/`
plus 6 new iOS dispatch tests under `apps/ios/Tests/`.

```
$ cd apps/shared/OpenClawKit
$ swift test --filter 'RealtimeReconnectPolicyTests|RealtimeFallbackModelOrderTests|RealtimeAudioResamplerTests|OpenAIRealtimeVoiceSessionFrameTests'
... 26 tests in 4 suites passed ...

$ cd apps/ios
# Watch targets are unbuildable on the iphonesimulator26.4 SDK shipped today
# (same Xcode issue documented in Tier 1 smoke). Strip them, regen, run
# TalkModeRealtimeDispatchTests, restore project.yml.
$ cp project.yml project.yml.tier2bak
$ python3 -c "..."         # strips OpenClawWatchApp/OpenClawWatchExtension blocks
$ xcodegen generate
$ xcodebuild -project OpenClaw.xcodeproj -scheme OpenClaw -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17,OS=latest' test

◇ Suite TalkModeRealtimeDispatchTests started.
  ✔ realtimeDisabledWhenFlagMissing() passed
  ✔ realtimeEnabledWhenFlagTrueAndProviderMapsOpenAICompatible() passed
  ✔ realtimeDisabledForElevenLabsEvenWhenFlagTrue() passed
  ✔ resolveRealtimeConfigReturnsAttemptOrderWithAutoFallback() passed
  ✔ directiveVoiceOverrideWinsOverProviderDefault() passed
  ✔ blankDirectiveVoiceKeepsProviderDefault() passed
  ✔ resolveReturnsNilWhenRealtimeModelMissing() passed
✔ Suite TalkModeRealtimeDispatchTests passed

$ mv project.yml.tier2bak project.yml
$ xcodegen generate
```

Other iOS failures in the same test run were pre-existing on `main`
(`NodeAppModelInvokeTests.handleInvokeCanvasCommandsUpdateScreen`,
`ShareToAgentDeepLinkTests.buildURLReturnsNilWhenPayloadEmpty`); both are
unrelated to voice/Tier 2 and were visible on the Tier 1 smoke baseline too.

## Simulator build + install

```
$ cd apps/ios
$ xcodebuild -project OpenClaw.xcodeproj -scheme OpenClaw -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17,OS=latest' build
** BUILD SUCCEEDED **
```

The app compiles cleanly on the simulator with Tier 2 in place. The new
source files (`TalkRealtimeSessionRuntime.swift`,
`RealtimeAudioResampler.swift`, `RealtimeWebSocket.swift`,
`RealtimeReconnectPolicy.swift`, `RealtimeVoiceEvent.swift`,
`OpenAIRealtimeVoiceSession.swift`) are picked up by xcodegen's
`- path: Sources` auto-discovery — no manual pbxproj edits were committed
(pbxproj is gitignored and generated).

## What was NOT covered by this smoke

- **Real device live realtime session.** Requires an unlocked iPhone +
  mic-live PTT walkthrough. The session actor + fallback + reconnect logic
  are exercised by XCTest with a scripted WebSocket stub, but no real Azure
  realtime handshake happened from the iPhone in this smoke. Deferred to
  user unlock.
- **Simulator mic -> Azure realtime live loop.** Simulator mic capture works
  well enough for STT (Tier 1 SFSpeechRecognizer path) but has known audio
  routing quirks with `AVAudioEngine.inputNode` + VoIP-style sessions that
  Apple doesn't fully address in the simulator. The `RealtimeAudioResampler`
  math is covered by deterministic XCTest; the input-tap -> resampler ->
  `OpenAIRealtimeVoiceSession.sendAudio` pipeline is not yet wired into
  `TalkModeManager`'s main capture loop. That wire-up is the follow-up once
  on-device smoke is green.
- **UI toggle.** The `enableRealtime` flag is read from the gateway config;
  there is no Talk-mode UI toggle yet. Users enable it via
  `openclaw config set talk.<provider>.enableRealtime true` on the gateway
  host. A UI surface is a follow-up that should land alongside the
  on-device wiring.

## Follow-ups (for the on-device run once phone unlocked)

1. Install the app on the paired iPhone (bundle id
   `ai.openclaw.client.mathias.voice.*`, team `TMN59VBFSC`).
2. On the gateway, flip `talk.<provider>.enableRealtime: true` and bump or
   set `talk.<provider>.realtimeModel: gpt-realtime-1-5@2026-02-23`.
3. Restart the gateway (`systemctl --user restart openclaw-gateway`) and
   verify the resolved `talk.config` payload reaches the device (observe
   `TalkMode` logger: "talk provider '...' uses OpenAI-compatible iOS TTS"
   plus a new "realtime enabled" log once the capture loop is wired).
4. Drive Talk mode: tap PTT, speak a phrase, confirm the realtime session
   opens against `gpt-realtime-1-5`. Kill the primary deployment (capacity
   cap 1 makes this easy: allocate the slot to another client) and observe
   `.fallbackActivated(from: gpt-realtime-1-5, to: gpt-realtime, reason:
serviceUnavailable)` in the logs.
5. Append an on-device log block to this file.

## No prompt-cache concern

Tier 2 iOS <-> Azure realtime traffic is direct (not through the Anthropic
inference loop), so prompt-cache stability is not affected by this work. The
`session.update` payload uses `JSONSerialization.sortedKeys` so repeat bytes
are stable across turns, which is good hygiene even though the realtime
session itself does not cache.
