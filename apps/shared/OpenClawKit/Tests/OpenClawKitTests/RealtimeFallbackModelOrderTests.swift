import Foundation
import OpenClawKit
import Testing

/// Verifies the fallback-list resolution on `TalkProviderSurface.makeRealtimeConfig()`
/// and the derived `attemptOrder` on `RealtimeCapabilityConfig`.
@Suite struct RealtimeFallbackModelOrderTests {
    private func azureSurface(
        primary: String,
        fallbacks: [AnyCodable]? = nil,
        enableRealtime: Bool = true
    ) -> TalkProviderSurface {
        var config: [String: AnyCodable] = [
            "apiKey": AnyCodable("az-key"),
            "azureEndpoint": AnyCodable("https://headstart-ai.openai.azure.com"),
            "azureApiVersion": AnyCodable("2025-04-01-preview"),
            "realtimeModel": AnyCodable(primary),
            "enableRealtime": AnyCodable(enableRealtime),
        ]
        if let fallbacks {
            config["realtimeModelFallbacks"] = AnyCodable(fallbacks)
        }
        return TalkProviderSurfaceParser.parse(
            rawProviderId: "azure-openai",
            config: config)
    }

    @Test func autoDefaultsGptRealtimeWhenPrimaryMatches15Dashed() throws {
        let surface = azureSurface(primary: "gpt-realtime-1-5@2026-02-23")
        let cfg = try #require(surface.makeRealtimeConfig())
        #expect(cfg.modelFallbacks == ["gpt-realtime"])
        #expect(cfg.attemptOrder == ["gpt-realtime-1-5@2026-02-23", "gpt-realtime"])
    }

    @Test func autoDefaultsGptRealtimeWhenPrimaryMatches15Dotted() throws {
        let surface = azureSurface(primary: "gpt-realtime-1.5")
        let cfg = try #require(surface.makeRealtimeConfig())
        #expect(cfg.modelFallbacks == ["gpt-realtime"])
    }

    @Test func noAutoDefaultWhenPrimaryIsNot15() throws {
        let surface = azureSurface(primary: "gpt-realtime")
        let cfg = try #require(surface.makeRealtimeConfig())
        #expect(cfg.modelFallbacks.isEmpty)
        #expect(cfg.attemptOrder == ["gpt-realtime"])
    }

    @Test func explicitFallbackListWinsAndDedupsPrimary() throws {
        let surface = azureSurface(
            primary: "gpt-realtime-1-5",
            fallbacks: [
                AnyCodable(" gpt-realtime-1-5 "),
                AnyCodable(" "),
                AnyCodable("gpt-realtime"),
                AnyCodable("gpt-realtime"),
                AnyCodable("legacy-model"),
            ])
        let cfg = try #require(surface.makeRealtimeConfig())
        #expect(cfg.modelFallbacks == ["gpt-realtime", "legacy-model"])
    }

    @Test func emptyExplicitListFallsBackToAutoDefault() throws {
        let surface = azureSurface(
            primary: "gpt-realtime-1-5",
            fallbacks: [])
        let cfg = try #require(surface.makeRealtimeConfig())
        // Empty explicit list is treated as "no explicit value", auto-default applies.
        #expect(cfg.modelFallbacks == ["gpt-realtime"])
    }

    @Test func nestedFallbackListIsHonored() throws {
        let surface = TalkProviderSurfaceParser.parse(
            rawProviderId: "azure-openai",
            config: [
                "apiKey": AnyCodable("az-key"),
                "azureEndpoint": AnyCodable("https://example.openai.azure.com"),
                "azureApiVersion": AnyCodable("2025-04-01-preview"),
                "realtime": AnyCodable([
                    "model": "gpt-realtime-1-5",
                    "modelFallbacks": ["gpt-realtime", "gpt-realtime-preview"],
                    "enabled": true,
                ]),
            ])
        let cfg = try #require(surface.makeRealtimeConfig())
        #expect(cfg.modelFallbacks == ["gpt-realtime", "gpt-realtime-preview"])
    }

    @Test func enableRealtimeFlagParsedFromNestedAndTopLevel() throws {
        let top = TalkProviderSurfaceParser.parse(
            rawProviderId: "openai",
            config: [
                "apiKey": AnyCodable("k"),
                "realtimeModel": AnyCodable("gpt-realtime"),
                "enableRealtime": AnyCodable(true),
            ])
        #expect(top.enableRealtime == true)
        let nested = TalkProviderSurfaceParser.parse(
            rawProviderId: "openai",
            config: [
                "apiKey": AnyCodable("k"),
                "realtime": AnyCodable([
                    "model": "gpt-realtime",
                    "enabled": true,
                ]),
            ])
        #expect(nested.enableRealtime == true)
        let defaulted = TalkProviderSurfaceParser.parse(
            rawProviderId: "openai",
            config: [
                "apiKey": AnyCodable("k"),
                "realtimeModel": AnyCodable("gpt-realtime"),
            ])
        #expect(defaulted.enableRealtime == false)
    }
}
