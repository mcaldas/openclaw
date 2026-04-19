import Foundation
import OpenClawProtocol

// MARK: - Protocol event types (iOS mirror of src/gateway/talk-realtime/protocol.ts)

/// Events the iOS client sends to the gateway realtime WS.
public enum GatewayRealtimeClientEvent: Sendable, Equatable {
    case inputAudioAppend(base64Pcm16: String)
    case inputAudioCommit
    case responseCancel
    case sessionEnd(reason: SessionEndReason)
    case ping(ts: Int64)

    public enum SessionEndReason: String, Sendable, Equatable {
        case userCancel = "user_cancel"
        case appBackground = "app_background"
    }
}

/// Events the gateway sends back to iOS.
public enum GatewayRealtimeServerEvent: Sendable, Equatable {
    case sessionReady(voiceRunId: String, sessionKey: String, audio: GatewayRealtimeAudio)
    case assistantAudioDelta(base64Pcm16: String)
    case assistantAudioDone(itemId: String?)
    case userTranscriptPartial(text: String)
    case userTranscriptFinal(text: String)
    case assistantTextDelta(text: String)
    case assistantTextDone(text: String)
    case toolCallStarted(callId: String, name: String)
    case toolCallFinished(callId: String, name: String, durationMs: Double, ok: Bool)
    case fallbackActivated(from: String, to: String, reason: String)
    case error(code: String, message: String, recoverable: Bool)
    case closed(reason: String, code: Int)
    case ping(ts: Int64)
}

public struct GatewayRealtimeAudio: Sendable, Equatable, Codable {
    public let sampleRateHz: Int
    public let format: String
    public let channels: Int

    public init(sampleRateHz: Int, format: String, channels: Int) {
        self.sampleRateHz = sampleRateHz
        self.format = format
        self.channels = channels
    }
}

/// Gateway-assigned close codes the client honors. Mirrors
/// `TALK_REALTIME_CLOSE` in `src/gateway/talk-realtime/protocol.ts`; any
/// drift breaks the reconnect decision below.
public enum GatewayRealtimeCloseCode: Int, Sendable, Equatable, CaseIterable {
    case ticketInvalid = 4001
    case ticketExpired = 4002
    case ticketConsumed = 4003
    case replacedByNewer = 4010
    case bridgeError = 4011
    case sessionEnded = 4020
    case providerClosed = 4030

    /// Classification for the reconnect policy. `.reconnectWithFreshTicket`
    /// means the run can resume; `.terminate` means the run is over
    /// (either the user ended it or a newer run replaced it).
    public enum ReconnectDecision: Sendable, Equatable {
        case reconnectWithFreshTicket
        case terminate
    }

    public var reconnectDecision: ReconnectDecision {
        switch self {
        case .ticketExpired: return .reconnectWithFreshTicket
        // An invalid/consumed ticket means the redeem happened already
        // or the ticket never existed; the only recovery is a brand-new
        // `talk.realtime.start` + redeem, which is exactly what a
        // reconnect-with-fresh-ticket path does.
        case .ticketInvalid, .ticketConsumed: return .reconnectWithFreshTicket
        case .bridgeError, .providerClosed: return .reconnectWithFreshTicket
        case .replacedByNewer, .sessionEnded: return .terminate
        }
    }
}

// MARK: - Ticket RPC

/// Response from the gateway's `talk.realtime.start` RPC. Fields mirror
/// `TalkRealtimeStartResultSchema` in
/// `src/gateway/protocol/schema/channels.ts`.
public struct GatewayRealtimeTicket: Sendable, Equatable, Codable {
    public let voiceRunId: String
    public let sessionKey: String
    public let ticket: String
    public let wsPath: String
    public let expiresAtMs: Int64
    public let audio: GatewayRealtimeAudio

    public init(
        voiceRunId: String,
        sessionKey: String,
        ticket: String,
        wsPath: String,
        expiresAtMs: Int64,
        audio: GatewayRealtimeAudio)
    {
        self.voiceRunId = voiceRunId
        self.sessionKey = sessionKey
        self.ticket = ticket
        self.wsPath = wsPath
        self.expiresAtMs = expiresAtMs
        self.audio = audio
    }
}

