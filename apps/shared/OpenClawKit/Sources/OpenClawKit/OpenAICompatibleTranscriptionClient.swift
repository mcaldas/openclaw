import Foundation

public struct VoiceTranscription: Sendable, Equatable {
    public let text: String
    public let language: String?

    public init(text: String, language: String? = nil) {
        self.text = text
        self.language = language
    }
}

public protocol VoiceTranscriptionClient: Sendable {
    func transcribe(
        audio: Data,
        contentType: String,
        filename: String,
        config: STTCapabilityConfig
    ) async throws -> VoiceTranscription
}

/// Multipart-form `POST /audio/transcriptions` client for OpenAI + Azure OpenAI.
///
/// For Tier 1 this sits alongside (not replacing) the on-device `SFSpeechRecognizer`
/// pipeline. `TalkModeManager` opts in via an explicit `useServerTranscribe` flag.
public struct OpenAICompatibleTranscriptionClient: VoiceTranscriptionClient, Sendable {
    public enum Constants {
        public static let defaultTimeoutSeconds: TimeInterval = 30
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

    public func transcribe(
        audio: Data,
        contentType: String,
        filename: String,
        config: STTCapabilityConfig
    ) async throws -> VoiceTranscription {
        let target = try VoiceProviderEndpoints.build(
            kind: config.kind,
            capability: .transcribe,
            credentials: config.credentials,
            model: config.model,
            baseUrl: config.baseUrl)

        let boundary = "openclaw-voice-\(UUID().uuidString)"
        var request = URLRequest(url: target.url)
        request.httpMethod = "POST"
        request.timeoutInterval = timeoutSeconds
        for (field, value) in target.headers {
            request.setValue(value, forHTTPHeaderField: field)
        }
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        request.httpBody = Self.encodeMultipart(
            boundary: boundary,
            audio: audio,
            audioContentType: contentType,
            filename: filename,
            model: config.model,
            language: config.language)

        let (data, response) = try await transport.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw VoiceProviderError(
                code: .badResponse,
                message: "Non-HTTP response from transcribe endpoint")
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            let requestId =
                httpResponse.value(forHTTPHeaderField: "x-request-id")
                    ?? httpResponse.value(forHTTPHeaderField: "request-id")
                    ?? httpResponse.value(forHTTPHeaderField: "apim-request-id")
            throw VoiceProviderError(
                code: .server,
                httpStatus: httpResponse.statusCode,
                providerRequestId: requestId,
                message: Self.extractErrorDetail(data: data) ?? "Transcribe request failed")
        }
        return try Self.decodeResponse(data: data)
    }

    public static func encodeMultipart(
        boundary: String,
        audio: Data,
        audioContentType: String,
        filename: String,
        model: String,
        language: String?
    ) -> Data {
        var body = Data()
        let boundaryDelimiter = "--\(boundary)\r\n"

        // model
        body.append(boundaryDelimiter.data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"model\"\r\n\r\n".data(using: .utf8)!)
        body.append(model.data(using: .utf8)!)
        body.append("\r\n".data(using: .utf8)!)

        // optional language
        if let language = language?.trimmingCharacters(in: .whitespacesAndNewlines), !language.isEmpty {
            body.append(boundaryDelimiter.data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"language\"\r\n\r\n".data(using: .utf8)!)
            body.append(language.data(using: .utf8)!)
            body.append("\r\n".data(using: .utf8)!)
        }

        // response_format=json (explicit; Azure may default to verbose_json)
        body.append(boundaryDelimiter.data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"response_format\"\r\n\r\n".data(using: .utf8)!)
        body.append("json".data(using: .utf8)!)
        body.append("\r\n".data(using: .utf8)!)

        // audio file
        body.append(boundaryDelimiter.data(using: .utf8)!)
        body.append(
            "Content-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n"
                .data(using: .utf8)!)
        body.append("Content-Type: \(audioContentType)\r\n\r\n".data(using: .utf8)!)
        body.append(audio)
        body.append("\r\n".data(using: .utf8)!)

        body.append("--\(boundary)--\r\n".data(using: .utf8)!)
        return body
    }

    private static func decodeResponse(data: Data) throws -> VoiceTranscription {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw VoiceProviderError(
                code: .badResponse,
                message: "Could not decode transcribe response body")
        }
        let text = (json["text"] as? String) ?? ""
        let language = json["language"] as? String
        return VoiceTranscription(text: text, language: language)
    }

    private static func extractErrorDetail(data: Data) -> String? {
        guard !data.isEmpty else { return nil }
        if
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let error = json["error"] as? [String: Any]
        {
            let message = error["message"] as? String
            let code = error["code"] as? String
            var parts: [String] = []
            if let message, !message.isEmpty { parts.append(message) }
            if let code, !code.isEmpty { parts.append("[code=\(code)]") }
            if !parts.isEmpty { return parts.joined(separator: " ") }
        }
        return String(data: data.prefix(512), encoding: .utf8)
    }
}
