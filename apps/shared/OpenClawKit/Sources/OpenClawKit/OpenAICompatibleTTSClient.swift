import Foundation

public protocol StreamingTTSClient: Sendable {
    /// Streams audio bytes for the given text. Implementations MAY emit the entire
    /// buffer in a single `Data` element when the provider returns the full audio at
    /// once; downstream playback handles both cases.
    func streamSynthesize(
        text: String,
        config: TTSCapabilityConfig
    ) -> AsyncThrowingStream<Data, Error>
}

/// Minimal transport seam so tests can swap in a stub `URLSession`.
public protocol HTTPTransport: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: HTTPTransport {}

/// OpenAI + Azure OpenAI TTS via `POST /audio/speech`.
///
/// Both providers return the encoded audio buffer in the response body. We surface
/// the buffer as a single-element async stream so playback code treats this
/// identically to the ElevenLabs streaming client.
public struct OpenAICompatibleTTSClient: StreamingTTSClient, Sendable {
    public enum Constants {
        /// Conservative per-request timeout. OpenAI returns complete audio, so this
        /// covers generation latency for multi-paragraph prompts.
        public static let defaultTimeoutSeconds: TimeInterval = 60
    }

    private let transport: any HTTPTransport
    private let timeoutSeconds: TimeInterval

    public init(
        transport: any HTTPTransport = URLSession.shared,
        timeoutSeconds: TimeInterval = Constants.defaultTimeoutSeconds
    ) {
        self.transport = transport
        self.timeoutSeconds = timeoutSeconds
    }

    public func streamSynthesize(
        text: String,
        config: TTSCapabilityConfig
    ) -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { continuation in
            let task = Task { [timeoutSeconds, transport] in
                do {
                    let data = try await Self.synthesize(
                        text: text,
                        config: config,
                        transport: transport,
                        timeoutSeconds: timeoutSeconds)
                    if !Task.isCancelled {
                        continuation.yield(data)
                        continuation.finish()
                    } else {
                        continuation.finish(throwing: CancellationError())
                    }
                } catch is CancellationError {
                    continuation.finish(throwing: CancellationError())
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    /// Single-shot synthesize call. Exposed for tests.
    public static func synthesize(
        text: String,
        config: TTSCapabilityConfig,
        transport: any HTTPTransport,
        timeoutSeconds: TimeInterval = Constants.defaultTimeoutSeconds
    ) async throws -> Data {
        let target = try VoiceProviderEndpoints.build(
            kind: config.kind,
            capability: .tts,
            credentials: config.credentials,
            model: config.model,
            baseUrl: config.baseUrl)

        var request = URLRequest(url: target.url)
        request.httpMethod = "POST"
        request.timeoutInterval = timeoutSeconds
        for (field, value) in target.headers {
            request.setValue(value, forHTTPHeaderField: field)
        }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        request.httpBody = try Self.encodeRequestBody(text: text, config: config)

        let (data, response) = try await transport.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw VoiceProviderError(
                code: .badResponse,
                message: "Non-HTTP response from TTS endpoint")
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            let detail = Self.extractErrorDetail(data: data)
            let requestId =
                httpResponse.value(forHTTPHeaderField: "x-request-id")
                    ?? httpResponse.value(forHTTPHeaderField: "request-id")
                    ?? httpResponse.value(forHTTPHeaderField: "apim-request-id")
            throw VoiceProviderError(
                code: .server,
                httpStatus: httpResponse.statusCode,
                providerRequestId: requestId,
                message: detail ?? "TTS request failed")
        }
        return data
    }

    private static func encodeRequestBody(text: String, config: TTSCapabilityConfig) throws -> Data {
        // Build an ordered dict via a JSON object so the payload stays deterministic,
        // which matters for any prompt-cache-adjacent consumers and for test golden
        // output.
        var body: [String: Any] = [
            "model": config.model,
            "input": text,
            "voice": config.voice,
            "response_format": config.responseFormat.rawValue,
        ]
        if let speed = config.speed {
            body["speed"] = speed
        }
        if let instructions = config.instructions?.trimmingCharacters(in: .whitespacesAndNewlines),
           !instructions.isEmpty,
           Self.modelAcceptsInstructions(config.model)
        {
            body["instructions"] = instructions
        }
        return try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
    }

    /// Only the `gpt-4o-mini-tts` family honors the `instructions` field today (per
    /// OpenAI docs + the backend `resolveOpenAITtsInstructions` helper).
    private static func modelAcceptsInstructions(_ model: String) -> Bool {
        model.lowercased().contains("gpt-4o-mini-tts")
    }

    private static func extractErrorDetail(data: Data) -> String? {
        guard !data.isEmpty else { return nil }
        if
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let error = json["error"] as? [String: Any]
        {
            let message = error["message"] as? String
            let type = error["type"] as? String
            let code = error["code"] as? String
            var parts: [String] = []
            if let message, !message.isEmpty { parts.append(message) }
            var metadata: [String] = []
            if let type, !type.isEmpty { metadata.append("type=\(type)") }
            if let code, !code.isEmpty { metadata.append("code=\(code)") }
            if !metadata.isEmpty { parts.append("[\(metadata.joined(separator: ", "))]") }
            if !parts.isEmpty { return parts.joined(separator: " ") }
        }
        return String(data: data.prefix(512), encoding: .utf8)
    }
}
