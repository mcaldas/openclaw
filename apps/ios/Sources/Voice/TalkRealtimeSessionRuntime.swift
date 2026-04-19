import Foundation
import OpenClawKit
import OpenClawProtocol
import OSLog

/// Thin `@MainActor` facade around `GatewayRealtimeTransport` that pipes the
/// gateway's event stream into the iOS talk loop.
///
/// Responsibilities:
/// - Own the active `GatewayRealtimeTransport` actor.
/// - Subscribe to its event stream and forward decoded events to a delegate
///   consumed by `TalkModeManager`:
///   - assistant PCM16 chunks -> playback feeder
///   - transcripts + state -> UI
///   - tool call started/finished -> UI hint surface
/// - Forward mic PCM16 frames from the capture side into the transport.
///
/// This runtime does not know about AVAudioEngine, `PCMStreamingAudioPlayer`,
/// or the resampler directly; it sits between the talk manager (which owns
/// audio I/O) and the gateway transport (which owns the WS protocol). The
/// splice keeps audio-unit responsibilities in the manager and transport-
/// protocol responsibilities here, so each can be tested in isolation.
///
/// The runtime is intentionally small so it can be exercised from unit tests
/// that do not need to touch AVAudioEngine: inject a `GatewayRealtimeTransport`
/// whose ticket issuer returns a scripted response and whose `wsFactory`
/// returns a scripted `RealtimeWebSocket`.
@MainActor
public final class TalkRealtimeSessionRuntime {
    public struct Delegate: Sendable {
        public var onSessionReady: @Sendable (_ voiceRunId: String, _ sessionKey: String) -> Void = { _, _ in }
        public var onPartialTranscript: @Sendable (_ text: String) -> Void = { _ in }
        public var onFinalTranscript: @Sendable (_ text: String) -> Void = { _ in }
        public var onAssistantTextDelta: @Sendable (_ text: String) -> Void = { _ in }
        public var onAssistantTextDone: @Sendable (_ text: String) -> Void = { _ in }
        public var onAssistantAudioChunk: @Sendable (_ pcm16: Data) -> Void = { _ in }
        public var onAssistantAudioDone: @Sendable () -> Void = {}
        public var onToolCallStarted: @Sendable (_ callId: String, _ name: String) -> Void = { _, _ in }
        public var onToolCallFinished:
            @Sendable (_ callId: String, _ name: String, _ durationMs: Double, _ ok: Bool) -> Void = {
                _, _, _, _ in
            }
        public var onFallbackActivated:
            @Sendable (_ from: String, _ to: String, _ reason: String) -> Void = { _, _, _ in }
        public var onError: @Sendable (_ code: String, _ message: String, _ recoverable: Bool) -> Void =
            { _, _, _ in }
        public var onClosed: @Sendable (_ reason: String, _ code: Int) -> Void = { _, _ in }

        public init() {}
    }

    public struct Config: Sendable {
        public let gatewayWsBase: URL
        public let agentId: String?
        public let providerId: String?
        public let voiceId: String?
        public let reconnectPolicy: RealtimeReconnectPolicy

        public init(
            gatewayWsBase: URL,
            agentId: String? = nil,
            providerId: String? = nil,
            voiceId: String? = nil,
            reconnectPolicy: RealtimeReconnectPolicy = .default)
        {
            self.gatewayWsBase = gatewayWsBase
            self.agentId = agentId
            self.providerId = providerId
            self.voiceId = voiceId
            self.reconnectPolicy = reconnectPolicy
        }
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "TalkRealtime")
    private var transport: GatewayRealtimeTransport?
    private var consumerTask: Task<Void, Never>?

    public var delegate: Delegate = Delegate()

    public init() {}

    /// Start a realtime session. Returns after the transport begins dialing;
    /// the `onSessionReady` delegate fires once the gateway responds with
    /// `session.ready`.
    ///
    /// `ticketIssuer` is the gateway RPC that mints a realtime ticket; real
    /// callers pass `GatewayRealtimeTicketIssuer(request: channel.request)`.
    /// Tests can inject a scripted issuer.
    public func start(
        config: Config,
        ticketIssuer: GatewayRealtimeTicketIssuing,
        wsFactory: (@Sendable (_ url: URL, _ headers: [String: String]) -> RealtimeWebSocket)? = nil)
        async throws
    {
        await self.stopIfActive()
        let transportConfig = GatewayRealtimeTransport.Config(
            gatewayWsBase: config.gatewayWsBase,
            ticketIssuer: ticketIssuer,
            reconnectPolicy: config.reconnectPolicy,
            agentId: config.agentId,
            providerId: config.providerId,
            voiceId: config.voiceId,
            wsFactory: wsFactory
                ?? { url, headers in URLSessionRealtimeWebSocket(url: url, headers: headers) })
        let transport = GatewayRealtimeTransport(config: transportConfig)
        self.transport = transport
        let stream = await transport.start()
        self.consumerTask = Task { [weak self] in
            await self?.consume(stream: stream)
        }
    }

