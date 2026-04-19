# iOS Voice Provider Contracts

This note describes the generic Swift provider layer that lets iOS talk/transcription/TTS
and (later) realtime voice work with multiple OpenAI-shaped back ends behind a single
abstraction. It is the design contract for the files under
`apps/ios/Sources/Voice/` and `apps/shared/OpenClawKit/Sources/OpenClawKit/`.

## Goals

- Unify today's ElevenLabs-only talk path + future OpenAI / Azure-OpenAI paths behind
  one `VoiceProvider` discriminator. Callers should never branch on provider id beyond
  selecting the implementation.
- Azure-specific behavior lives exclusively in endpoint + auth header construction,
  not in business logic.
- Keep ElevenLabs behavior byte-identical for existing users.
- Keep gateway-side (`extensions/openai/*`) changes to a minimum for Tier 1; iOS talks
  directly to the provider edge using credentials the gateway hands out via `talk.config`.
- Future realtime voice (Tier 2) reuses the same endpoint/header layer for WebSocket
  URL construction.

## Non-goals

- No breaking changes to `talk.config` schema. The gateway already serves per-provider
  config under `talk.providers.<id>.*` and resolves it into `talk.resolved.config`. iOS
  must read whatever extra keys Azure needs via that same `catchall(z.unknown())` path.
- No new TS plugin for "azure-openai-speech"; iOS parses the openai/azureOpenai talk
  config the gateway already serves and dispatches to the provider itself.

## Provider discriminator

```swift
public enum VoiceProviderKind: String, Sendable, CaseIterable {
    case elevenlabs
    case openai
    case azureOpenai = "azure-openai"
}
```

`VoiceProviderKind.from(rawProviderId:)` normalizes case + alternate spellings
(`"azure-openai"`, `"azureopenai"`, `"azure_openai"` -> `.azureOpenai`). Any unknown id
returns `nil` and the caller falls back to system voice.

## Capability-scoped config models

The talk config coming from the gateway is per-provider. We keep one Swift struct per
capability, so unrelated fields don't leak into unrelated clients.

```swift
public struct VoiceCredentials: Sendable, Equatable {
    public let apiKey: String
    /// Only present when `kind == .azureOpenai`.
    public let azureEndpoint: URL?
    public let azureApiVersion: String?
}

public struct TTSCapabilityConfig: Sendable, Equatable {
    public let kind: VoiceProviderKind
    public let credentials: VoiceCredentials
    public let model: String                  // openai model or azure deployment
    public let voice: String                  // "alloy" / "coral" / ...
    public let responseFormat: TTSResponseFormat  // .mp3, .opus, .wav, .pcm
    public let instructions: String?          // gpt-4o-mini-tts only
    public let speed: Double?
    public let baseUrl: URL?                  // nil -> provider default
}

public struct STTCapabilityConfig: Sendable, Equatable {
    public let kind: VoiceProviderKind
    public let credentials: VoiceCredentials
    public let model: String                  // openai model or azure deployment
    public let language: String?              // ISO-639 or BCP-47 when known
    public let baseUrl: URL?
}

public struct RealtimeCapabilityConfig: Sendable, Equatable {
    public let kind: VoiceProviderKind
    public let credentials: VoiceCredentials
    public let model: String                  // gpt-realtime / azure deployment
    public let voice: String
    public let inputSampleRate: Int           // 16000 default; 24000 supported
    public let outputSampleRate: Int
}
```

## Endpoint + header builder

A single type builds URLs and headers for all capabilities across providers. It is the
only place that knows Azure vs direct-OpenAI surface shape. Everything else takes the
resolved URL and headers.

```swift
public enum VoiceCapability {
    case tts
    case transcribe
    case realtime
}

public struct VoiceRequestTarget: Sendable, Equatable {
    public let url: URL
    public let headers: [String: String]
}

public enum VoiceProviderEndpoints {
    public static func build(
        kind: VoiceProviderKind,
        capability: VoiceCapability,
        credentials: VoiceCredentials,
        model: String,
        baseUrl: URL?
    ) throws -> VoiceRequestTarget
}
```

URL shapes:

- `.openai` (+ custom baseUrl like `api.groq.com/openai/v1`):
  - tts: `POST {base}/audio/speech`
  - transcribe: `POST {base}/audio/transcriptions`
  - realtime: `wss://{base_host}/v1/realtime?model={model}` with `Authorization: Bearer {apiKey}` and `OpenAI-Beta: realtime=v1`.
- `.azureOpenai`:
  - tts: `POST {endpoint}/openai/deployments/{model}/audio/speech?api-version={apiVersion}`
  - transcribe: `POST {endpoint}/openai/deployments/{model}/audio/transcriptions?api-version={apiVersion}`
  - realtime: `wss://{endpoint_host}/openai/realtime?api-version={apiVersion}&deployment={model}`.
