import Foundation
import OpenClawKit
import Testing

@Suite struct TalkProviderSurfaceTests {
    @Test func parsesOpenAIProviderBlock() {
        let config: [String: AnyCodable] = [
            "apiKey": AnyCodable("sk-fake"),
            "modelId": AnyCodable("gpt-4o-mini-tts"),
            "voiceId": AnyCodable("coral"),
            "outputFormat": AnyCodable("pcm"),
            "speed": AnyCodable(1.2),
            "instructions": AnyCodable("Speak clearly."),
            "transcribeModel": AnyCodable("gpt-4o-transcribe"),
            "transcribeLanguage": AnyCodable("en"),
            "useServerTranscribe": AnyCodable(true),
            "realtimeModel": AnyCodable("gpt-realtime"),
            "realtimeVoice": AnyCodable("alloy"),
        ]

        let surface = TalkProviderSurfaceParser.parse(rawProviderId: "openai", config: config)
        #expect(surface.kind == .openai)
        #expect(surface.apiKey == "sk-fake")
        #expect(surface.apiKeyRedacted == false)
        #expect(surface.model == "gpt-4o-mini-tts")
        #expect(surface.voice == "coral")
        #expect(surface.responseFormat == "pcm")
        #expect(surface.speed == 1.2)
        #expect(surface.instructions == "Speak clearly.")
        #expect(surface.transcribeModel == "gpt-4o-transcribe")
        #expect(surface.transcribeLanguage == "en")
        #expect(surface.useServerTranscribe == true)
        #expect(surface.realtimeModel == "gpt-realtime")
        #expect(surface.realtimeVoice == "alloy")

        let ttsConfig = surface.makeOpenAITTSConfig()
        #expect(ttsConfig?.kind == .openai)
        #expect(ttsConfig?.responseFormat == .pcm)
        #expect(ttsConfig?.credentials.azureEndpoint == nil)
    }

    @Test func parsesAzureOpenAIProviderBlock() {
        let config: [String: AnyCodable] = [
            "apiKey": AnyCodable("azure-key"),
            "azureEndpoint": AnyCodable("https://headstart-ai.openai.azure.com"),
            "azureApiVersion": AnyCodable("2025-03-20"),
            "modelId": AnyCodable("tts@001"),
            "voiceId": AnyCodable("alloy"),
            "outputFormat": AnyCodable("mp3"),
            "transcribeModel": AnyCodable("gpt-4o-transcribe@2025-03-20"),
            "realtimeModel": AnyCodable("gpt-realtime-1-5@2026-02-23"),
            "realtimeApiVersion": AnyCodable("2024-10-01-preview"),
        ]

        let surface = TalkProviderSurfaceParser.parse(rawProviderId: "azure-openai", config: config)
        #expect(surface.kind == .azureOpenai)
        #expect(surface.azureEndpoint == "https://headstart-ai.openai.azure.com")
        #expect(surface.azureApiVersion == "2025-03-20")
        #expect(surface.realtimeApiVersion == "2024-10-01-preview")

        let ttsConfig = surface.makeOpenAITTSConfig()
        #expect(ttsConfig?.kind == .azureOpenai)
        #expect(ttsConfig?.credentials.azureEndpoint?.absoluteString == "https://headstart-ai.openai.azure.com")
        #expect(ttsConfig?.credentials.azureApiVersion == "2025-03-20")
        #expect(ttsConfig?.responseFormat == .mp3)

        let sttConfig = surface.makeOpenAISTTConfig()
        #expect(sttConfig?.kind == .azureOpenai)
        #expect(sttConfig?.model == "gpt-4o-transcribe@2025-03-20")

        let realtime = surface.makeRealtimeConfig()
        #expect(realtime?.kind == .azureOpenai)
        #expect(realtime?.model == "gpt-realtime-1-5@2026-02-23")
        // Realtime config prefers realtimeApiVersion when present.
        #expect(realtime?.credentials.azureApiVersion == "2024-10-01-preview")
    }

    @Test func detectsRedactedApiKeySentinel() {
        let config: [String: AnyCodable] = [
            "apiKey": AnyCodable("__OPENCLAW_REDACTED__"),
        ]
        let surface = TalkProviderSurfaceParser.parse(rawProviderId: "openai", config: config)
        #expect(surface.apiKeyRedacted == true)
        #expect(surface.apiKey == nil)
    }

    @Test func unknownProviderReturnsNilKindAndNoCapabilityConfigs() {
        let surface = TalkProviderSurfaceParser.parse(
            rawProviderId: "mlx",
            config: ["apiKey": AnyCodable("x"), "modelId": AnyCodable("any")])
        #expect(surface.kind == nil)
        #expect(surface.makeOpenAITTSConfig() == nil)
        #expect(surface.makeOpenAISTTConfig() == nil)
        #expect(surface.makeRealtimeConfig() == nil)
    }

    @Test func elevenLabsProviderSkipsOpenAIFactories() {
        let surface = TalkProviderSurfaceParser.parse(
            rawProviderId: "elevenlabs",
            config: ["apiKey": AnyCodable("x"), "voiceId": AnyCodable("rachel"), "modelId": AnyCodable("eleven_v3")])
        #expect(surface.kind == .elevenlabs)
        #expect(surface.makeOpenAITTSConfig() == nil)
        #expect(surface.makeOpenAISTTConfig() == nil)
    }

    @Test func azureWithoutEndpointCannotProduceTTSConfig() {
        let surface = TalkProviderSurfaceParser.parse(
            rawProviderId: "azure-openai",
            config: ["apiKey": AnyCodable("k"), "modelId": AnyCodable("tts@001")])
        #expect(surface.kind == .azureOpenai)
        #expect(surface.makeOpenAITTSConfig() == nil)
    }

    @Test func openAITTSConfigDefaultsMissingModelAndVoice() {
        let surface = TalkProviderSurfaceParser.parse(
            rawProviderId: "openai",
            config: ["apiKey": AnyCodable("k")])
        let ttsConfig = surface.makeOpenAITTSConfig()
        #expect(ttsConfig?.model == "gpt-4o-mini-tts")
        #expect(ttsConfig?.voice == "coral")
        #expect(ttsConfig?.responseFormat == .pcm)
    }
}