    /// Send a mic-captured PCM16 24 kHz mono little-endian frame to the
    /// gateway. Callers should produce frames via `RealtimeAudioResampler`
    /// so the sample rate always matches the gateway's advertised format.
    public func sendAudio(pcm16: Data) async throws {
        guard let transport = self.transport else {
            throw GatewayRealtimeTransportError.noGatewayHost
        }
        let base64 = pcm16.base64EncodedString()
        try await transport.send(.inputAudioAppend(base64Pcm16: base64))
    }

    /// Barge-in: cancel the in-flight assistant response. Mapped to the
    /// gateway's `response.cancel` client event. Safe to call when there is
    /// no active response; the gateway ignores it.
    public func cancelActiveResponse() async throws {
        guard let transport = self.transport else { return }
        try await transport.send(.responseCancel)
    }

    /// Signal end-of-utterance to the gateway's VAD. Most deployments run
    /// with `server_vad` so this is rarely needed; exposed for PTT flows.
    public func commitInputBuffer() async throws {
        guard let transport = self.transport else { return }
        try await transport.send(.inputAudioCommit)
    }

    /// Close the session. Idempotent.
    public func close() async {
        await self.stopIfActive()
    }

    public var isActive: Bool { self.transport != nil }

    private func stopIfActive() async {
        self.consumerTask?.cancel()
        self.consumerTask = nil
        if let transport = self.transport {
            await transport.close()
        }
        self.transport = nil
    }

    private func consume(stream: AsyncThrowingStream<GatewayRealtimeServerEvent, Error>) async {
        do {
            for try await event in stream {
                if Task.isCancelled { return }
                self.dispatch(event: event)
            }
            self.delegate.onClosed("stream ended", 0)
        } catch let err as GatewayRealtimeTransportError {
            self.logger.error(
                "gateway realtime stream error: \(err.localizedDescription, privacy: .public)")
            self.delegate.onError("transport_error", err.localizedDescription, false)
        } catch let err as RealtimeWebSocketError {
            self.logger.error(
                "gateway realtime ws error: \(err.message, privacy: .public)")
            self.delegate.onError(err.kind.rawValue, err.message, err.transientFailure != nil)
        } catch {
            self.logger.error(
                "gateway realtime stream error: \(error.localizedDescription, privacy: .public)")
            self.delegate.onError("unknown", error.localizedDescription, false)
        }
    }

    private func dispatch(event: GatewayRealtimeServerEvent) {
        let delegate = self.delegate
        switch event {
        case .sessionReady(let voiceRunId, let sessionKey, _):
            delegate.onSessionReady(voiceRunId, sessionKey)
        case .userTranscriptPartial(let text):
            delegate.onPartialTranscript(text)
        case .userTranscriptFinal(let text):
            delegate.onFinalTranscript(text)
        case .assistantTextDelta(let text):
            delegate.onAssistantTextDelta(text)
        case .assistantTextDone(let text):
            delegate.onAssistantTextDone(text)
        case .assistantAudioDelta(let base64):
            if let data = Data(base64Encoded: base64) {
                delegate.onAssistantAudioChunk(data)
            }
        case .assistantAudioDone:
            delegate.onAssistantAudioDone()
        case .toolCallStarted(let callId, let name):
            delegate.onToolCallStarted(callId, name)
        case .toolCallFinished(let callId, let name, let durationMs, let ok):
            delegate.onToolCallFinished(callId, name, durationMs, ok)
        case .fallbackActivated(let from, let to, let reason):
            delegate.onFallbackActivated(from, to, reason)
        case .error(let code, let message, let recoverable):
            delegate.onError(code, message, recoverable)
        case .closed(let reason, let code):
            delegate.onClosed(reason, code)
        case .ping:
            // The transport layer does not echo pings on its own; if the
            // server pings, the talk manager decides whether to roundtrip.
            // We deliberately do not surface pings to the delegate to keep
            // the UI event surface minimal.
            return
        }
    }
}
