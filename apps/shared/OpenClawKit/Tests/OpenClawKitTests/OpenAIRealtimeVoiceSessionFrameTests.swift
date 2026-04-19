import Foundation
import OpenClawKit
import Testing

/// In-memory scripted WebSocket used by the session actor tests. No network. Send
/// scripted frames through `enqueueIncoming(...)`; the session's `receive()` loop
/// pops them in order.
actor StubRealtimeWebSocket: RealtimeWebSocket {
    enum Script: Sendable {
        case frame(RealtimeWebSocketFrame)
        case throwError(RealtimeWebSocketError)
        case closeByPeer
    }

    private var script: [Script]
    private var sent: [String] = []
    private(set) var connectCount = 0
    private var isClosed = false
    private let connectResult: Result<Void, RealtimeWebSocketError>

    init(
        script: [Script] = [],
        connectResult: Result<Void, RealtimeWebSocketError> = .success(())
    ) {
        self.script = script
        self.connectResult = connectResult
    }

    func sentFrames() -> [String] { self.sent }

    func enqueue(_ script: Script) {
        self.script.append(script)
    }

    nonisolated func connect() async throws {
        await self.recordConnect()
        switch await self.connectResult {
        case .success: return
        case .failure(let error): throw error
        }
    }

    private func recordConnect() {
        self.connectCount += 1
    }

    nonisolated func sendText(_ text: String) async throws {
        await self.recordSend(text)
    }

    private func recordSend(_ text: String) {
        self.sent.append(text)
    }

    nonisolated func receive() async throws -> RealtimeWebSocketFrame? {
        try await self.popScript()
    }

    private func popScript() async throws -> RealtimeWebSocketFrame? {
        while !self.isClosed {
            if self.script.isEmpty {
                // Block forever; the test closes the socket when finished.
                try await Task.sleep(nanoseconds: 50_000_000)
                continue
            }
            let next = self.script.removeFirst()
            switch next {
            case .frame(let frame):
                return frame
            case .throwError(let error):
                throw error
            case .closeByPeer:
                self.isClosed = true
                return nil
            }
        }
        return nil
    }

    nonisolated func close(code: RealtimeWebSocketCloseCode) async {
        _ = code
        await self.markClosed()
    }

    private func markClosed() {
        self.isClosed = true
    }
}

private func testConfig(
    primary: String = "gpt-realtime-1-5",
    fallbacks: [String] = []
) -> RealtimeCapabilityConfig {
    RealtimeCapabilityConfig(
        kind: .azureOpenai,
        credentials: VoiceCredentials(
            apiKey: "fake",
            azureEndpoint: URL(string: "https://example.openai.azure.com")!,
            azureApiVersion: "2025-04-01-preview"),
        model: primary,
        voice: "alloy",
        modelFallbacks: fallbacks)
}

@Suite struct OpenAIRealtimeVoiceSessionFrameTests {
    @Test func sessionUpdatePayloadIsDeterministicAndMatchesSpec() {
        let stub = StubRealtimeWebSocket()
        let session = OpenAIRealtimeVoiceSession(
            config: testConfig(),
            factory: { _ in stub })
        let data = session.makeSessionUpdatePayload()
        let text = String(data: data, encoding: .utf8)!
        // Keys sorted alphabetically by JSONSerialization.sortedKeys.
        #expect(text.contains("\"input_audio_format\":\"pcm16\""))
        #expect(text.contains("\"output_audio_format\":\"pcm16\""))
        #expect(text.contains("\"voice\":\"alloy\""))
        // Default is semantic_vad with a 700ms silence window — the echo-loop fix.
        #expect(text.contains("\"type\":\"semantic_vad\""))
        #expect(text.contains("\"threshold\":0.5"))
        #expect(text.contains("\"silence_duration_ms\":700"))
        #expect(text.contains("\"prefix_padding_ms\":300"))
        #expect(text.contains("\"create_response\":true"))
        #expect(text.contains("\"model\":\"whisper-1\""))
        // Second call produces byte-identical output (no timestamps or UUIDs).
        let data2 = session.makeSessionUpdatePayload()
        #expect(data == data2)
    }

