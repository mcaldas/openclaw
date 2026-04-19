import Foundation
import OpenClawKit
import Testing

// The iOS target's parser lives in the app module, so we cannot `@testable` import
// it from the Logic test target. Exercise the surface logic via the underlying
// `TalkProviderSurfaceParser` + normalization contract, which is what the iOS
// parser delegates to.
@Suite struct TalkModeGatewayConfigProviderSurfaceTests {
    @Test func providerSurfaceMatchesResolvedPayloadForOpenAI() {
        let talk: [String: Any] = [
            "provider": "openai",
            "providers": [
                "openai": [
                    "apiKey": "sk-fake",
                    "modelId": "gpt-4o-mini-tts",
                    "voiceId": "coral",
                    "outputFormat": "pcm",
                    "transcribeModel": "gpt-4o-transcribe",
                ],
            ],
            "resolved": [
                "provider": "openai",
                "config": [
                    "apiKey": "sk-fake",
                    "modelId": "gpt-4o-mini-tts",
                    "voiceId": "coral",
                    "outputFormat": "pcm",
                    "transcribeModel": "gpt-4o-transcribe",
                ],
            ],
        ]

        let bridged = TalkConfigParsing.bridgeFoundationDictionary(talk)
        let selection = TalkConfigParsing.selectProviderConfig(
            bridged,
            defaultProvider: "elevenlabs",
            allowLegacyFallback: false)
        #expect(selection?.provider == "openai")
        let surface = TalkProviderSurfaceParser.parse(
            rawProviderId: selection?.provider,
            config: selection?.config)
        #expect(surface.kind == .openai)
        #expect(surface.apiKey == "sk-fake")
        #expect(surface.model == "gpt-4o-mini-tts")
        #expect(surface.voice == "coral")
        #expect(surface.transcribeModel == "gpt-4o-transcribe")

        let tts = surface.makeOpenAITTSConfig()
        #expect(tts?.kind == .openai)
        #expect(tts?.responseFormat == .pcm)
    }

    @Test func providerSurfaceMatchesResolvedPayloadForAzureOpenAI() {
        let talk: [String: Any] = [
            "resolved": [
                "provider": "azure-openai",
                "config": [
                    "apiKey": "azure-key",
                    "azureEndpoint": "https://headstart-ai.openai.azure.com",
                    "azureApiVersion": "2025-03-20",
                    "modelId": "tts@001",
                    "voiceId": "alloy",
                    "outputFormat": "mp3",
                    "transcribeModel": "gpt-4o-transcribe@2025-03-20",
                    "realtimeModel": "gpt-realtime-1-5@2026-02-23",
                ],
            ],
        ]

        let bridged = TalkConfigParsing.bridgeFoundationDictionary(talk)
        let selection = TalkConfigParsing.selectProviderConfig(
            bridged,
            defaultProvider: "elevenlabs",
            allowLegacyFallback: false)
        #expect(selection?.provider == "azure-openai")

        let surface = TalkProviderSurfaceParser.parse(
            rawProviderId: selection?.provider,
            config: selection?.config)
        #expect(surface.kind == .azureOpenai)
        #expect(surface.azureEndpoint == "https://headstart-ai.openai.azure.com")
        #expect(surface.realtimeModel == "gpt-realtime-1-5@2026-02-23")

        let tts = surface.makeOpenAITTSConfig()
        #expect(tts?.kind == .azureOpenai)
        #expect(tts?.credentials.azureEndpoint?.absoluteString == "https://headstart-ai.openai.azure.com")
        #expect(tts?.responseFormat == .mp3)
    }

    @Test func providerSurfaceEmptyWhenUnknownProvider() {
        let talk: [String: Any] = [
            "resolved": [
                "provider": "mlx",
                "config": [
                    "voiceId": "unused",
                    "modelId": "also-unused",
                ],
            ],
        ]

        let bridged = TalkConfigParsing.bridgeFoundationDictionary(talk)
        let selection = TalkConfigParsing.selectProviderConfig(
            bridged,
            defaultProvider: "elevenlabs",
            allowLegacyFallback: false)
        let surface = TalkProviderSurfaceParser.parse(
            rawProviderId: selection?.provider,
            config: selection?.config)
        #expect(surface.kind == nil)
        #expect(surface.makeOpenAITTSConfig() == nil)
    }
}
