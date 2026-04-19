# Tier 1 voice provider smoke log

Records the Tier 1 end-to-end exercise of the generic OpenAI / Azure-OpenAI
voice provider layer against the live `headstart-ai` Azure OpenAI resource.

This is an **off-device** smoke: the iPhone was locked during this run, so the
exercise runs against real Azure from the host (macOS), using the same Swift
code paths (`OpenAICompatibleTTSClient`, `OpenAICompatibleTranscriptionClient`,
`VoiceProviderEndpoints`) the iOS app links via `OpenClawKit`. A device-level
PTT walkthrough will be appended here once the phone is unlocked.

## Gateway state at the time of the run

```
on az-openclaw-public:
  backup: /home/openclaw/.openclaw/openclaw.json.bak.1776563612
  talk.provider: azure-openai
  talk.providers["azure-openai"]:
    apiKey: <redacted>
    azureEndpoint: https://headstart-ai.openai.azure.com
    azureApiVersion: 2025-04-01-preview     # bumped from 2024-10-21 (see "Finding" below)
    modelId: tts                            # Azure deployment name
    voiceId: alloy
    outputFormat: pcm
    transcribeModel: gpt-4o-transcribe
  systemctl --user is-active openclaw-gateway : active
  ss -ltn | grep 18789: loopback listener up
  sudo tailscale funnel status: https://vm-openclaw.tailad0daf.ts.net proxying 18789
```

The `openai` block (pointing at the `mathi-mbii7dj3` preview endpoint) was
preserved unchanged; only the active `talk.provider` switched and the new
`azure-openai` block was added.

## What the iOS code actually sees

Resolved `talk.config` payload served to iOS (`apps/ios/Sources/Voice/TalkModeManager.swift`
`reloadConfig()` → `TalkModeGatewayConfigParser.parse` → `TalkProviderSurfaceParser.parse`):

```
TalkProviderSurface {
  kind: .azureOpenai,
  apiKey: <redacted>,
  azureEndpoint: "https://headstart-ai.openai.azure.com",
  azureApiVersion: "2025-04-01-preview",
  model: "tts",
  voice: "alloy",
  responseFormat: "pcm",
  transcribeModel: "gpt-4o-transcribe"
}
```

`makeOpenAITTSConfig()` produces `TTSCapabilityConfig(kind: .azureOpenai, ...)`
with `.pcm` response format. `TalkModeManager.playAssistant` routes this via
`TalkOpenAICompatibleTTSRuntime` → `OpenAICompatibleTTSClient` →
`VoiceProviderEndpoints.build(kind: .azureOpenai, capability: .tts, ...)`,
emitting:

```
POST https://headstart-ai.openai.azure.com/openai/deployments/tts/audio/speech?api-version=2025-04-01-preview
headers:
  api-key: <redacted>
  Content-Type: application/json
body:
  {"input": "...", "model": "tts", "response_format": "pcm", "voice": "alloy"}
```

## Live run

Harness: `apps/shared/OpenClawKit/Tests/OpenClawKitTests/OpenAICompatibleLiveAzureTests.swift`
(env-gated, no-ops when `OPENCLAW_LIVE_AZURE` is unset).

```
$ set -a; source .agent-env; set +a
$ export OPENCLAW_LIVE_AZURE=1
$ export OPENCLAW_AZURE_API_VERSION_TTS=2025-04-01-preview     # see Finding below
$ cd apps/shared/OpenClawKit
$ swift test --filter OpenAICompatibleLiveAzureTests

◇ Test azureTTSProducesAudioAndTranscribeRoundTripsText() started.
[tier1-live] tts bytes=60960
[tier1-live] stt text="Tier 1 smoke test. The time is now ten past five."
✔ Test azureTTSProducesAudioAndTranscribeRoundTripsText() passed after 2.749 seconds.
✔ Suite OpenAICompatibleLiveAzureTests passed after 2.749 seconds.
✔ Test run with 1 test in 1 suite passed after 2.749 seconds.
```

Input text: `"Tier one smoke test. The time is now ten past five."` (ASCII, "one"
spelled out).
Round-trip transcription: `"Tier 1 smoke test. The time is now ten past five."`
— single casing/numeral difference (`one` → `1`) which the test's loose anchor-
word assertion tolerates.

### Audibility check

Output audio written to `/tmp/tier1-live-tts.mp3` (`MPEG ADTS layer III, 160
kbps, 24 kHz, mono, 60960 bytes`) and played via `afplay` on the Mac — audible,
intelligible speech matching the input.

PCM path (`response_format=pcm`) also validated independently via `curl`:
output is raw 24 kHz signed-16-bit little-endian mono PCM (70200 bytes for the
same phrase), which is exactly what `PCMStreamingAudioPlayer.play(stream:,
sampleRate: 24_000)` expects, so no iOS-side playback change is needed.

## Finding: Azure TTS requires a preview api-version

Initial gateway config had `azureApiVersion: 2024-10-21`, which is the GA
version. Azure's `/openai/deployments/{dep}/audio/speech` endpoint returns
`404 Resource not found` under `2024-10-21` but serves 200 under every preview
version from `2024-05-01-preview` through `2025-04-01-preview`. Transcriptions
work under both. Bumped the gateway `azureApiVersion` to `2025-04-01-preview`
(matches the realtime api-version used by Tier 2 — single value covers both
capabilities). This is a gateway-side config tweak, not a code change.

Rollback (if needed):

```
ssh az-openclaw-public
cp ~/.openclaw/openclaw.json.bak.1776563612 ~/.openclaw/openclaw.json
systemctl --user restart openclaw-gateway
```

## Not covered by this smoke

- **Simulator / device UI walkthrough.** I built + installed the app target on
  the iPhone 17 Pro simulator, paired-code generation succeeded
  (`openclaw qr --remote --setup-code-only`), but driving the onboarding/
  Talk-Mode UI to actually hit PTT → transcribe → TTS end-to-end would require
  either a user at the keyboard or an XCUITest harness. Punted to a follow-up
  device run once the paired iPhone is unlocked.
- **`AVAudioEngine` tap + `PCMStreamingAudioPlayer` playback on the simulator.**
  The HTTP path is the only Tier 1-new code surface; PCM playback and
  `AVAudioEngine` input taps are unchanged from the ElevenLabs flow (still
  shipping today) and exercised by the existing test suites. Device/sim
  observations will be appended here when the full-loop walkthrough happens.
- **Prompt-cache impact.** N/A for Tier 1 — iOS talks directly to the TTS/STT
  endpoints, not through the model inference loop.

## Sim build notes (for the follow-up device run)

- The `OpenClaw` app target transitively depends on `OpenClawWatchApp`
  / `OpenClawWatchExtension`, and those `watchapp2` / `watchkit2-extension`
  product types are unavailable in the `iphonesimulator26.4` SDK variant
  shipped with the current Xcode. Workaround during this smoke: temporarily
  drop the watch target blocks from `apps/ios/project.yml`, `xcodegen
generate`, build, install, then restore `project.yml` from backup. This is
  a pre-existing Xcode SDK bug, not a repo issue; flagged separately.
- `apps/ios/LocalSigning.xcconfig` (git-ignored) staged for device installs
  with team `TMN59VBFSC` (automatic signing) + bundle prefix
  `ai.openclaw.client.mathias.voice.*`. Simulator installs do not require
  provisioning profiles so it doesn't affect the off-device smoke either way.
