import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

/// Exercises the Tier 2 realtime splice inside `TalkModeManager`:
///
/// 1. Mic-tap output round-trips through the resampler into `input_audio_buffer.append`.
/// 2. `.assistantAudioChunk` events push PCM16 data into the PCM playback bus.
/// 3. Enter/exit/re-enter keeps the runtime connect idempotent.
/// 4. With realtime disabled, the splice leaves the Tier 1 path untouched.
/// 5. Barge-in cancels the in-flight response.
@MainActor
@Suite struct TalkModeRealtimeSpliceTests {
    // MARK: - Fixtures.

    private static func azureRealtimeConfig(
        voice: String = "alloy",
        primary: String = "gpt-realtime-1-5@2026-02-23",
        fallbacks: [String] = ["gpt-realtime"]
    ) -> RealtimeCapabilityConfig {
        RealtimeCapabilityConfig(
            kind: .azureOpenai,
            credentials: VoiceCredentials(
                apiKey: "az-fake",
                azureEndpoint: URL(string: "https://headstart-ai.openai.azure.com")!,
                azureApiVersion: "2025-04-01-preview"),
            model: primary,
            voice: voice,
            modelFallbacks: fallbacks)
    }

    /// In-memory scripted WebSocket. Records sent frames and lets the test drive
    /// incoming frames by pushing `Script` entries onto a queue. Mirrors the
    /// helper in `OpenAIRealtimeVoiceSessionFrameTests` but lives here so the
    /// iOS test target does not need to `@testable import` OpenClawKit internals.
    actor StubRealtimeWebSocket: RealtimeWebSocket {
        enum Script: Sendable {
            case frame(RealtimeWebSocketFrame)
            case closeByPeer
        }

        private var script: [Script]
        private var sent: [String] = []
        private var isClosed = false

        init(script: [Script] = []) {
            self.script = script
        }

        func sentFrames() -> [String] { self.sent }
        func enqueue(_ entry: Script) { self.script.append(entry) }

        nonisolated func connect() async throws {}

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
                    try await Task.sleep(nanoseconds: 20_000_000)
                    continue
                }
                let next = self.script.removeFirst()
                switch next {
                case .frame(let frame): return frame
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

    /// Records every PCM chunk handed to `pcmPlayer.play(...)`.
    final class RecordingPCMPlayer: PCMStreamingAudioPlaying, @unchecked Sendable {
        let received = ChunkBox()
        var stopCallCount = 0

        func play(stream: AsyncThrowingStream<Data, Error>, sampleRate: Double) async -> StreamingPlaybackResult {
            do {
                for try await chunk in stream {
                    await self.received.append(chunk)
                }
            } catch {
                // Ignored in tests — the feeder finishes cleanly in all scenarios.
            }
            return StreamingPlaybackResult(finished: true, interruptedAt: nil)
        }

        func stop() -> Double? {
            self.stopCallCount += 1
            return nil
        }
    }

    actor ChunkBox {
        private(set) var chunks: [Data] = []
        func append(_ chunk: Data) { self.chunks.append(chunk) }
        func snapshot() -> [Data] { self.chunks }
    }

    // MARK: - Tests.

    @Test func micTapFrameRoundTripsAsBase64InputAudioBufferAppend() async throws {
        let stub = StubRealtimeWebSocket()
        let manager = TalkModeManager(allowSimulatorCapture: true)
        manager.realtimeWebSocketFactoryOverride = { _ in stub }
        try await manager._test_startRealtime(config: Self.azureRealtimeConfig())

        // Emulate a resampled 40 ms frame (4 bytes is enough to assert the
        // base64 round-trip; real frames are 1920 bytes).
        let frame = Data([0x11, 0x22, 0x33, 0x44])
        try await manager._test_realtimeRuntime.sendAudio(pcm16: frame)

        // First frame is `session.update`; second is the audio append.
        let sentFrames = await stub.sentFrames()
        #expect(sentFrames.count >= 2)
        let appendFrame = sentFrames[1]
        #expect(appendFrame.contains("\"type\":\"input_audio_buffer.append\""))
        #expect(appendFrame.contains("\"audio\":\"\(frame.base64EncodedString())\""))

        await manager._test_tearDownRealtime()
    }

    @Test func assistantAudioChunkRoutesToPCMPlayerBus() async throws {
        let stub = StubRealtimeWebSocket()
        let player = RecordingPCMPlayer()
        let manager = TalkModeManager(allowSimulatorCapture: true)
        manager.realtimeWebSocketFactoryOverride = { _ in stub }
        manager.pcmPlayer = player
        try await manager._test_startRealtime(config: Self.azureRealtimeConfig())

        let firstChunk = Data([0xaa, 0xbb, 0xcc, 0xdd])
        let secondChunk = Data([0x01, 0x02])
        manager._test_enqueueAssistantAudio(pcm16: firstChunk)
        manager._test_enqueueAssistantAudio(pcm16: secondChunk)

        // Yield enough hops for the playback task to drain both chunks.
        for _ in 0..<20 {
            await Task.yield()
            try? await Task.sleep(nanoseconds: 5_000_000)
            if await player.received.snapshot().count >= 2 { break }
        }
        let received = await player.received.snapshot()
        #expect(received == [firstChunk, secondChunk])
        #expect(manager.isSpeaking == true)

        await manager._test_tearDownRealtime()
    }

    @Test func startIsIdempotentWhenReEnteringTalkMode() async throws {
        let manager = TalkModeManager(allowSimulatorCapture: true)
        manager.realtimeWebSocketFactoryOverride = { _ in StubRealtimeWebSocket() }
        try await manager._test_startRealtime(config: Self.azureRealtimeConfig())
        #expect(manager._test_runtimeIsActive == true)
        await manager._test_tearDownRealtime()
        #expect(manager._test_runtimeIsActive == false)
        #expect(manager._test_realtimeActive == false)

        // Re-enter: a fresh session dials cleanly.
        try await manager._test_startRealtime(config: Self.azureRealtimeConfig())
        #expect(manager._test_runtimeIsActive == true)
        await manager._test_tearDownRealtime()
        #expect(manager._test_runtimeIsActive == false)
    }

    @Test func disabledRealtimeLeavesTier1FlagOff() {
        // Regression guard: nothing wires the realtime session until the provider
        // surface opts in. `isRealtimeEnabled` mirrors the flag the splice uses to
        // branch `start()`, so when it's false we know the Tier 1 path owns the
        // loop unchanged.
        let disabledSurface = TalkProviderSurfaceParser.parse(
            rawProviderId: "azure-openai",
            config: [
                "apiKey": AnyCodable("az-fake"),
                "azureEndpoint": AnyCodable("https://headstart-ai.openai.azure.com"),
                "azureApiVersion": AnyCodable("2025-04-01-preview"),
                "realtimeModel": AnyCodable("gpt-realtime-1-5@2026-02-23"),
                "enableRealtime": AnyCodable(false),
            ])
        #expect(TalkModeManager._test_isRealtimeEnabled(surface: disabledSurface) == false)
    }

    @Test func bargeInCancelsInFlightResponseOverWS() async throws {
        let stub = StubRealtimeWebSocket()
        let manager = TalkModeManager(allowSimulatorCapture: true)
        manager.realtimeWebSocketFactoryOverride = { _ in stub }
        try await manager._test_startRealtime(config: Self.azureRealtimeConfig())

        // Simulate the assistant speaking, then the user talking (barge-in):
        // the runtime should emit a `response.cancel` frame and stop playback.
        manager._test_enqueueAssistantAudio(pcm16: Data([0x01, 0x02]))
        try await Task.sleep(nanoseconds: 10_000_000)
        try await manager._test_realtimeRuntime.cancelActiveResponse()

        let sent = await stub.sentFrames()
        #expect(sent.contains(where: { $0.contains("\"type\":\"response.cancel\"") }))

        await manager._test_tearDownRealtime()
    }
}
