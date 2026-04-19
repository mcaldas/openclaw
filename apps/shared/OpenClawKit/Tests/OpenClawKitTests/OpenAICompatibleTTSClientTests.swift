import Foundation
import OpenClawKit
import Testing

private struct StubbedTransportError: Error {}

private final class StubTransport: HTTPTransport, @unchecked Sendable {
    struct Response: Sendable {
        let status: Int
        let body: Data
        let headers: [String: String]
    }

    private let queue = DispatchQueue(label: "StubTransport.queue")
    private var responses: [Response]
    private var recordedRequests: [URLRequest] = []

    init(responses: [Response]) {
        self.responses = responses
    }

    var requests: [URLRequest] {
        self.queue.sync { self.recordedRequests }
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        let next: Response? = self.queue.sync {
            self.recordedRequests.append(request)
            if self.responses.isEmpty { return nil }
            return self.responses.removeFirst()
        }
        guard let next else { throw StubbedTransportError() }
        guard let url = request.url else { throw StubbedTransportError() }
        let response = HTTPURLResponse(
            url: url,
            statusCode: next.status,
            httpVersion: "HTTP/1.1",
            headerFields: next.headers)!
        return (next.body, response)
    }
}

private func sampleOpenAIConfig() -> TTSCapabilityConfig {
    TTSCapabilityConfig(
        kind: .openai,
        credentials: VoiceCredentials(apiKey: "sk-fake"),
        model: "gpt-4o-mini-tts",
        voice: "coral",
        responseFormat: .pcm,
        instructions: "Speak warmly.",
        speed: 1.1,
        baseUrl: nil)
}

private func sampleAzureConfig() -> TTSCapabilityConfig {
    TTSCapabilityConfig(
        kind: .azureOpenai,
        credentials: VoiceCredentials(
            apiKey: "azure-key",
            azureEndpoint: URL(string: "https://headstart-ai.openai.azure.com")!,
            azureApiVersion: "2025-03-20"),
        model: "tts@001",
        voice: "alloy",
        responseFormat: .mp3)
}

@Suite struct OpenAICompatibleTTSClientTests {
    @Test func sendsExpectedOpenAIRequestBodyAndReturnsAudio() async throws {
        let audio = Data([0xFF, 0xFA, 0x00, 0x01, 0x02, 0x03])
        let transport = StubTransport(responses: [
            .init(status: 200, body: audio, headers: ["Content-Type": "audio/mpeg"]),
        ])
        let client = OpenAICompatibleTTSClient(transport: transport, timeoutSeconds: 5)

        let stream = client.streamSynthesize(text: "Hi there.", config: sampleOpenAIConfig())
        var chunks: [Data] = []
        for try await chunk in stream {
            chunks.append(chunk)
        }
        #expect(chunks.count == 1)
        #expect(chunks.first == audio)

        let request = transport.requests.first!
        #expect(request.url?.absoluteString == "https://api.openai.com/v1/audio/speech")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer sk-fake")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        let body = try #require(request.httpBody)
        let parsed = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        #expect((parsed?["model"] as? String) == "gpt-4o-mini-tts")
        #expect((parsed?["voice"] as? String) == "coral")
        #expect((parsed?["input"] as? String) == "Hi there.")
        #expect((parsed?["response_format"] as? String) == "pcm")
        #expect((parsed?["speed"] as? Double) == 1.1)
        #expect((parsed?["instructions"] as? String) == "Speak warmly.")
    }

    @Test func azureTargetUsesApiKeyHeaderAndDeploymentPath() async throws {
        let audio = Data([0x01, 0x02])
        let transport = StubTransport(responses: [
            .init(status: 200, body: audio, headers: [:]),
        ])
        let client = OpenAICompatibleTTSClient(transport: transport, timeoutSeconds: 5)

        var chunks: [Data] = []
        for try await chunk in client.streamSynthesize(text: "Hello.", config: sampleAzureConfig()) {
            chunks.append(chunk)
        }
        #expect(chunks.first == audio)

        let request = transport.requests.first!
        #expect(request.value(forHTTPHeaderField: "api-key") == "azure-key")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        let expectedUrl =
            "https://headstart-ai.openai.azure.com/openai/deployments/tts@001/audio/speech?api-version=2025-03-20"
        #expect(request.url?.absoluteString == expectedUrl)
    }

    @Test func surfaces4xxErrorsWithProviderRequestId() async throws {
        let errorBody = try JSONSerialization.data(withJSONObject: [
            "error": [
                "message": "Invalid voice 'garbage'",
                "type": "invalid_request_error",
                "code": "invalid_voice",
            ],
        ])
        let transport = StubTransport(responses: [
            .init(
                status: 400,
                body: errorBody,
                headers: ["x-request-id": "req_123"]),
        ])
        let client = OpenAICompatibleTTSClient(transport: transport, timeoutSeconds: 5)

        var caught: VoiceProviderError?
        do {
            for try await _ in client.streamSynthesize(text: "Hi.", config: sampleOpenAIConfig()) {}
        } catch let error as VoiceProviderError {
            caught = error
        } catch {
            Issue.record("unexpected error: \(error)")
        }
        let error = try #require(caught)
        #expect(error.code == .server)
        #expect(error.httpStatus == 400)
        #expect(error.providerRequestId == "req_123")
        #expect(error.message.contains("Invalid voice"))
        #expect(error.message.contains("invalid_voice"))
    }

    @Test func omitsInstructionsForNonMiniTtsModel() async throws {
        let audio = Data([0xAA])
        let transport = StubTransport(responses: [
            .init(status: 200, body: audio, headers: [:]),
        ])
        let client = OpenAICompatibleTTSClient(transport: transport, timeoutSeconds: 5)

        var config = sampleOpenAIConfig()
        config = TTSCapabilityConfig(
            kind: config.kind,
            credentials: config.credentials,
            model: "tts-1",
            voice: config.voice,
            responseFormat: .mp3,
            instructions: "ignored",
            speed: nil)

        for try await _ in client.streamSynthesize(text: "Hi.", config: config) {}

        let request = transport.requests.first!
        let parsed =
            try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
        #expect(parsed?["instructions"] == nil)
        #expect(parsed?["speed"] == nil)
    }
}
