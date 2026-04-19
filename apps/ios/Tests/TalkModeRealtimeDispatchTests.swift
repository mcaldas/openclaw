import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

/// Verifies that TalkModeManager's realtime dispatch helpers honor the new opt-in
/// `enableRealtime` flag and the directive-level voice override.
@MainActor
@Suite struct TalkModeRealtimeDispatchTests {
    private func azureSurface(enableRealtime: Bool) -> TalkProviderSurface {
        TalkProviderSurfaceParser.parse(
            rawProviderId: "azure-openai",
            config: [
                "apiKey": AnyCodable("az-fake"),
                "azureEndpoint": AnyCodable("https://headstart-ai.openai.azure.com"),
                "azureApiVersion": AnyCodable("2025-04-01-preview"),
                "realtimeModel": AnyCodable("gpt-realtime-1-5@2026-02-23"),
                "enableRealtime": AnyCodable(enableRealtime),
            ])
    }

    @Test func realtimeDisabledWhenFlagMissing() {
        let surface = azureSurface(enableRealtime: false)
        #expect(TalkModeManager._test_isRealtimeEnabled(surface: surface) == false)
    }

    @Test func realtimeEnabledWhenFlagTrueAndProviderMapsOpenAICompatible() {
        let surface = azureSurface(enableRealtime: true)
        #expect(TalkModeManager._test_isRealtimeEnabled(surface: surface) == true)
    }

    @Test func realtimeDisabledForElevenLabsEvenWhenFlagTrue() {
        let surface = TalkProviderSurfaceParser.parse(
            rawProviderId: "elevenlabs",
            config: [
                "apiKey": AnyCodable("el-fake"),
                "realtimeModel": AnyCodable("gpt-realtime"),
                "enableRealtime": AnyCodable(true),
            ])
        #expect(TalkModeManager._test_isRealtimeEnabled(surface: surface) == false)
    }

    @Test func resolveRealtimeConfigReturnsAttemptOrderWithAutoFallback() throws {
        let surface = azureSurface(enableRealtime: true)
        let config = try #require(
            TalkModeManager._test_resolveRealtimeCapabilityConfig(
                surface: surface,
                directive: nil))
        #expect(config.model == "gpt-realtime-1-5@2026-02-23")
        #expect(config.attemptOrder == ["gpt-realtime-1-5@2026-02-23", "gpt-realtime"])
    }

    @Test func directiveVoiceOverrideWinsOverProviderDefault() throws {
        let surface = azureSurface(enableRealtime: true)
        var directive = TalkDirective()
        directive.voiceId = "sage"
        let config = try #require(
            TalkModeManager._test_resolveRealtimeCapabilityConfig(
                surface: surface,
                directive: directive))
        #expect(config.voice == "sage")
    }

    @Test func blankDirectiveVoiceKeepsProviderDefault() throws {
        let surface = azureSurface(enableRealtime: true)
        var directive = TalkDirective()
        directive.voiceId = "   "
        let config = try #require(
            TalkModeManager._test_resolveRealtimeCapabilityConfig(
                surface: surface,
                directive: directive))
        // Falls back to provider `voice` (default "alloy").
        #expect(config.voice == "alloy")
    }

    @Test func resolveReturnsNilWhenRealtimeModelMissing() {
        let surface = TalkProviderSurfaceParser.parse(
            rawProviderId: "azure-openai",
            config: [
                "apiKey": AnyCodable("az-fake"),
                "azureEndpoint": AnyCodable("https://headstart-ai.openai.azure.com"),
                "azureApiVersion": AnyCodable("2025-04-01-preview"),
                "enableRealtime": AnyCodable(true),
            ])
        #expect(
            TalkModeManager._test_resolveRealtimeCapabilityConfig(
                surface: surface,
                directive: nil) == nil)
    }
}
