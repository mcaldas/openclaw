import Foundation
import OpenClawKit
import os
import Testing
@testable import OpenClaw

/// Exercises the realtime-bridge splice inside `TalkModeManager`:
///
/// 1. Mic-tap output round-trips through the resampler into
///    `input_audio_buffer.append`.
/// 2. `.assistantAudioChunk` events push PCM16 data into the PCM
///    playback bus.
/// 3. Enter/exit/re-enter keeps the runtime connect idempotent.
/// 4. With the bridge flag disabled, the splice never starts.
/// 5. Barge-in cancels the in-flight response over the WS.
///
/// These tests adapt the sibling Tier 2 `TalkModeRealtimeSpliceTests`
/// pattern (sibling commit 919d2515e2) for `GatewayRealtimeTransport`.
@MainActor
@Suite struct TalkModeRealtimeSpliceTests {
    // MARK: - Fixtures.

    /// `nonisolated` so it can be called from `StubIssuer` (whose
    /// actor isolation must be `nonisolated` to satisfy the protocol).
    nonisolated static func stubTicket() -> GatewayRealtimeTicket {
        GatewayRealtimeTicket(
            voiceRunId: "run-test",
            sessionKey: "agent:main:main",
            ticket: "tk-test",
            wsPath: "/talk/realtime",
            expiresAtMs: 9_999_999_999_999,
            audio: GatewayRealtimeAudio(sampleRateHz: 24_000, format: "pcm16", channels: 1))
    }

    private struct StubIssuer: GatewayRealtimeTicketIssuing {
        func issue(agentId: String?, providerId: String?, voiceId: String?) async throws
            -> GatewayRealtimeTicket
        {
            _ = agentId
            _ = providerId
            _ = voiceId
            return TalkModeRealtimeSpliceTests.stubTicket()
        }
    }

    /// In-memory scripted WebSocket. Records sent frames and scripts
    /// incoming frames. Mirrors the pattern in the OpenClawKit tests so
    /// the splice can be exercised without opening a real socket.
    final class StubRealtimeWebSocket: RealtimeWebSocket, @unchecked Sendable {
        private let state: OSAllocatedUnfairLock<State>
        private struct State {
            var script: [RealtimeWebSocketFrame]
            var sent: [String] = []
            var isClosed: Bool = false
        }

        init(initialFrames: [RealtimeWebSocketFrame] = [
            .text(
                #"{"type":"session.ready","voiceRunId":"run-test","sessionKey":"agent:main:main","audio":{"sampleRateHz":24000,"format":"pcm16","channels":1}}"#)
        ]) {
            self.state = OSAllocatedUnfairLock(initialState: State(script: initialFrames))
        }

        func sentFrames() -> [String] { self.state.withLock { $0.sent } }

        func scriptCountIsEmpty() -> Bool { self.state.withLock { $0.script.isEmpty } }

        func enqueue(_ frame: RealtimeWebSocketFrame) {
            self.state.withLock { $0.script.append(frame) }
        }

        func connect() async throws {}

        func sendText(_ text: String) async throws {
            self.state.withLock { $0.sent.append(text) }
        }

        func receive() async throws -> RealtimeWebSocketFrame? {
            // Poll until a script entry is available or the socket is
            // closed. Keeps the main actor free between polls.
            while true {
                let popped = self.state.withLock { state -> RealtimeWebSocketFrame?? in
                    if state.isClosed { return RealtimeWebSocketFrame?.none }
                    if state.script.isEmpty { return nil as RealtimeWebSocketFrame?? }
                    return state.script.removeFirst()
                }
                if let decision = popped {
                    return decision
                }
                try await Task.sleep(nanoseconds: 10_000_000)
            }
        }

        func close(code: RealtimeWebSocketCloseCode) async {
            _ = code
            self.state.withLock { state in
                state.isClosed = true
                state.script.removeAll()
            }
        }
    }

    /// Records every PCM chunk handed to `pcmPlayer.play(...)`.
    final class RecordingPCMPlayer: PCMStreamingAudioPlaying, @unchecked Sendable {
        let received = ChunkBox()
        var stopCallCount = 0

