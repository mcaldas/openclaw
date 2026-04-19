import Foundation

/// Credentials shared by all OpenAI-shaped providers.
///
/// For `.openai`, only `apiKey` is required (baseUrl falls back to the provider
/// default). For `.azureOpenai`, `apiKey` + `azureEndpoint` + `azureApiVersion` are
/// required; the model/deployment id is supplied per capability.
public struct VoiceCredentials: Sendable, Equatable {
    public let apiKey: String
    public let azureEndpoint: URL?
    public let azureApiVersion: String?

    public init(
        apiKey: String,
        azureEndpoint: URL? = nil,
        azureApiVersion: String? = nil
    ) {
        self.apiKey = apiKey
        self.azureEndpoint = azureEndpoint
        self.azureApiVersion = azureApiVersion
    }
}

/// Response formats understood by the HTTP TTS client and our playback layer.
///
/// `.pcm` is 24000 Hz signed 16-bit mono little-endian when produced by OpenAI;
/// Azure's PCM output matches.
public enum TTSResponseFormat: String, Sendable, Equatable, CaseIterable {
    case mp3
    case opus
    case wav
    case pcm
}

public struct TTSCapabilityConfig: Sendable, Equatable {
    public let kind: VoiceProviderKind
    public let credentials: VoiceCredentials
    public let model: String
    public let voice: String
    public let responseFormat: TTSResponseFormat
    public let instructions: String?
    public let speed: Double?
    public let baseUrl: URL?

    public init(
        kind: VoiceProviderKind,
        credentials: VoiceCredentials,
        model: String,
        voice: String,
        responseFormat: TTSResponseFormat,
        instructions: String? = nil,
        speed: Double? = nil,
        baseUrl: URL? = nil
    ) {
        self.kind = kind
        self.credentials = credentials
        self.model = model
        self.voice = voice
        self.responseFormat = responseFormat
        self.instructions = instructions
        self.speed = speed
        self.baseUrl = baseUrl
    }
}

public struct STTCapabilityConfig: Sendable, Equatable {
    public let kind: VoiceProviderKind
    public let credentials: VoiceCredentials
    public let model: String
    public let language: String?
    public let baseUrl: URL?

    public init(
        kind: VoiceProviderKind,
        credentials: VoiceCredentials,
        model: String,
        language: String? = nil,
        baseUrl: URL? = nil
    ) {
        self.kind = kind
        self.credentials = credentials
        self.model = model
        self.language = language
        self.baseUrl = baseUrl
    }
}

public struct RealtimeCapabilityConfig: Sendable, Equatable {
    public let kind: VoiceProviderKind
    public let credentials: VoiceCredentials
    public let model: String
    public let voice: String
    public let inputSampleRate: Int
    public let outputSampleRate: Int
    /// Ordered list of models/deployments to try after `model` when a connection
    /// fails with a transient error (1006, 1011, 429, 503, network timeout). The
    /// first entry is the first fallback. Empty means no fallback.
    public let modelFallbacks: [String]

    public init(
        kind: VoiceProviderKind,
        credentials: VoiceCredentials,
        model: String,
        voice: String,
        inputSampleRate: Int = 16_000,
        outputSampleRate: Int = 24_000,
        modelFallbacks: [String] = []
    ) {
        self.kind = kind
        self.credentials = credentials
        self.model = model
        self.voice = voice
        self.inputSampleRate = inputSampleRate
        self.outputSampleRate = outputSampleRate
        self.modelFallbacks = modelFallbacks
    }

    /// Full attempt order starting with the primary model.
    public var attemptOrder: [String] {
        [self.model] + self.modelFallbacks
    }
}