- `.elevenlabs`: not touched by this builder for Tier 1; existing
  `ElevenLabsTTSClient` still owns that call shape.

Auth headers:

- `.openai`: `Authorization: Bearer {apiKey}` + content-type.
- `.azureOpenai`: `api-key: {apiKey}` + content-type.

All inputs are trimmed and validated. Errors are typed:

```swift
public enum VoiceProviderEndpointError: Error, Equatable {
    case missingApiKey
    case missingAzureEndpoint
    case missingAzureApiVersion
    case invalidBaseUrl(String)
    case unsupportedCapability(VoiceProviderKind, VoiceCapability)
}
```

The `VoiceProviderEndpoints` type is pure value-computation, trivially unit-testable
with fixture configs, and contains the only `switch kind` block in the provider layer.

## Gateway config parsing

`TalkModeGatewayConfigParser` today reads `apiKey`, `modelId`, `voiceId`, `voiceAliases`,
`outputFormat`. For Tier 1 we extend the parsed state with a generic
`TalkProviderSurface` value that carries provider-kind-specific bits:

```swift
public struct TalkProviderSurface: Sendable, Equatable {
    public let kind: VoiceProviderKind?
    public let rawKindString: String   // what the gateway sent, for diagnostics
    public let apiKey: String?
    public let baseUrl: String?
    public let model: String?
    public let voice: String?
    public let responseFormat: String?
    public let instructions: String?
    public let speed: Double?
    // azure
    public let azureEndpoint: String?
    public let azureApiVersion: String?
    // transcription (read from optional `transcribe` sub-object or top-level hints)
    public let transcribeModel: String?
    // realtime (tier 2)
    public let realtimeModel: String?
    public let realtimeVoice: String?
    // secret sentinels (for redaction handling)
    public let apiKeyRedacted: Bool
}
```

Parse order:

1. Use `TalkConfigParsing.selectProviderConfig` to get `{provider, config}` from
   `talk.resolved`.
2. Map provider id via `VoiceProviderKind.from(rawProviderId:)`.
3. Read capability fields from the provider config object. Unknown keys are ignored.
4. Azure-specific keys come from the same config block
   (`azureEndpoint`, `azureApiVersion`, `model` == deployment name). There is no
   separate `azure` sub-object; we follow the shape the TS provider uses today.

`TalkModeManager` consumes `TalkProviderSurface` through a new helper
`TalkModeManager.resolveVoiceProviderSurface()` and uses it for both TTS (Tier 1) and
realtime (Tier 2). The ElevenLabs code path remains as-is but is entered only when
`surface.kind == .elevenlabs` (or when the surface maps to `.elevenlabs`). Any other
known provider routes through `OpenAICompatibleTTSClient`.

## TTS client

```swift
public protocol StreamingTTSClient: Sendable {
    /// Streams opaque audio bytes for the given text. The returned stream MAY emit the
    /// entire buffer as a single element (e.g. when the provider returns the full
    /// audio after generation) — downstream playback handles both cases.
    func streamSynthesize(
        text: String,
        config: TTSCapabilityConfig
    ) -> AsyncThrowingStream<Data, Error>
}
```

`OpenAICompatibleTTSClient` implements `StreamingTTSClient` against
`POST {target.url}` with the `/audio/speech` JSON body. It:

- accepts both OpenAI and Azure `kind` values (delegates URL/headers to
  `VoiceProviderEndpoints`),
- emits a single `Data` element on success (OpenAI returns the full encoded buffer),
- surfaces `VoiceProviderError` with request id metadata on non-2xx responses so logs
  stay consistent with the ElevenLabs path.

Playback: the existing `StreamingAudioPlayer` (MP3/OPUS/WAV) and
`PCMStreamingAudioPlayer` already work for our supported formats:

- `.mp3`, `.opus`, `.wav` -> `StreamingAudioPlayer`.
- `.pcm` (24000 mono s16le for OpenAI) -> `PCMStreamingAudioPlayer.play(stream:, sampleRate:)`.

## STT client

Tier 1 keeps on-device `SFSpeechRecognizer` as the default STT (what we ship today). We
add an opt-in server-side transcribe path for parity with the backend, gated on
`talk.resolved.config.useServerTranscribe == true` OR a missing on-device recognizer.
Scope for Tier 1: the client exists and is tested, but `TalkModeManager` keeps using
`SFSpeechRecognizer` unless the flag is set. This avoids destabilizing the mic pipeline.

```swift
public protocol VoiceTranscriptionClient: Sendable {
    func transcribe(
        audio: Data,
        contentType: String,
        config: STTCapabilityConfig
    ) async throws -> VoiceTranscription
}

public struct VoiceTranscription: Sendable, Equatable {
    public let text: String
    public let language: String?
}
```

