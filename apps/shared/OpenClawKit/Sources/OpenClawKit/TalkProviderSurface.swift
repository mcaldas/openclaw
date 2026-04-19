import Foundation

/// Normalized view of the per-provider talk config (the `config` half of
/// `talk.resolved`). Carries raw strings/numbers; capability-config construction is
/// done by `TalkProviderSurface.makeTTSConfig(...)` etc., which validate fields and
/// surface precise errors.
public struct TalkProviderSurface: Sendable, Equatable {
    public let kind: VoiceProviderKind?
    public let rawKindString: String

    public let apiKey: String?
    public let apiKeyRedacted: Bool
    public let baseUrl: String?

    public let model: String?
    public let voice: String?
    public let responseFormat: String?
    public let instructions: String?
    public let speed: Double?

    public let azureEndpoint: String?
    public let azureApiVersion: String?

    public let transcribeModel: String?
    public let transcribeLanguage: String?
    public let useServerTranscribe: Bool

    public let realtimeModel: String?
    public let realtimeVoice: String?
    public let realtimeApiVersion: String?

    public init(
        kind: VoiceProviderKind?,
        rawKindString: String,
        apiKey: String?,
        apiKeyRedacted: Bool,
        baseUrl: String?,
        model: String?,
        voice: String?,
        responseFormat: String?,
        instructions: String?,
        speed: Double?,
        azureEndpoint: String?,
        azureApiVersion: String?,
        transcribeModel: String?,
        transcribeLanguage: String?,
        useServerTranscribe: Bool,
        realtimeModel: String?,
        realtimeVoice: String?,
        realtimeApiVersion: String?
    ) {
        self.kind = kind
        self.rawKindString = rawKindString
        self.apiKey = apiKey
        self.apiKeyRedacted = apiKeyRedacted
        self.baseUrl = baseUrl
        self.model = model
        self.voice = voice
        self.responseFormat = responseFormat
        self.instructions = instructions
        self.speed = speed
        self.azureEndpoint = azureEndpoint
        self.azureApiVersion = azureApiVersion
        self.transcribeModel = transcribeModel
        self.transcribeLanguage = transcribeLanguage
        self.useServerTranscribe = useServerTranscribe
        self.realtimeModel = realtimeModel
        self.realtimeVoice = realtimeVoice
        self.realtimeApiVersion = realtimeApiVersion
    }
}

public enum TalkProviderSurfaceParser {
    public static let redactedSecretSentinel = "__OPENCLAW_REDACTED__"

