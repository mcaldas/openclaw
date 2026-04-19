import Foundation
import OpenClawKit
import os
import Testing

// The runtime lives inside the iOS app target, but its dispatch logic is
// exercised indirectly here via `GatewayRealtimeTransport` + a scripted
// `RealtimeWebSocket`. The runtime itself is re-covered by the iOS test
// target when the app builds.
//
// These tests prove the codec -> transport -> server-event path produces
// the event types the runtime consumes, so a codec drift or a missing
// field surfaces in one place instead of across the whole stack.

@Suite struct TalkRealtimeTransportStreamingTests {
    @Test func transportEmitsSessionReadyEventFromScriptedWs() async throws {
        let frames = [
            #"{"type":"session.ready","voiceRunId":"r","sessionKey":"s","audio":{"sampleRateHz":24000,"format":"pcm16","channels":1}}"#
        ]
        let ws = ScriptedRealtimeWebSocket(frames: frames)
        let transport = try await startTransport(withFrames: ws)
        defer { Task { await transport.close() } }
        let stream = await transport.start()
        var iterator = stream.makeAsyncIterator()
        let event = try await iterator.next()
        #expect(
            event
                == .sessionReady(
                    voiceRunId: "r",
                    sessionKey: "s",
                    audio: GatewayRealtimeAudio(
                        sampleRateHz: 24_000, format: "pcm16", channels: 1)))
    }

    @Test func transportForwardsAudioDeltaAndTranscriptFinal() async throws {
        let frames = [
            #"{"type":"session.ready","voiceRunId":"r","sessionKey":"s","audio":{"sampleRateHz":24000,"format":"pcm16","channels":1}}"#,
            #"{"type":"response.audio.delta","audio":"AAAA"}"#,
            #"{"type":"conversation.item.input_audio_transcription.final","text":"hello"}"#,
        ]
        let ws = ScriptedRealtimeWebSocket(frames: frames)
        let transport = try await startTransport(withFrames: ws)
        defer { Task { await transport.close() } }
        var collected: [GatewayRealtimeServerEvent] = []
        for try await event in await transport.start() {
            collected.append(event)
            if collected.count == 3 { break }
        }
        #expect(collected.count == 3)
        #expect(collected[1] == .assistantAudioDelta(base64Pcm16: "AAAA"))
        #expect(collected[2] == .userTranscriptFinal(text: "hello"))
    }

    @Test func transportSurfacesToolCallFrames() async throws {
        let frames = [
            #"{"type":"session.ready","voiceRunId":"r","sessionKey":"s","audio":{"sampleRateHz":24000,"format":"pcm16","channels":1}}"#,
            #"{"type":"response.tool_call.started","callId":"c1","name":"lookup"}"#,
            #"{"type":"response.tool_call.finished","callId":"c1","name":"lookup","durationMs":12,"ok":true}"#,
        ]
        let ws = ScriptedRealtimeWebSocket(frames: frames)
        let transport = try await startTransport(withFrames: ws)
        defer { Task { await transport.close() } }
        var collected: [GatewayRealtimeServerEvent] = []
        for try await event in await transport.start() {
            collected.append(event)
            if collected.count == 3 { break }
        }
        #expect(collected[1] == .toolCallStarted(callId: "c1", name: "lookup"))
        #expect(
            collected[2]
                == .toolCallFinished(callId: "c1", name: "lookup", durationMs: 12, ok: true))
    }

    @Test func transportSurfacesMalformedFrameAsRecoverableError() async throws {
        let frames = [
            #"{"type":"session.ready","voiceRunId":"r","sessionKey":"s","audio":{"sampleRateHz":24000,"format":"pcm16","channels":1}}"#,
            "not-json-at-all",
        ]
        let ws = ScriptedRealtimeWebSocket(frames: frames)
        let transport = try await startTransport(withFrames: ws)
        defer { Task { await transport.close() } }
        var sawError = false
        for try await event in await transport.start() {
            if case .error(let code, _, let recoverable) = event {
                #expect(code == "malformed_frame")
                #expect(recoverable == true)
                sawError = true
                break
            }
        }
        #expect(sawError == true)
    }
}

// MARK: - Test helpers

private func startTransport(
    withFrames ws: ScriptedRealtimeWebSocket) async throws -> GatewayRealtimeTransport
{
    let issuer = ScriptedTicketIssuer()
    let config = GatewayRealtimeTransport.Config(
        gatewayWsBase: URL(string: "wss://gateway.test")!,
        ticketIssuer: issuer,
        reconnectPolicy: RealtimeReconnectPolicy(
            maxAttempts: 1, initialDelayMs: 0, multiplier: 1, capMs: 0),
        agentId: "main",
        providerId: nil,
        voiceId: nil,
        wsFactory: { _, _ in ws })
    return GatewayRealtimeTransport(config: config)
}

private struct ScriptedTicketIssuer: GatewayRealtimeTicketIssuing {
    func issue(agentId: String?, providerId: String?, voiceId: String?) async throws
        -> GatewayRealtimeTicket
    {
        _ = agentId
        _ = providerId
        _ = voiceId
        return GatewayRealtimeTicket(
            voiceRunId: "run-test",
            sessionKey: "agent:main:main",
            ticket: "tk-test",
            wsPath: "/talk/realtime",
            expiresAtMs: 9_999_999_999_999,
            audio: GatewayRealtimeAudio(sampleRateHz: 24_000, format: "pcm16", channels: 1))
    }
}

/// Minimal `RealtimeWebSocket` stub: queues `frames`, returns them on
/// successive `receive()` calls, then returns `nil` (clean close).
private final class ScriptedRealtimeWebSocket: RealtimeWebSocket, @unchecked Sendable {
    private let state: OSAllocatedUnfairLock<[String]>

    init(frames: [String]) {
        self.state = OSAllocatedUnfairLock(initialState: frames)
    }

    func connect() async throws {}

    func sendText(_ text: String) async throws { _ = text }

    func receive() async throws -> RealtimeWebSocketFrame? {
        let next = self.state.withLock { pending -> String? in
            guard !pending.isEmpty else { return nil }
            return pending.removeFirst()
        }
        guard let frame = next else { return nil }
        return .text(frame)
    }

    func close(code: RealtimeWebSocketCloseCode) async {
        self.state.withLock { pending in
            pending.removeAll()
        }
        _ = code
    }
}
