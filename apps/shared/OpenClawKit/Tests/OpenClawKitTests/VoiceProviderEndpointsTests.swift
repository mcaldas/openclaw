import Foundation
import OpenClawKit
import Testing

private let azureEndpoint = URL(string: "https://headstart-ai.openai.azure.com")!
private let azureApiVersion = "2025-03-20"

private func openaiCredentials() -> VoiceCredentials {
    VoiceCredentials(apiKey: "sk-fake-openai")
}

private func azureCredentials() -> VoiceCredentials {
    VoiceCredentials(
        apiKey: "azure-key-fake",
        azureEndpoint: azureEndpoint,
        azureApiVersion: azureApiVersion)
}

@Suite struct VoiceProviderEndpointsTests {
    @Test func openaiTTSUsesDefaultBaseAndBearerAuth() throws {
        let target = try VoiceProviderEndpoints.build(
            kind: .openai,
            capability: .tts,
            credentials: openaiCredentials(),
            model: "gpt-4o-mini-tts")
        #expect(target.url.absoluteString == "https://api.openai.com/v1/audio/speech")
        #expect(target.headers["Authorization"] == "Bearer sk-fake-openai")
        #expect(target.headers["Content-Type"] == "application/json")
    }

    @Test func openaiTranscribeUsesDefaultBaseAndBearerAuth() throws {
        let target = try VoiceProviderEndpoints.build(
            kind: .openai,
            capability: .transcribe,
            credentials: openaiCredentials(),
            model: "gpt-4o-transcribe")
        #expect(target.url.absoluteString == "https://api.openai.com/v1/audio/transcriptions")
        #expect(target.headers["Authorization"] == "Bearer sk-fake-openai")
        // Content-Type is set by the multipart client with its boundary; not here.
        #expect(target.headers["Content-Type"] == nil)
    }

    @Test func openaiRealtimeUsesWssAndBetaHeader() throws {
        let target = try VoiceProviderEndpoints.build(
            kind: .openai,
            capability: .realtime,
            credentials: openaiCredentials(),
            model: "gpt-realtime")
        #expect(
            target.url.absoluteString == "wss://api.openai.com/v1/realtime?model=gpt-realtime")
        #expect(target.headers["Authorization"] == "Bearer sk-fake-openai")
        #expect(target.headers["OpenAI-Beta"] == "realtime=v1")
    }

    @Test func openaiAcceptsCustomBaseUrlAndTrimsTrailingSlash() throws {
        let base = URL(string: "https://api.groq.com/openai/v1/")!
        let target = try VoiceProviderEndpoints.build(
            kind: .openai,
            capability: .tts,
            credentials: openaiCredentials(),
            model: "tts-1",
            baseUrl: base)
        #expect(target.url.absoluteString == "https://api.groq.com/openai/v1/audio/speech")
    }

    @Test func openaiRealtimeStripsV1SuffixFromCustomBase() throws {
        let base = URL(string: "https://example.internal/v1")!
        let target = try VoiceProviderEndpoints.build(
            kind: .openai,
            capability: .realtime,
            credentials: openaiCredentials(),
            model: "gpt-realtime",
            baseUrl: base)
        #expect(
            target.url.absoluteString == "wss://example.internal/v1/realtime?model=gpt-realtime")
    }

    @Test func azureTTSUsesDeploymentPathAndApiKeyHeader() throws {
        let target = try VoiceProviderEndpoints.build(
            kind: .azureOpenai,
            capability: .tts,
            credentials: azureCredentials(),
            model: "tts@001")
        // `@` is an allowed path character (Swift's URL preserves it), which the Azure
        // path accepts without percent-encoding.
        #expect(
            target.url.absoluteString ==
                "https://headstart-ai.openai.azure.com/openai/deployments/tts@001/audio/speech?api-version=2025-03-20")
        #expect(target.headers["api-key"] == "azure-key-fake")
        #expect(target.headers["Authorization"] == nil)
        #expect(target.headers["Content-Type"] == "application/json")
    }

    @Test func azureTranscribeUsesDeploymentPath() throws {
        let target = try VoiceProviderEndpoints.build(
            kind: .azureOpenai,
            capability: .transcribe,
            credentials: azureCredentials(),
            model: "gpt-4o-transcribe@2025-03-20")
        #expect(
            target.url.absoluteString ==
                "https://headstart-ai.openai.azure.com/openai/deployments/gpt-4o-transcribe@2025-03-20/audio/transcriptions?api-version=2025-03-20")
        #expect(target.headers["api-key"] == "azure-key-fake")
    }

    @Test func azureRealtimeUpgradesToWssAndAppendsDeploymentQuery() throws {
        let target = try VoiceProviderEndpoints.build(
            kind: .azureOpenai,
            capability: .realtime,
            credentials: azureCredentials(),
            model: "gpt-realtime-1-5@2026-02-23")
        #expect(
            target.url.absoluteString ==
                "wss://headstart-ai.openai.azure.com/openai/realtime?api-version=2025-03-20&deployment=gpt-realtime-1-5@2026-02-23")
        #expect(target.headers["api-key"] == "azure-key-fake")
    }

    @Test func throwsMissingApiKey() {
        let creds = VoiceCredentials(apiKey: "   ")
        #expect(throws: VoiceProviderEndpointError.missingApiKey) {
            try VoiceProviderEndpoints.build(
                kind: .openai,
                capability: .tts,
                credentials: creds,
                model: "gpt-4o-mini-tts")
        }
    }

    @Test func throwsMissingAzureEndpoint() {
        let creds = VoiceCredentials(apiKey: "k", azureEndpoint: nil, azureApiVersion: "v")
        #expect(throws: VoiceProviderEndpointError.missingAzureEndpoint) {
            try VoiceProviderEndpoints.build(
                kind: .azureOpenai,
                capability: .tts,
                credentials: creds,
                model: "tts")
        }
    }

    @Test func throwsMissingAzureApiVersion() {
        let creds = VoiceCredentials(
            apiKey: "k",
            azureEndpoint: azureEndpoint,
            azureApiVersion: nil)
        #expect(throws: VoiceProviderEndpointError.missingAzureApiVersion) {
            try VoiceProviderEndpoints.build(
                kind: .azureOpenai,
                capability: .tts,
                credentials: creds,
                model: "tts")
        }
    }

    @Test func throwsUnsupportedCapabilityForElevenLabs() {
        let creds = VoiceCredentials(apiKey: "k")
        #expect(throws: VoiceProviderEndpointError.self) {
            try VoiceProviderEndpoints.build(
                kind: .elevenlabs,
                capability: .tts,
                credentials: creds,
                model: "eleven_v3")
        }
    }
}