public enum GatewayRealtimeTransportError: Error, Sendable, Equatable {
    case invalidTicketResponse(String)
    case noGatewayHost
    case closedByServer(code: Int, reason: String)
    case reconnectExhausted
    case malformedFrame(String)

    public var localizedDescription: String {
        switch self {
        case .invalidTicketResponse(let m): return "talk.realtime.start returned an unusable payload: \(m)"
        case .noGatewayHost: return "No gateway host is configured for realtime voice."
        case .closedByServer(let c, let r): return "Gateway closed the realtime WS with \(c) (\(r))."
        case .reconnectExhausted: return "Gateway realtime reconnect attempts exhausted."
        case .malformedFrame(let m): return "Gateway realtime frame decode failed: \(m)."
        }
    }
}

// MARK: - Protocol codec

/// Pure value codec for the gateway realtime protocol. Extracted so the
/// transport itself stays focused on I/O and the codec can be unit-tested
/// without touching a real WebSocket.
public enum GatewayRealtimeCodec {
    /// Encode a client event as the JSON string the gateway WS expects.
    public static func encode(_ event: GatewayRealtimeClientEvent) throws -> String {
        let frame: [String: Any] = Self.clientFrameBody(for: event)
        let data = try JSONSerialization.data(withJSONObject: frame, options: [.sortedKeys])
        guard let text = String(data: data, encoding: .utf8) else {
            throw GatewayRealtimeTransportError.malformedFrame("utf8 encode failed")
        }
        return text
    }

    /// Decode a server frame. Returns `nil` for frames the iOS client
    /// knowingly ignores (future extensions). Throws
    /// `malformedFrame` for shape violations so the transport can surface
    /// a diagnostic and drop the frame.
    public static func decode(_ raw: String) throws -> GatewayRealtimeServerEvent? {
        guard let data = raw.data(using: .utf8) else {
            throw GatewayRealtimeTransportError.malformedFrame("not utf8")
        }
        let json: Any
        do {
            json = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw GatewayRealtimeTransportError.malformedFrame(
                "json parse failed: \(error.localizedDescription)")
        }
        guard let object = json as? [String: Any], let type = object["type"] as? String
        else {
            throw GatewayRealtimeTransportError.malformedFrame("not a typed object")
        }
        switch type {
        case "session.ready":
            guard
                let voiceRunId = object["voiceRunId"] as? String,
                let sessionKey = object["sessionKey"] as? String,
                let audioObject = object["audio"] as? [String: Any],
                let sampleRate = audioObject["sampleRateHz"] as? Int,
                let format = audioObject["format"] as? String,
                let channels = audioObject["channels"] as? Int
            else {
                throw GatewayRealtimeTransportError.malformedFrame("session.ready missing fields")
            }
            let audio = GatewayRealtimeAudio(
                sampleRateHz: sampleRate,
                format: format,
                channels: channels)
            return .sessionReady(voiceRunId: voiceRunId, sessionKey: sessionKey, audio: audio)
        case "response.audio.delta":
            guard let b64 = object["audio"] as? String else {
                throw GatewayRealtimeTransportError.malformedFrame("audio.delta missing audio")
            }
            return .assistantAudioDelta(base64Pcm16: b64)
        case "response.audio.done":
            return .assistantAudioDone(itemId: object["itemId"] as? String)
        case "conversation.item.input_audio_transcription.partial":
            guard let text = object["text"] as? String else { return nil }
            return .userTranscriptPartial(text: text)
        case "conversation.item.input_audio_transcription.final":
            guard let text = object["text"] as? String else { return nil }
            return .userTranscriptFinal(text: text)
        case "response.output_text.delta":
            guard let text = object["text"] as? String else { return nil }
            return .assistantTextDelta(text: text)
        case "response.output_text.done":
            guard let text = object["text"] as? String else { return nil }
            return .assistantTextDone(text: text)
        case "response.tool_call.started":
            guard
                let callId = object["callId"] as? String,
                let name = object["name"] as? String
            else {
                throw GatewayRealtimeTransportError.malformedFrame("tool_call.started missing fields")
            }
            return .toolCallStarted(callId: callId, name: name)
        case "response.tool_call.finished":
            guard
                let callId = object["callId"] as? String,
                let name = object["name"] as? String,
                let ok = object["ok"] as? Bool
            else {
                throw GatewayRealtimeTransportError.malformedFrame("tool_call.finished missing fields")
            }
            let durationMs: Double
            if let n = object["durationMs"] as? Double {
                durationMs = n
            } else if let i = object["durationMs"] as? Int {
                durationMs = Double(i)
            } else {
                durationMs = 0
            }
            return .toolCallFinished(callId: callId, name: name, durationMs: durationMs, ok: ok)
        case "fallback.activated":
            let from = (object["from"] as? String) ?? ""
            let to = (object["to"] as? String) ?? ""
            let reason = (object["reason"] as? String) ?? ""
            return .fallbackActivated(from: from, to: to, reason: reason)
        case "error":
            let code = (object["code"] as? String) ?? "unknown"
            let message = (object["message"] as? String) ?? ""
            let recoverable = (object["recoverable"] as? Bool) ?? false
            return .error(code: code, message: message, recoverable: recoverable)
        case "closed":
            let reason = (object["reason"] as? String) ?? ""
            let code = (object["code"] as? Int) ?? 0
            return .closed(reason: reason, code: code)
        case "ping":
            let ts = (object["ts"] as? Int64) ?? Int64((object["ts"] as? Int) ?? 0)
            return .ping(ts: ts)
        default:
            // Unknown server-event types are dropped silently so a
            // forward-compatible gateway can add frames without
            // breaking the client.
            return nil
        }
    }