Implementation posts multipart form-data to `/audio/transcriptions` with
`file`, `model`, and optional `language`. Azure substitutes model with deployment name
and adds the `api-version` query.

## Realtime (Tier 2)

```swift
public protocol RealtimeVoiceSession: AnyObject, Sendable {
    func connect() async throws
    func sendAudio(pcm16: Data)
    func sendText(_ text: String)
    func close()

    /// Event stream: connected, transcript partials/finals, assistant audio chunks,
    /// assistant text deltas, errors, reconnect attempts. Backed by AsyncStream.
    var events: AsyncStream<RealtimeVoiceEvent> { get }
}
```

`OpenAIRealtimeVoiceSession` is an actor-backed implementation that:

- builds the WS URL + headers via `VoiceProviderEndpoints`,
- uses `URLSessionWebSocketTask` to send/receive base64-encoded PCM16 frames,
- runs a server-VAD session update on connect (`input_audio_format: pcm16`,
  `turn_detection: server_vad`),
- supports reconnect with exp-backoff (max 5 attempts),
- reports media timestamps for half-duplex barge-in.

Audio capture uses the existing `AVAudioEngine` tap: we convert the tap's non-canonical
format (whatever the mic produces) to 16kHz mono s16le before send. Playback uses
`PCMStreamingAudioPlayer.play(stream:, sampleRate: 24000)` with a buffered pipe
receiving frames from the WS event handler.

## Error model

One shared error enum for the HTTP-call capabilities (TTS + STT):

```swift
public struct VoiceProviderError: Error, Sendable {
    public enum Code: String, Sendable {
        case missingCredentials
        case invalidConfig
        case network
        case server
        case badResponse
        case canceled
        case timeout
    }
    public let code: Code
    public let httpStatus: Int?
    public let providerRequestId: String?
    public let message: String
    public let underlying: Error?
}
```

Realtime errors surface via `RealtimeVoiceEvent.error(VoiceProviderError)` and/or the
connect `throws`.

## Test plan

Tier 1 (unit tests, runnable without a device):

- `VoiceProviderKindTests` — normalization table.
- `VoiceProviderEndpointsTests` — URL + header matrix for every
  `(VoiceProviderKind, VoiceCapability)` pair including custom baseUrl
  (`api.groq.com/openai/v1`), Azure with/without explicit apiVersion, TLS scheme
  upgrade for WS URLs, and error cases (missing endpoint, missing version).
- `OpenAICompatibleTTSClientTests` — request body shape, Azure auth header,
  non-2xx error surface. `URLProtocol` stub for the transport.
- `TalkProviderSurfaceParserTests` — extended gateway config parsing coverage for
  openai, azure-openai, elevenlabs, unknown provider.

Tier 2 (unit tests):

- `RealtimeVoiceSessionFrameTests` — PCM packaging, base64, event decode.
- `RealtimeReconnectPolicyTests` — exp-backoff schedule, max attempts.

Device smoke (pasted into commit body):

- Tier 1: PTT → short question → TTS reply audible via speaker on both `.openai` and
  `.azureOpenai`. ElevenLabs regression: existing flow still works with the same
  config.
- Tier 2: continuous conversation via Azure realtime, reply audio audible, user
  barge-in interrupts reply within ~600 ms.

## Invariants the implementation must preserve

1. No `if provider == azure` sprinkled across TalkModeManager; the only provider-kind
   switch is inside `VoiceProviderEndpoints` (and one tiny dispatcher that picks which
   `StreamingTTSClient` to use).
2. ElevenLabs users see no behavior change. The `gatewayTalkApiKeyConfigured` and
   related UI state continue to report ElevenLabs correctness for ElevenLabs users.
3. Secret values never appear in logs. Redacted sentinel handling stays identical to
   today (`__OPENCLAW_REDACTED__`).
4. API keys + Azure endpoints come from `talk.resolved.config` via the existing
   `talk.config` gateway method. We do not add a new RPC.
5. All new types are `Sendable`. The capability configs are `Equatable` so we can
   diff + skip no-op reloads.

## Open questions / follow-ups (non-blocking)

- Long-term: promote the provider layer from `apps/ios/Sources/Voice/` into
  `OpenClawKit` so macOS can share it. Out of scope for this branch (the macOS app
  already has a separate `TalkModeRuntime.swift`).
- Long-term: collapse `OpenClawChatUI` so TTS/Realtime UI state lives in a shared
  chat surface, not the tab-bar.
- Eventual: route Tier 2 realtime through the gateway bridge for server-authoritative
  tool calls. Current plan for Tier 2 is device-direct (the gateway already proxies
  realtime, but device-direct matches where ElevenLabs lives today and keeps the
  prompt-cache path unchanged).
