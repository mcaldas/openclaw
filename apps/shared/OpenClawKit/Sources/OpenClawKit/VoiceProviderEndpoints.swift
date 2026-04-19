import Foundation

/// What the HTTP capability client needs to issue a request.
public struct VoiceRequestTarget: Sendable, Equatable {
    public let url: URL
    public let headers: [String: String]

    public init(url: URL, headers: [String: String]) {
        self.url = url
        self.headers = headers
    }
}

/// Capabilities the voice layer knows how to route.
public enum VoiceCapability: Sendable, Hashable, CaseIterable {
    case tts
    case transcribe
    case realtime
}

public enum VoiceProviderEndpointError: Error, Sendable, Equatable {
    case missingApiKey
    case missingAzureEndpoint
    case missingAzureApiVersion
    case invalidBaseUrl(String)
    case unsupportedCapability(VoiceProviderKind, VoiceCapability)
}

/// Pure value-level computation of request URL + auth headers for the supported
/// providers. This is the only type in the stack that knows the shape of Azure vs
/// direct-OpenAI endpoints; everything else takes the resolved target.
public enum VoiceProviderEndpoints {
    public static let defaultOpenAIBaseUrl = URL(string: "https://api.openai.com/v1")!
    public static let defaultAzureApiVersion = "2024-10-01-preview"

    public static func build(
        kind: VoiceProviderKind,
        capability: VoiceCapability,
        credentials: VoiceCredentials,
        model: String,
        baseUrl: URL? = nil
    ) throws -> VoiceRequestTarget {
        let apiKey = credentials.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !apiKey.isEmpty else { throw VoiceProviderEndpointError.missingApiKey }
        let trimmedModel = model.trimmingCharacters(in: .whitespacesAndNewlines)

        switch kind {
        case .elevenlabs:
            throw VoiceProviderEndpointError.unsupportedCapability(kind, capability)
        case .openai:
            return try self.buildOpenAITarget(
                capability: capability,
                apiKey: apiKey,
                model: trimmedModel,
                baseUrl: baseUrl)
        case .azureOpenai:
            return try self.buildAzureTarget(
                capability: capability,
                credentials: credentials,
                apiKey: apiKey,
                model: trimmedModel)
        }
    }

    // MARK: - OpenAI (and OpenAI-compatible gateways like Groq).

    private static func buildOpenAITarget(
        capability: VoiceCapability,
        apiKey: String,
        model: String,
        baseUrl: URL?
    ) throws -> VoiceRequestTarget {
        let base = try self.normalizedOpenAIBase(baseUrl: baseUrl)
        switch capability {
        case .tts:
            guard let url = URL(string: "\(base)/audio/speech") else {
                throw VoiceProviderEndpointError.invalidBaseUrl(base)
            }
            return VoiceRequestTarget(
                url: url,
                headers: [
                    "Authorization": "Bearer \(apiKey)",
                    "Content-Type": "application/json",
                ])
        case .transcribe:
            guard let url = URL(string: "\(base)/audio/transcriptions") else {
                throw VoiceProviderEndpointError.invalidBaseUrl(base)
            }
            return VoiceRequestTarget(
                url: url,
                headers: [
                    "Authorization": "Bearer \(apiKey)",
                    // Content-Type for transcribe is multipart; client sets it with boundary.
                ])
        case .realtime:
            let wsBase = self.httpSchemeToWebSocket(base)
            let encodedModel = model.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? model
            // OpenAI realtime lives off `/v1/realtime` at the api host, regardless of
            // any `/v1` suffix on the http base. Extract the host-only prefix.
            let hostOnlyBase = self.openAIRealtimeBase(wsBase: wsBase)
            guard let url = URL(string: "\(hostOnlyBase)/v1/realtime?model=\(encodedModel)") else {
                throw VoiceProviderEndpointError.invalidBaseUrl(base)
            }
            return VoiceRequestTarget(
                url: url,
                headers: [
                    "Authorization": "Bearer \(apiKey)",
                    "OpenAI-Beta": "realtime=v1",
                ])
        }
    }