    /// Build a `TalkProviderSurface` from the raw provider config block (what lives at
    /// `talk.resolved.config`). Pass the provider id string separately so we can
    /// distinguish `.azureOpenai` even when the resolved block lacks an `azureEndpoint`.
    public static func parse(
        rawProviderId: String?,
        config: [String: AnyCodable]?
    ) -> TalkProviderSurface {
        let rawKindString = (rawProviderId ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let kind = VoiceProviderKind.from(rawProviderId: rawKindString)
        let config = config ?? [:]

        let rawApiKey = self.trimmed(config["apiKey"]?.stringValue)
        let apiKeyRedacted = rawApiKey == self.redactedSecretSentinel
        let apiKey: String? = apiKeyRedacted ? nil : rawApiKey

        let baseUrl = self.trimmed(config["baseUrl"]?.stringValue)
        let model = self.trimmed(config["modelId"]?.stringValue) ?? self.trimmed(config["model"]?.stringValue)
        let voice = self.trimmed(config["voiceId"]?.stringValue) ?? self.trimmed(config["voice"]?.stringValue)
        let responseFormat = self.trimmed(config["outputFormat"]?.stringValue)
            ?? self.trimmed(config["responseFormat"]?.stringValue)
        let instructions = self.trimmed(config["instructions"]?.stringValue)
        let speed = config["speed"]?.doubleValue

        let azureEndpoint = self.trimmed(config["azureEndpoint"]?.stringValue)
        let azureApiVersion = self.trimmed(config["azureApiVersion"]?.stringValue)

        // Transcription keys — accept either `transcribe.*` nested form or top-level
        // `transcribeModel` / `transcribeLanguage`. The gateway does not currently
        // send a dedicated nested block, so top-level wins.
        let transcribeNested = config["transcribe"]?.dictionaryValue
        let transcribeModel = self.trimmed(config["transcribeModel"]?.stringValue)
            ?? self.trimmed(transcribeNested?["model"]?.stringValue)
            ?? self.trimmed(transcribeNested?["modelId"]?.stringValue)
        let transcribeLanguage = self.trimmed(config["transcribeLanguage"]?.stringValue)
            ?? self.trimmed(transcribeNested?["language"]?.stringValue)
        let useServerTranscribe = (config["useServerTranscribe"]?.boolValue ?? false)

        let realtimeNested = config["realtime"]?.dictionaryValue
        let realtimeModel = self.trimmed(config["realtimeModel"]?.stringValue)
            ?? self.trimmed(realtimeNested?["model"]?.stringValue)
            ?? self.trimmed(realtimeNested?["modelId"]?.stringValue)
            ?? self.trimmed(realtimeNested?["deployment"]?.stringValue)
        let realtimeVoice = self.trimmed(config["realtimeVoice"]?.stringValue)
            ?? self.trimmed(realtimeNested?["voice"]?.stringValue)
        let realtimeApiVersion = self.trimmed(config["realtimeApiVersion"]?.stringValue)
            ?? self.trimmed(realtimeNested?["apiVersion"]?.stringValue)

        return TalkProviderSurface(
            kind: kind,
            rawKindString: rawKindString,
            apiKey: apiKey,
            apiKeyRedacted: apiKeyRedacted,
            baseUrl: baseUrl,
            model: model,
            voice: voice,
            responseFormat: responseFormat,
            instructions: instructions,
            speed: speed,
            azureEndpoint: azureEndpoint,
            azureApiVersion: azureApiVersion,
            transcribeModel: transcribeModel,
            transcribeLanguage: transcribeLanguage,
            useServerTranscribe: useServerTranscribe,
            realtimeModel: realtimeModel,
            realtimeVoice: realtimeVoice,
            realtimeApiVersion: realtimeApiVersion)
    }

    private static func trimmed(_ value: String?) -> String? {
        let trimmed = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

public extension TalkProviderSurface {
    /// Which TTS response format to request from an OpenAI-shaped provider, given
    /// the iOS playback layer's capabilities. We default to `.pcm` when nothing is
    /// explicitly configured so we benefit from low-latency streaming; providers that
    /// reject PCM (none known today for OpenAI/Azure TTS) are still handled by the
    /// existing MP3 fallback path.
    func openAITTSResponseFormat() -> TTSResponseFormat {
        if let raw = self.responseFormat?.lowercased() {
            switch raw {
            case "mp3": return .mp3
            case "opus": return .opus
            case "wav": return .wav
            case "pcm", "pcm_24000", "pcm_16000", "pcm24000": return .pcm
            default: break
            }
        }
        return .pcm
    }

    /// Produce a `TTSCapabilityConfig` for OpenAI / Azure OpenAI. Returns nil for
    /// providers that don't use this path (ElevenLabs, unknown).
    func makeOpenAITTSConfig(
        fallbackModel: String = "gpt-4o-mini-tts",
        fallbackVoice: String = "coral"
    ) -> TTSCapabilityConfig? {
        guard let kind = self.kind, kind == .openai || kind == .azureOpenai else { return nil }
        guard let apiKey = self.apiKey, !apiKey.isEmpty else { return nil }
        let credentials: VoiceCredentials
        switch kind {
        case .openai:
            credentials = VoiceCredentials(apiKey: apiKey)
        case .azureOpenai:
            guard let endpoint = self.azureEndpoint, let endpointUrl = URL(string: endpoint) else {
                return nil
            }
            let apiVersion = self.azureApiVersion ?? VoiceProviderEndpoints.defaultAzureApiVersion
            credentials = VoiceCredentials(
                apiKey: apiKey,
                azureEndpoint: endpointUrl,
                azureApiVersion: apiVersion)
        case .elevenlabs:
            return nil
        }
        let baseUrl = self.baseUrl.flatMap(URL.init(string:))
        return TTSCapabilityConfig(
            kind: kind,
            credentials: credentials,
            model: self.model ?? fallbackModel,
            voice: self.voice ?? fallbackVoice,
            responseFormat: self.openAITTSResponseFormat(),
            instructions: self.instructions,
            speed: self.speed,
            baseUrl: baseUrl)
    }

    /// Produce an `STTCapabilityConfig` for OpenAI / Azure OpenAI. Returns nil when
    /// fields required by the transcription endpoint are missing.
    func makeOpenAISTTConfig(fallbackModel: String = "gpt-4o-transcribe") -> STTCapabilityConfig? {
        guard let kind = self.kind, kind == .openai || kind == .azureOpenai else { return nil }
        guard let apiKey = self.apiKey, !apiKey.isEmpty else { return nil }
        let credentials: VoiceCredentials
        switch kind {
        case .openai:
            credentials = VoiceCredentials(apiKey: apiKey)
        case .azureOpenai:
            guard let endpoint = self.azureEndpoint, let endpointUrl = URL(string: endpoint) else {
                return nil
            }
            let apiVersion = self.azureApiVersion ?? VoiceProviderEndpoints.defaultAzureApiVersion
            credentials = VoiceCredentials(
                apiKey: apiKey,
                azureEndpoint: endpointUrl,
                azureApiVersion: apiVersion)
        case .elevenlabs:
            return nil
        }
        let baseUrl = self.baseUrl.flatMap(URL.init(string:))
        return STTCapabilityConfig(
            kind: kind,
            credentials: credentials,
            model: self.transcribeModel ?? fallbackModel,
            language: self.transcribeLanguage,
            baseUrl: baseUrl)
    }

    /// Produce a `RealtimeCapabilityConfig` when the user has enabled realtime via
    /// `realtimeModel`. Used by Tier 2.
    func makeRealtimeConfig(fallbackVoice: String = "alloy") -> RealtimeCapabilityConfig? {
        guard let kind = self.kind, kind == .openai || kind == .azureOpenai else { return nil }
        guard let apiKey = self.apiKey, !apiKey.isEmpty else { return nil }
        guard let model = self.realtimeModel, !model.isEmpty else { return nil }
        let credentials: VoiceCredentials
        switch kind {
        case .openai:
            credentials = VoiceCredentials(apiKey: apiKey)
        case .azureOpenai:
            guard let endpoint = self.azureEndpoint, let endpointUrl = URL(string: endpoint) else {
                return nil
            }
            let apiVersion = self.realtimeApiVersion
                ?? self.azureApiVersion
                ?? VoiceProviderEndpoints.defaultAzureApiVersion
            credentials = VoiceCredentials(
                apiKey: apiKey,
                azureEndpoint: endpointUrl,
                azureApiVersion: apiVersion)
        case .elevenlabs:
            return nil
        }
        return RealtimeCapabilityConfig(
            kind: kind,
            credentials: credentials,
            model: model,
            voice: self.realtimeVoice ?? self.voice ?? fallbackVoice)
    }
}