    private static func clientFrameBody(for event: GatewayRealtimeClientEvent) -> [String: Any] {
        switch event {
        case .inputAudioAppend(let audio):
            return ["type": "input_audio_buffer.append", "audio": audio]
        case .inputAudioCommit:
            return ["type": "input_audio_buffer.commit"]
        case .responseCancel:
            return ["type": "response.cancel"]
        case .sessionEnd(let reason):
            return ["type": "session.end", "reason": reason.rawValue]
        case .ping(let ts):
            return ["type": "ping", "ts": ts]
        }
    }
}

// MARK: - Ticket issuer (gateway RPC)

/// Abstracts the RPC call that mints a realtime ticket. Real callers
/// wrap `GatewayChannel.request(method:params:)`; tests inject a stub.
public protocol GatewayRealtimeTicketIssuing: Sendable {
    func issue(agentId: String?, providerId: String?, voiceId: String?) async throws
        -> GatewayRealtimeTicket
}

public struct GatewayRealtimeTicketIssuer: GatewayRealtimeTicketIssuing {
    private let request: @Sendable (_ method: String, _ params: [String: AnyCodable]?) async throws
        -> Data

    /// Bind to a `GatewayChannel` by passing `channel.request` as the
    /// closure. Kept generic so the transport does not depend on
    /// `GatewayChannel` directly; that also means tests do not need a
    /// full channel instance.
    public init(
        request: @escaping @Sendable (_ method: String, _ params: [String: AnyCodable]?) async throws
            -> Data)
    {
        self.request = request
    }

    public func issue(
        agentId: String?, providerId: String?, voiceId: String?) async throws -> GatewayRealtimeTicket
    {
        var params: [String: AnyCodable] = [:]
        if let agentId, !agentId.isEmpty {
            params["agentId"] = AnyCodable(agentId)
        }
        if let providerId, !providerId.isEmpty {
            params["providerId"] = AnyCodable(providerId)
        }
        if let voiceId, !voiceId.isEmpty {
            params["voiceId"] = AnyCodable(voiceId)
        }
        let data = try await self.request("talk.realtime.start", params.isEmpty ? nil : params)
        let decoder = JSONDecoder()
        do {
            return try decoder.decode(GatewayRealtimeTicket.self, from: data)
        } catch {
            throw GatewayRealtimeTransportError.invalidTicketResponse(error.localizedDescription)
        }
    }
}

// MARK: - Gateway realtime transport