        func play(stream: AsyncThrowingStream<Data, Error>, sampleRate: Double) async
            -> StreamingPlaybackResult
        {
            _ = sampleRate
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
        manager.realtimeTicketIssuerOverride = StubIssuer()
        manager.realtimeWsFactoryOverride = { _, _ in stub }
        try await manager._test_startRealtimeBridge()

        // `_test_startRealtimeBridge` returns as soon as the transport
        // task is kicked off; the transport flips to `.ready` only
        // after it receives `session.ready` from the scripted WS. Wait
        // for the ready signal before sending audio so the send lands.
        for _ in 0..<40 {
            await Task.yield()
            try? await Task.sleep(nanoseconds: 5_000_000)
            if stub.sentFrames().isEmpty == false { break }
            // The transport emits no outbound frames before ready, so
            // we use "peer returned session.ready" as the readiness
            // signal by checking the stub's remaining script.
            if stub.scriptCountIsEmpty() { break }
        }

        // Emulate a resampled 40 ms frame (4 bytes is enough to assert
        // the base64 round-trip; real frames are 1920 bytes).
        let frame = Data([0x11, 0x22, 0x33, 0x44])
        try await manager._test_realtimeRuntime.sendAudio(pcm16: frame)

        // Drain a few poll intervals so the send lands on the stub.
        for _ in 0..<20 {
            await Task.yield()
            try? await Task.sleep(nanoseconds: 5_000_000)
            if stub.sentFrames().contains(where: { $0.contains("input_audio_buffer.append") }) {
                break
            }
        }
        let sent = stub.sentFrames()
        let appendFrame = sent.first { $0.contains("input_audio_buffer.append") }
        #expect(appendFrame != nil)
        #expect(appendFrame?.contains(frame.base64EncodedString()) == true)

        await manager._test_tearDownRealtime()
    }

    @Test func assistantAudioChunkRoutesToPCMPlayerBus() async throws {
        let stub = StubRealtimeWebSocket()
        let player = RecordingPCMPlayer()
        let manager = TalkModeManager(allowSimulatorCapture: true)
        manager.realtimeTicketIssuerOverride = StubIssuer()
        manager.realtimeWsFactoryOverride = { _, _ in stub }
        manager.pcmPlayer = player
        try await manager._test_startRealtimeBridge()

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
        manager.realtimeTicketIssuerOverride = StubIssuer()
        manager.realtimeWsFactoryOverride = { _, _ in StubRealtimeWebSocket() }
        try await manager._test_startRealtimeBridge()
        #expect(manager._test_runtimeIsActive == true)
        await manager._test_tearDownRealtime()
        #expect(manager._test_runtimeIsActive == false)
        #expect(manager._test_realtimeActive == false)

        // Re-enter: a fresh session dials cleanly.
        try await manager._test_startRealtimeBridge()
        #expect(manager._test_runtimeIsActive == true)
        await manager._test_tearDownRealtime()
        #expect(manager._test_runtimeIsActive == false)
    }

    @Test func disabledRealtimeLeavesTier1FlagOff() {
        // Regression guard: by default, nothing wires the realtime
        // session. `_test_realtimeBridgeEnabled` mirrors the flag the
        // splice uses to branch `start()`, so when it's false we know
        // the Tier 1 path owns the loop unchanged.
        let manager = TalkModeManager(allowSimulatorCapture: true)
        #expect(manager._test_realtimeBridgeEnabled == false)
    }

    @Test func enabledFlagPropagatesFromParsedConfig() {
        // The parser must set the flag when
        // `talk.providers.<id>.realtimeBridge` is true in the payload
        // `reloadConfig()` receives from the gateway.
        let parsed = TalkModeGatewayConfigParser.parse(
            config: [
                "talk": [
                    "provider": "openai",
                    "providers": [
                        "openai": [
                            "apiKey": "fake",
                            "realtimeBridge": true,
                            "realtimeModel": "gpt-realtime-1-5",
                        ]
                    ],
                    "resolved": [
                        "provider": "openai",
                        "config": [
                            "apiKey": "fake",
                            "realtimeBridge": true,
                        ],
                    ],
                ]
            ],
            defaultProvider: "openai",
            defaultModelIdFallback: "gpt-realtime",
            defaultSilenceTimeoutMs: 900)
        #expect(parsed.realtimeBridgeEnabled == true)
    }

    @Test func bargeInCancelsInFlightResponseOverWS() async throws {
        let stub = StubRealtimeWebSocket()
        let manager = TalkModeManager(allowSimulatorCapture: true)
        manager.realtimeTicketIssuerOverride = StubIssuer()
        manager.realtimeWsFactoryOverride = { _, _ in stub }
        try await manager._test_startRealtimeBridge()

        manager._test_enqueueAssistantAudio(pcm16: Data([0x01, 0x02]))
        try await Task.sleep(nanoseconds: 10_000_000)
        try await manager._test_realtimeRuntime.cancelActiveResponse()

        // Drain so the cancel frame lands on the stub.
        for _ in 0..<10 {
            await Task.yield()
            try? await Task.sleep(nanoseconds: 5_000_000)
            if stub.sentFrames().contains(where: { $0.contains("response.cancel") }) { break }
        }
        let sent = stub.sentFrames()
        #expect(sent.contains(where: { $0.contains("\"type\":\"response.cancel\"") }))

        await manager._test_tearDownRealtime()
    }
}