    @Test func turnDetectionOverrideToServerVadWithLongerSilence() {
        let stub = StubRealtimeWebSocket()
        let turnDetection = OpenAIRealtimeVoiceSession.TurnDetectionConfig.default
            .overriding(kind: .serverVad, silenceDurationMs: 1200)
        let session = OpenAIRealtimeVoiceSession(
            config: testConfig(),
            factory: { _ in stub },
            turnDetection: turnDetection)
        let text = String(data: session.makeSessionUpdatePayload(), encoding: .utf8)!
        #expect(text.contains("\"type\":\"server_vad\""))
        #expect(text.contains("\"silence_duration_ms\":1200"))
        // Prefix padding + threshold should keep their defaults after override.
        #expect(text.contains("\"threshold\":0.5"))
        #expect(text.contains("\"prefix_padding_ms\":300"))
    }

    @Test func turnDetectionKindParsesLenientStrings() {
        #expect(OpenAIRealtimeVoiceSession.TurnDetectionKind.from(rawString: "server_vad") == .serverVad)
        #expect(OpenAIRealtimeVoiceSession.TurnDetectionKind.from(rawString: "Semantic") == .semanticVad)
        #expect(OpenAIRealtimeVoiceSession.TurnDetectionKind.from(rawString: "serverVAD") == .serverVad)
        #expect(OpenAIRealtimeVoiceSession.TurnDetectionKind.from(rawString: "chaos") == nil)
        #expect(OpenAIRealtimeVoiceSession.TurnDetectionKind.from(rawString: nil) == nil)
    }

    @Test func sessionUpdateIncludesInstructionsWhenProvided() {
        let stub = StubRealtimeWebSocket()
        let session = OpenAIRealtimeVoiceSession(
            config: testConfig(),
            factory: { _ in stub },
            instructions: "Persona for Mathias")
        let text = String(data: session.makeSessionUpdatePayload(), encoding: .utf8)!
        #expect(text.contains("\"instructions\":\"Persona for Mathias\""))
    }

    @Test func sessionUpdateUsesBuiltInDefaultInstructionsWhenNothingPassed() {
        let stub = StubRealtimeWebSocket()
        // Use the default parameter — the built-in persona should be wired.
        let session = OpenAIRealtimeVoiceSession(
            config: testConfig(),
            factory: { _ in stub })
        let text = String(data: session.makeSessionUpdatePayload(), encoding: .utf8)!
        #expect(text.contains("\"instructions\":"))
        #expect(text.contains("OpenClaw assistant"))
    }

    @Test func sessionUpdateOmitsInstructionsWhenExplicitlyNil() {
        let stub = StubRealtimeWebSocket()
        // Explicit nil is the opt-out path: the session omits the field entirely
        // so the server-side default persona applies.
        let session = OpenAIRealtimeVoiceSession(
            config: testConfig(),
            factory: { _ in stub },
            instructions: nil)
        let text = String(data: session.makeSessionUpdatePayload(), encoding: .utf8)!
        #expect(!text.contains("\"instructions\""))
    }

    @Test func sessionUpdateOmitsInstructionsWhenExplicitlyEmpty() {
        let stub = StubRealtimeWebSocket()
        let session = OpenAIRealtimeVoiceSession(
            config: testConfig(),
            factory: { _ in stub },
            instructions: "   ")
        let text = String(data: session.makeSessionUpdatePayload(), encoding: .utf8)!
        // Whitespace-only opt-out should not leak into the payload.
        #expect(!text.contains("\"instructions\""))
    }

    @Test func assistantAudioDeltaIsBase64DecodedToPCM16() async throws {
        let stub = StubRealtimeWebSocket(script: [
            .frame(.text(Self.assistantAudioDeltaFrame(bytes: [0x01, 0x02, 0x03, 0x04]))),
            .closeByPeer,
        ])
        let session = OpenAIRealtimeVoiceSession(
            config: testConfig(),
            factory: { _ in stub })
        try await session.connect()
        var audioChunks: [Data] = []
        for await event in session.events {
            switch event {
            case .assistantAudioChunk(let data):
                audioChunks.append(data)
            case .closed:
                break
            default:
                continue
            }
        }
        #expect(audioChunks == [Data([0x01, 0x02, 0x03, 0x04])])
    }