/// Low-level transport adapter. Owns the WS to `/talk/realtime`, speaks
/// the protocol defined in `GatewayRealtimeCodec`, and handles reconnect
/// with fresh-ticket refresh on 4xxx close codes.
///
/// Scope: this type knows nothing about audio capture/playback or the
/// session runtime. It only produces an `AsyncThrowingStream` of decoded
/// server events and accepts client-side events via `send(_:)`. Commit 7
/// wires it into the audio pipeline.
public actor GatewayRealtimeTransport {
    public struct Config: Sendable {
        public let gatewayWsBase: URL
        public let ticketIssuer: GatewayRealtimeTicketIssuing
        public let reconnectPolicy: RealtimeReconnectPolicy
        public let agentId: String?
        public let providerId: String?
        public let voiceId: String?
        /// WS factory. Defaults to `URLSessionRealtimeWebSocket`.
        public let wsFactory:
            @Sendable (_ url: URL, _ headers: [String: String]) -> RealtimeWebSocket

        public init(
            gatewayWsBase: URL,
            ticketIssuer: GatewayRealtimeTicketIssuing,
            reconnectPolicy: RealtimeReconnectPolicy = .default,
            agentId: String? = nil,
            providerId: String? = nil,
            voiceId: String? = nil,
            wsFactory: @escaping @Sendable (URL, [String: String]) -> RealtimeWebSocket = {
                url, headers in
                URLSessionRealtimeWebSocket(url: url, headers: headers)
            })
        {
            self.gatewayWsBase = gatewayWsBase
            self.ticketIssuer = ticketIssuer
            self.reconnectPolicy = reconnectPolicy
            self.agentId = agentId
            self.providerId = providerId
            self.voiceId = voiceId
            self.wsFactory = wsFactory
        }
    }

    public enum State: Sendable, Equatable {
        case idle
        case connecting
        case ready(voiceRunId: String, sessionKey: String)
        case closed(reason: String)
    }

    private let config: Config
    private var state: State = .idle
    private var currentWs: RealtimeWebSocket?
    private var currentTicket: GatewayRealtimeTicket?
    private var eventContinuation: AsyncThrowingStream<GatewayRealtimeServerEvent, Error>.Continuation?
    private var receiveLoop: Task<Void, Never>?

    public init(config: Config) {
        self.config = config
    }

    public var currentState: State { self.state }

    /// Start the transport. Returns an `AsyncThrowingStream` of decoded
    /// server events; it ends cleanly on `closed`/`sessionEnded` and
    /// throws on `reconnectExhausted` / terminal errors.
    public func start() -> AsyncThrowingStream<GatewayRealtimeServerEvent, Error> {
        AsyncThrowingStream { continuation in
            self.eventContinuation = continuation
            self.receiveLoop = Task { [weak self] in
                guard let self else {
                    continuation.finish()
                    return
                }
                await self.runConnectLoop()
            }
            continuation.onTermination = { @Sendable _ in
                Task { [weak self] in
                    await self?.teardown(reason: "stream cancelled")
                }
            }
        }
    }

    /// Send a client event. If the WS is not in a sendable state, throws
    /// a transport error so the caller can decide whether to buffer or
    /// drop.
    public func send(_ event: GatewayRealtimeClientEvent) async throws {
        guard case .ready = self.state, let ws = self.currentWs else {
            throw RealtimeWebSocketError(
                kind: .transport,
                message: "realtime transport not ready")
        }
        let text = try GatewayRealtimeCodec.encode(event)
        try await ws.sendText(text)
    }

    /// Explicitly close the transport. Emits no reconnect.
    public func close() async {
        await self.teardown(reason: "closed")
    }

    // MARK: Private

    private func runConnectLoop() async {
        var attempt = 1
        while !Task.isCancelled {
            do {
                try await self.dialOnce()
                // dialOnce drives the receive loop; it returns when the
                // WS closes. If we get here with a non-terminal state
                // we should consider a reconnect.
                if case .closed(let reason) = self.state {
                    self.eventContinuation?.finish()
                    _ = reason
                    return
                }
                // Clean close with no `.closed` state transition (e.g.
                // server ended the stream): treat as terminal.
                self.eventContinuation?.finish()
                return
            } catch let err as RealtimeWebSocketError {
                if err.transientFailure != nil,
                    self.config.reconnectPolicy.shouldRetry(attempt: attempt + 1)
                {
                    let delayMs = self.config.reconnectPolicy.delayMs(forAttempt: attempt + 1)
                    try? await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
                    attempt += 1
                    continue
                }
                self.eventContinuation?.finish(throwing: err)
                return
            } catch let gatewayErr as GatewayRealtimeTransportError {
                // ticketExpired / ticketInvalid / ticketConsumed should
                // already have been consumed by the close-code path in
                // dialOnce. If we got here with one of those, the
                // reconnect path already fired.
                self.eventContinuation?.finish(throwing: gatewayErr)
                return
            } catch {
                self.eventContinuation?.finish(throwing: error)
                return
            }
        }
        self.eventContinuation?.finish()
    }

    private func dialOnce() async throws {
        self.state = .connecting
        let ticket = try await self.config.ticketIssuer.issue(
            agentId: self.config.agentId,
            providerId: self.config.providerId,
            voiceId: self.config.voiceId)
        self.currentTicket = ticket
        let url = try self.buildWsUrl(for: ticket)
        let ws = self.config.wsFactory(url, [:])
        self.currentWs = ws
        try await ws.connect()
        // Pump frames until close.
        while !Task.isCancelled {
            let frame: RealtimeWebSocketFrame?
            do {
                frame = try await ws.receive()
            } catch let err as RealtimeWebSocketError {
                throw err
            }
            guard let frame else {
                // Clean close from peer.
                self.state = .closed(reason: "peer closed")
                return
            }
            try await self.handleFrame(frame)
            if case .closed = self.state {
                return
            }
        }
    }

    private func handleFrame(_ frame: RealtimeWebSocketFrame) async throws {
        switch frame {
        case .text(let text):
            let event: GatewayRealtimeServerEvent?
            do {
                event = try GatewayRealtimeCodec.decode(text)
            } catch let err as GatewayRealtimeTransportError {
                // Surface a malformed frame to the caller but do not
                // tear down the WS; forward-compatible gateways may
                // add fields we do not know about.
                self.eventContinuation?.yield(.error(
                    code: "malformed_frame",
                    message: err.localizedDescription,
                    recoverable: true))
                return
            }
            guard let event else { return }
            if case .sessionReady(let voiceRunId, let sessionKey, _) = event {
                self.state = .ready(voiceRunId: voiceRunId, sessionKey: sessionKey)
            }
            self.eventContinuation?.yield(event)
            if case .closed(let reason, let code) = event {
                self.state = .closed(reason: reason)
                if let knownCode = GatewayRealtimeCloseCode(rawValue: code) {
                    switch knownCode.reconnectDecision {
                    case .reconnectWithFreshTicket:
                        // Surface nothing here; runConnectLoop decides
                        // via `self.state != .closed` whether to keep
                        // going, but we set `.closed` above so the
                        // runConnectLoop returns. Per the design,
                        // reconnect with a fresh ticket is driven by
                        // raising a transient error rather than auto-
                        // looping inside one dial: that keeps the
                        // backoff clock honest.
                        throw RealtimeWebSocketError(
                            kind: .transport,
                            message: "reconnect requested by close code \(code)")
                    case .terminate:
                        return
                    }
                }
            }
        case .data:
            // The gateway protocol is UTF-8 JSON; binary frames are not
            // part of the spec. Ignore them.
            return
        }
    }

    private func buildWsUrl(for ticket: GatewayRealtimeTicket) throws -> URL {
        guard var components = URLComponents(url: self.config.gatewayWsBase, resolvingAgainstBaseURL: false)
        else {
            throw GatewayRealtimeTransportError.noGatewayHost
        }
        // Map http(s) -> ws(s).
        let scheme = components.scheme?.lowercased() ?? "https"
        switch scheme {
        case "http": components.scheme = "ws"
        case "https": components.scheme = "wss"
        case "ws", "wss": break
        default: components.scheme = "wss"
        }
        components.path = ticket.wsPath
        var items = components.queryItems ?? []
        items.removeAll { $0.name == "ticket" }
        items.append(URLQueryItem(name: "ticket", value: ticket.ticket))
        components.queryItems = items
        guard let url = components.url else {
            throw GatewayRealtimeTransportError.noGatewayHost
        }
        return url
    }

    private func teardown(reason: String) async {
        let ws = self.currentWs
        self.currentWs = nil
        self.currentTicket = nil
        self.receiveLoop?.cancel()
        self.receiveLoop = nil
        await ws?.close(code: .normal)
        if case .closed = self.state {
            // Already closed.
        } else {
            self.state = .closed(reason: reason)
        }
        self.eventContinuation?.finish()
        self.eventContinuation = nil
    }
}
