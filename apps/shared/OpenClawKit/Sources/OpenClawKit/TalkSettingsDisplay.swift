import Foundation

/// Display-only view model for the iOS Settings -> Advanced -> Talk Voice panel.
///
/// Reads from the multi-provider gateway shape (`talk.provider` + `talk.providers.<id>.*`,
/// via the resolved `talk.resolved.config` block that `TalkProviderSurfaceParser`
/// already knows how to interpret) and falls back gracefully to the legacy flat
/// shape (`talk.apiKey` / `talk.modelId` / `talk.voiceId`) so older gateway
/// builds keep a sensible display.
///
/// Kept in OpenClawKit so the view model can be unit-tested on macOS without
/// reaching into iOS target-private code.
public struct TalkSettingsDisplay: Sendable, Equatable {
    /// Human-readable provider label. For known providers uses the canonical
    /// capitalization ("OpenAI", "Azure OpenAI", "ElevenLabs"); unknown ids
    /// pass through unchanged.
    public let providerLabel: String
    /// Whether an API key is configured on the gateway (or via a local keychain
    /// override). `nil` means "config not loaded yet".
    public let apiKeyConfigured: Bool?
    /// Default TTS / chat voice model id, or nil when unknown.
    public let defaultModelId: String?
    /// Default voice id, or nil when unknown.
    public let defaultVoiceId: String?
    /// Realtime model id when `enableRealtime` is true; nil otherwise.
    public let realtimeModelId: String?
    /// Short help text describing which gateway config keys drive the display.
    /// Follows the new multi-provider shape for known providers; still points at
    /// the legacy keys when the gateway has not migrated yet.
    public let hintText: String

    public init(
        providerLabel: String,
        apiKeyConfigured: Bool?,
        defaultModelId: String?,
        defaultVoiceId: String?,
        realtimeModelId: String?,
        hintText: String
    ) {
        self.providerLabel = providerLabel
        self.apiKeyConfigured = apiKeyConfigured
        self.defaultModelId = defaultModelId
        self.defaultVoiceId = defaultVoiceId
        self.realtimeModelId = realtimeModelId
        self.hintText = hintText
    }
}

public enum TalkSettingsDisplayBuilder {
    /// Build a `TalkSettingsDisplay` from the top-level `talk` block the gateway
    /// returns for `talk.config`. Accepts the normalized multi-provider payload
    /// (preferred) and the legacy flat payload as a fallback.
    ///
    /// `configLoaded` reflects whether the manager has ingested a talk config at
    /// least once; when false we still display a best-effort guess but mark the
    /// API key state as "not loaded" instead of "not configured".
    public static func build(
        talk: [String: AnyCodable]?,
        configLoaded: Bool
    ) -> TalkSettingsDisplay {
        let selection = TalkConfigParsing.selectProviderConfig(
            talk,
            defaultProvider: defaultLegacyProvider,
            allowLegacyFallback: true)
        // Multi-provider payload wins.
        if let selection, selection.normalizedPayload {
            return self.build(
                selection: selection,
                configLoaded: configLoaded,
                isLegacyShape: false)
        }
        // Legacy flat payload — no `provider` / `providers` key. We still got a
        // selection back because `allowLegacyFallback: true`.
        if let selection {
            return self.build(
                selection: selection,
                configLoaded: configLoaded,
                isLegacyShape: true)
        }
        // No talk block at all; return a stub display so the view can render.
        return TalkSettingsDisplay(
            providerLabel: providerLabel(from: defaultLegacyProvider),
            apiKeyConfigured: configLoaded ? false : nil,
            defaultModelId: nil,
            defaultVoiceId: nil,
            realtimeModelId: nil,
            hintText: legacyHintText)
    }

    /// Map a provider id string to a human-readable label.
    public static func providerLabel(from rawProviderId: String) -> String {
        let trimmed = rawProviderId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch trimmed {
        case "": return "Unknown"
        case "openai": return "OpenAI"
        case "azure-openai": return "Azure OpenAI"
        case "elevenlabs": return "ElevenLabs"
        default: return rawProviderId
        }
    }

    private static let defaultLegacyProvider = "elevenlabs"

    private static let newShapeHintText = """
        Configured on gateway via talk.provider and talk.providers.<id>.{apiKey, \
        modelId, voiceId}.
        """

    private static let legacyHintText = """
        Configured on gateway via talk.apiKey, talk.modelId, and talk.voiceId.
        """

    private static func build(
        selection: TalkProviderConfigSelection,
        configLoaded: Bool,
        isLegacyShape: Bool
    ) -> TalkSettingsDisplay {
        let surface = TalkProviderSurfaceParser.parse(
            rawProviderId: selection.provider,
            config: selection.config)
        // API key: redacted sentinel, env placeholder, and legacy empty string all
        // count as "not configured". The actual iOS override path lives in the
        // talk manager; here we just surface whether the gateway reports one.
        let apiKeyRaw = selection.config["apiKey"]?.stringValue ?? ""
        let apiKeyTrimmed = apiKeyRaw.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasKey: Bool? = {
            guard configLoaded else { return nil }
            if apiKeyTrimmed.isEmpty { return false }
            if apiKeyTrimmed == TalkProviderSurfaceParser.redactedSecretSentinel {
                // Redacted: key exists in the gateway config but wasn't shipped in
                // the payload. Treat as configured.
                return true
            }
            if apiKeyTrimmed.hasPrefix("${"), apiKeyTrimmed.hasSuffix("}") {
                // Env placeholder: the gateway was configured to resolve later but
                // the substitution didn't happen. Not configured.
                return false
            }
            return true
        }()
        let realtimeModel: String? = surface.enableRealtime ? surface.realtimeModel : nil
        return TalkSettingsDisplay(
            providerLabel: providerLabel(from: selection.provider),
            apiKeyConfigured: hasKey,
            defaultModelId: surface.model,
            defaultVoiceId: surface.voice,
            realtimeModelId: realtimeModel,
            hintText: isLegacyShape ? legacyHintText : newShapeHintText)
    }
}
