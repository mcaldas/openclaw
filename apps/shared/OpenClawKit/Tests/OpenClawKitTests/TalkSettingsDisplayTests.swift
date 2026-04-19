import Foundation
import OpenClawKit
import Testing

@Suite struct TalkSettingsDisplayTests {
    @Test func rendersMultiProviderAzureOpenAIWithRealtimeOn() {
        // (a) Normalized multi-provider azure-openai payload with realtime enabled.
        let talk: [String: Any] = [
            "provider": "azure-openai",
            "providers": [
                "azure-openai": [
                    "apiKey": "azure-key",
                    "azureEndpoint": "https://example.openai.azure.com",
                    "modelId": "tts",
                    "voiceId": "alloy",
                    "enableRealtime": true,
                    "realtimeModel": "gpt-realtime-1-5",
                ],
            ],
            "resolved": [
                "provider": "azure-openai",
                "config": [
                    "apiKey": "azure-key",
                    "azureEndpoint": "https://example.openai.azure.com",
                    "modelId": "tts",
                    "voiceId": "alloy",
                    "enableRealtime": true,
                    "realtimeModel": "gpt-realtime-1-5",
                ],
            ],
        ]
        let bridged = TalkConfigParsing.bridgeFoundationDictionary(talk)
        let display = TalkSettingsDisplayBuilder.build(talk: bridged, configLoaded: true)
        #expect(display.providerLabel == "Azure OpenAI")
        #expect(display.apiKeyConfigured == true)
        #expect(display.defaultModelId == "tts")
        #expect(display.defaultVoiceId == "alloy")
        #expect(display.realtimeModelId == "gpt-realtime-1-5")
        #expect(display.hintText.contains("talk.provider"))
        #expect(display.hintText.contains("talk.providers"))
    }

    @Test func rendersMultiProviderOpenAIWithRealtimeOff() {
        // (b) Normalized multi-provider openai payload without realtime.
        let talk: [String: Any] = [
            "provider": "openai",
            "providers": [
                "openai": [
                    "apiKey": "sk-fake",
                    "modelId": "gpt-4o-mini-tts",
                    "voiceId": "coral",
                ],
            ],
            "resolved": [
                "provider": "openai",
                "config": [
                    "apiKey": "sk-fake",
                    "modelId": "gpt-4o-mini-tts",
                    "voiceId": "coral",
                ],
            ],
        ]
        let bridged = TalkConfigParsing.bridgeFoundationDictionary(talk)
        let display = TalkSettingsDisplayBuilder.build(talk: bridged, configLoaded: true)
        #expect(display.providerLabel == "OpenAI")
        #expect(display.apiKeyConfigured == true)
        #expect(display.defaultModelId == "gpt-4o-mini-tts")
        #expect(display.defaultVoiceId == "coral")
        #expect(display.realtimeModelId == nil)
        #expect(display.hintText.contains("talk.provider"))
    }

    @Test func rendersLegacyFlatElevenLabsShape() {
        // (c) Legacy flat payload (no provider / providers keys).
        let talk: [String: Any] = [
            "apiKey": "el-key",
            "modelId": "eleven_v3",
            "voiceId": "rachel",
        ]
        let bridged = TalkConfigParsing.bridgeFoundationDictionary(talk)
        let display = TalkSettingsDisplayBuilder.build(talk: bridged, configLoaded: true)
        #expect(display.providerLabel == "ElevenLabs")
        #expect(display.apiKeyConfigured == true)
        #expect(display.defaultModelId == "eleven_v3")
        #expect(display.defaultVoiceId == "rachel")
        #expect(display.realtimeModelId == nil)
        // Legacy shape: hint still references the old flat keys so users know
        // where to look on older gateway builds.
        #expect(display.hintText.contains("talk.apiKey"))
        #expect(display.hintText.contains("talk.modelId"))
        #expect(display.hintText.contains("talk.voiceId"))
    }

    @Test func reportsNilApiKeyStateWhenConfigNotLoadedYet() {
        let display = TalkSettingsDisplayBuilder.build(talk: nil, configLoaded: false)
        #expect(display.apiKeyConfigured == nil)
        #expect(display.defaultModelId == nil)
        #expect(display.defaultVoiceId == nil)
        #expect(display.realtimeModelId == nil)
    }

    @Test func reportsNotConfiguredApiKeyWhenEmptyOrPlaceholder() {
        // Env placeholder + empty key should both surface as "not configured".
        let envPlaceholder = TalkConfigParsing.bridgeFoundationDictionary([
            "resolved": [
                "provider": "openai",
                "config": ["apiKey": "${OPENAI_API_KEY}", "modelId": "m", "voiceId": "v"],
            ],
        ] as [String: Any])
        let emptyKey = TalkConfigParsing.bridgeFoundationDictionary([
            "resolved": [
                "provider": "openai",
                "config": ["apiKey": "", "modelId": "m", "voiceId": "v"],
            ],
        ] as [String: Any])
        let placeholderDisplay = TalkSettingsDisplayBuilder.build(
            talk: envPlaceholder,
            configLoaded: true)
        let emptyDisplay = TalkSettingsDisplayBuilder.build(
            talk: emptyKey,
            configLoaded: true)
        #expect(placeholderDisplay.apiKeyConfigured == false)
        #expect(emptyDisplay.apiKeyConfigured == false)
    }

    @Test func treatsRedactedApiKeySentinelAsConfigured() {
        let talk: [String: Any] = [
            "resolved": [
                "provider": "openai",
                "config": [
                    "apiKey": "__OPENCLAW_REDACTED__",
                    "modelId": "m",
                    "voiceId": "v",
                ],
            ],
        ]
        let bridged = TalkConfigParsing.bridgeFoundationDictionary(talk)
        let display = TalkSettingsDisplayBuilder.build(talk: bridged, configLoaded: true)
        #expect(display.apiKeyConfigured == true)
    }

    @Test func unknownProviderPassesThroughAsProviderLabel() {
        #expect(TalkSettingsDisplayBuilder.providerLabel(from: "mlx-local") == "mlx-local")
        #expect(TalkSettingsDisplayBuilder.providerLabel(from: "") == "Unknown")
        #expect(TalkSettingsDisplayBuilder.providerLabel(from: "OPENAI") == "OpenAI")
    }

    @Test func hidesRealtimeRowWhenEnableRealtimeFalse() {
        let talk: [String: Any] = [
            "resolved": [
                "provider": "openai",
                "config": [
                    "apiKey": "k",
                    "modelId": "m",
                    "voiceId": "v",
                    "enableRealtime": false,
                    "realtimeModel": "gpt-realtime",
                ],
            ],
        ]
        let bridged = TalkConfigParsing.bridgeFoundationDictionary(talk)
        let display = TalkSettingsDisplayBuilder.build(talk: bridged, configLoaded: true)
        #expect(display.realtimeModelId == nil)
    }
}