    @Test func inputAudioAppendUsesBase64PayloadShape() async throws {
        let stub = StubRealtimeWebSocket()
        let session = OpenAIRealtimeVoiceSession(
            config: testConfig(),
            factory: { _ in stub })
        try await session.connect()
        try await session.sendAudio(pcm16: Data([0x10, 0x20, 0x30, 0x40]))
        let frames = await stub.sentFrames()
        // First frame is `session.update`; second is the audio append.
        #expect(frames.count >= 2)
        let appendFrame = frames[1]
        #expect(appendFrame.contains("\"type\":\"input_audio_buffer.append\""))
        #expect(appendFrame.contains("\"audio\":\"\(Data([0x10, 0x20, 0x30, 0x40]).base64EncodedString())\""))
        await session.close()
    }

    @Test func transcriptEventsFlowThroughStream() async throws {
        let stub = StubRealtimeWebSocket(script: [
            .frame(.text(#"{"type":"conversation.item.input_audio_transcription.delta","delta":"he"}"#)),
            .frame(.text(#"{"type":"conversation.item.input_audio_transcription.delta","delta":"llo"}"#)),
            .frame(.text(#"{"type":"conversation.item.input_audio_transcription.completed","transcript":"hello"}"#)),
            .closeByPeer,
        ])
        let session = OpenAIRealtimeVoiceSession(
            config: testConfig(),
            factory: { _ in stub })
        try await session.connect()

        var partials: [String] = []
        var finals: [String] = []
        for await event in session.events {
            switch event {
            case .partialTranscript(let text): partials.append(text)
            case .finalTranscript(let text): finals.append(text)
            case .closed: break
            default: continue
            }
        }
        #expect(partials == ["he", "llo"])
        #expect(finals == ["hello"])
    }

    @Test func cancelActiveResponseEmitsResponseCancelFrame() async throws {
        let stub = StubRealtimeWebSocket()
        let session = OpenAIRealtimeVoiceSession(
            config: testConfig(),
            factory: { _ in stub })
        try await session.connect()
        try await session.cancelActiveResponse()
        let frames = await stub.sentFrames()
        // First frame is `session.update`; second is the cancel frame.
        #expect(frames.count >= 2)
        let cancelFrame = frames[1]
        #expect(cancelFrame.contains("\"type\":\"response.cancel\""))
        await session.close()
    }

    @Test func fallbackActivatedWhenPrimaryFailsWithAbnormalClose() async {
        let dialLog = DialLog()
        let factory: RealtimeWebSocketFactory = { deployment in
            Task { await dialLog.append(deployment) }
            if deployment == "gpt-realtime-1-5" {
                return StubRealtimeWebSocket(
                    connectResult: .failure(RealtimeWebSocketError(
                        kind: .closedAbnormally,
                        message: "remote dropped tcp")))
            }
            return StubRealtimeWebSocket(script: [.closeByPeer])
        }
        let config = testConfig(
            primary: "gpt-realtime-1-5",
            fallbacks: ["gpt-realtime"])
        let session = OpenAIRealtimeVoiceSession(
            config: config,
            factory: factory,
            sleep: { _ in })
        do {
            try await session.connect()
        } catch {
            // Secondary dials also close — we expect the connect attempt chain,
            // not a successful session, but the fallback event should be emitted
            // first.
        }
        var sawFallback = false
        for await event in session.events {
            if case .fallbackActivated(let from, let to, _) = event {
                sawFallback = (from == "gpt-realtime-1-5" && to == "gpt-realtime")
                break
            }
            if case .closed = event { break }
        }
        #expect(sawFallback == true)
    }
}

private actor DialLog {
    private(set) var dials: [String] = []
    func append(_ value: String) { self.dials.append(value) }
}

private extension OpenAIRealtimeVoiceSessionFrameTests {
    static func assistantAudioDeltaFrame(bytes: [UInt8]) -> String {
        let b64 = Data(bytes).base64EncodedString()
        return "{\"type\":\"response.audio.delta\",\"delta\":\"\(b64)\"}"
    }
}
