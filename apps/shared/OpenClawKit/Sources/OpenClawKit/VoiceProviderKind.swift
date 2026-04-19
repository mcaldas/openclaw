import Foundation

/// The generic provider discriminator used by the iOS/macOS voice layer.
///
/// We intentionally keep this set small: every new provider has to earn its place in
/// the discriminator by being exercised by `VoiceProviderEndpoints` and at least one
/// capability client. Unknown gateway provider ids fall through as `nil`.
public enum VoiceProviderKind: String, Sendable, CaseIterable, Hashable {
    case elevenlabs
    case openai
    case azureOpenai = "azure-openai"

    /// Case-insensitive + dialect-tolerant lookup for ids coming from the gateway config.
    ///
    /// The gateway currently sends canonical `"elevenlabs"`, `"openai"`,
    /// `"azure-openai"`, but third-party forks have been seen with `"azure_openai"` /
    /// `"azureopenai"` / camelCased variants, so we normalize here once.
    public static func from(rawProviderId raw: String?) -> VoiceProviderKind? {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !trimmed.isEmpty else { return nil }
        switch trimmed {
        case "elevenlabs", "eleven-labs", "eleven_labs":
            return .elevenlabs
        case "openai", "open-ai", "open_ai":
            return .openai
        case "azure-openai", "azureopenai", "azure_openai", "azure":
            return .azureOpenai
        default:
            return nil
        }
    }
}
