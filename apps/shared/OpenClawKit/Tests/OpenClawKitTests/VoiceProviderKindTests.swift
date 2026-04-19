import OpenClawKit
import Testing

@Suite struct VoiceProviderKindTests {
    @Test func normalizesCanonicalIds() {
        #expect(VoiceProviderKind.from(rawProviderId: "openai") == .openai)
        #expect(VoiceProviderKind.from(rawProviderId: "azure-openai") == .azureOpenai)
        #expect(VoiceProviderKind.from(rawProviderId: "elevenlabs") == .elevenlabs)
    }

    @Test func normalizesCaseAndWhitespace() {
        #expect(VoiceProviderKind.from(rawProviderId: "  OpenAI ") == .openai)
        #expect(VoiceProviderKind.from(rawProviderId: "Azure-OpenAI") == .azureOpenai)
        #expect(VoiceProviderKind.from(rawProviderId: "ELEVENLABS") == .elevenlabs)
    }

    @Test func acceptsCommonDialects() {
        #expect(VoiceProviderKind.from(rawProviderId: "azure_openai") == .azureOpenai)
        #expect(VoiceProviderKind.from(rawProviderId: "azureopenai") == .azureOpenai)
        #expect(VoiceProviderKind.from(rawProviderId: "azure") == .azureOpenai)
        #expect(VoiceProviderKind.from(rawProviderId: "open_ai") == .openai)
        #expect(VoiceProviderKind.from(rawProviderId: "eleven_labs") == .elevenlabs)
    }

    @Test func returnsNilForUnknownOrEmpty() {
        #expect(VoiceProviderKind.from(rawProviderId: nil) == nil)
        #expect(VoiceProviderKind.from(rawProviderId: "") == nil)
        #expect(VoiceProviderKind.from(rawProviderId: "   ") == nil)
        #expect(VoiceProviderKind.from(rawProviderId: "mlx") == nil)
        #expect(VoiceProviderKind.from(rawProviderId: "anthropic") == nil)
    }
}