    // MARK: - Azure OpenAI.

    private static func buildAzureTarget(
        capability: VoiceCapability,
        credentials: VoiceCredentials,
        apiKey: String,
        model deployment: String
    ) throws -> VoiceRequestTarget {
        guard let endpoint = credentials.azureEndpoint else {
            throw VoiceProviderEndpointError.missingAzureEndpoint
        }
        let apiVersion = (credentials.azureApiVersion?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap {
            $0.isEmpty ? nil : $0
        }
        guard let apiVersion else {
            throw VoiceProviderEndpointError.missingAzureApiVersion
        }
        let encodedDeployment = deployment.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? deployment
        let encodedApiVersion =
            apiVersion.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? apiVersion
        let baseString = self.trimmingTrailingSlashes(endpoint.absoluteString)

        switch capability {
        case .tts:
            guard
                let url = URL(
                    string:
                    "\(baseString)/openai/deployments/\(encodedDeployment)/audio/speech?api-version=\(encodedApiVersion)")
            else {
                throw VoiceProviderEndpointError.invalidBaseUrl(baseString)
            }
            return VoiceRequestTarget(
                url: url,
                headers: [
                    "api-key": apiKey,
                    "Content-Type": "application/json",
                ])
        case .transcribe:
            guard
                let url = URL(
                    string:
                    "\(baseString)/openai/deployments/\(encodedDeployment)/audio/transcriptions?api-version=\(encodedApiVersion)")
            else {
                throw VoiceProviderEndpointError.invalidBaseUrl(baseString)
            }
            return VoiceRequestTarget(
                url: url,
                headers: [
                    "api-key": apiKey,
                    // Content-Type for multipart is set by the client with its boundary.
                ])
        case .realtime:
            let wsBase = self.httpSchemeToWebSocket(baseString)
            guard
                let url = URL(
                    string:
                    "\(wsBase)/openai/realtime?api-version=\(encodedApiVersion)&deployment=\(encodedDeployment)")
            else {
                throw VoiceProviderEndpointError.invalidBaseUrl(baseString)
            }
            return VoiceRequestTarget(
                url: url,
                headers: [
                    "api-key": apiKey,
                ])
        }
    }

    // MARK: - Helpers.

    private static func normalizedOpenAIBase(baseUrl: URL?) throws -> String {
        if let baseUrl {
            let raw = baseUrl.absoluteString
            let trimmed = self.trimmingTrailingSlashes(raw)
            if trimmed.isEmpty {
                throw VoiceProviderEndpointError.invalidBaseUrl(raw)
            }
            return trimmed
        }
        return self.trimmingTrailingSlashes(self.defaultOpenAIBaseUrl.absoluteString)
    }

    private static func trimmingTrailingSlashes(_ value: String) -> String {
        var v = value
        while v.hasSuffix("/") {
            v.removeLast()
        }
        return v
    }

    private static func httpSchemeToWebSocket(_ url: String) -> String {
        if url.hasPrefix("https://") {
            return "wss://" + url.dropFirst("https://".count)
        }
        if url.hasPrefix("http://") {
            return "ws://" + url.dropFirst("http://".count)
        }
        return url
    }

    /// Return the hostname-level base (no `/v1` suffix) for realtime WS URLs.
    /// Callers pass `wss://api.openai.com/v1` or `wss://api.openai.com`; both resolve
    /// to `wss://api.openai.com` so we can append `/v1/realtime?...` uniformly.
    private static func openAIRealtimeBase(wsBase: String) -> String {
        let trimmed = self.trimmingTrailingSlashes(wsBase)
        if trimmed.hasSuffix("/v1") {
            return String(trimmed.dropLast("/v1".count))
        }
        return trimmed
    }
}
