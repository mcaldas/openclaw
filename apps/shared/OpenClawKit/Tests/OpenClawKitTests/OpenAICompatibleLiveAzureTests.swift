import Foundation
import OpenClawKit
import Testing

/// Live Azure OpenAI smoke tests.
///
/// Gated on `OPENCLAW_LIVE_AZURE=1` + the canonical `OPENCLAW_AZURE_*` env vars
/// (identical set to `.agent-env` on the iOS-voice worktree). When the gate is
/// absent the tests no-op, so running the regular OpenClawKit test suite does
/// not hit the network.
///
/// Run locally with:
///
/// ```
/// set -a; source /path/to/.agent-env; set +a
/// OPENCLAW_LIVE_AZURE=1 swift test --filter OpenAICompatibleLiveAzureTests
/// ```
@Suite struct OpenAICompatibleLiveAzureTests {
    @Test func azureTTSProducesAudioAndTranscribeRoundTripsText() async throws {
        let env = ProcessInfo.processInfo.environment
        guard env["OPENCLAW_LIVE_AZURE"] == "1" else {
            return // gate off, skip silently
        }
        let apiKey = try Self.requireEnv("OPENCLAW_AZURE_OPENAI_KEY", env: env)
        let endpointRaw = try Self.requireEnv("OPENCLAW_AZURE_OPENAI_ENDPOINT", env: env)
        let ttsDep = try Self.requireEnv("OPENCLAW_AZURE_TTS_DEPLOYMENT", env: env)
        let sttDep = try Self.requireEnv("OPENCLAW_AZURE_TRANSCRIBE_DEPLOYMENT", env: env)
        let ttsApi = try Self.requireEnv("OPENCLAW_AZURE_API_VERSION_TTS", env: env)
        let sttApi = try Self.requireEnv("OPENCLAW_AZURE_API_VERSION_TRANSCRIBE", env: env)
        let endpoint = try #require(URL(string: endpointRaw))

        let phrase = "Tier one smoke test. The time is now ten past five."

        // --- TTS ---
        let ttsConfig = TTSCapabilityConfig(
            kind: .azureOpenai,
            credentials: VoiceCredentials(
                apiKey: apiKey,
                azureEndpoint: endpoint,
                azureApiVersion: ttsApi),
            model: ttsDep,
            voice: "alloy",
            responseFormat: .mp3)
        let audio = try await OpenAICompatibleTTSClient.synthesize(
            text: phrase,
            config: ttsConfig,
            transport: URLSession.shared,
            timeoutSeconds: 45)
        print("[tier1-live] tts bytes=\(audio.count)")
        #expect(audio.count > 1_000, "Azure TTS should return a non-trivial audio blob")

        let outPath = "/tmp/tier1-live-tts.mp3"
        try audio.write(to: URL(fileURLWithPath: outPath))

        // --- STT (round-trip the generated audio) ---
        let sttConfig = STTCapabilityConfig(
            kind: .azureOpenai,
            credentials: VoiceCredentials(
                apiKey: apiKey,
                azureEndpoint: endpoint,
                azureApiVersion: sttApi),
            model: sttDep,
            language: "en")

        let transcription = try await OpenAICompatibleTranscriptionClient().transcribe(
            audio: audio,
            contentType: "audio/mpeg",
            filename: "tier1-live.mp3",
            config: sttConfig)
        print("[tier1-live] stt text=\"\(transcription.text)\"")
        #expect(!transcription.text.isEmpty, "Azure transcription should return non-empty text")

        // Loose content assertion: we expect at least one of the two distinctive
        // anchor words to round-trip. Exact phrasing varies by model.
        let lowered = transcription.text.lowercased()
        #expect(
            lowered.contains("tier") || lowered.contains("smoke") ||
                lowered.contains("ten") || lowered.contains("time"),
            "Round-trip transcript should contain at least one anchor word from the input")
    }

    private static func requireEnv(_ key: String, env: [String: String]) throws -> String {
        guard let value = env[key], !value.isEmpty else {
            Issue.record("missing env var \(key); did you source .agent-env?")
            throw NSError(domain: "OpenAICompatibleLiveAzureTests", code: 1)
        }
        return value
    }
}
