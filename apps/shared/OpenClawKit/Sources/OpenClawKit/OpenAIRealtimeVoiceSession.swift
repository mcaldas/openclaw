import Foundation

/// Factory for constructing a `RealtimeWebSocket` for a concrete attempt. The
/// session actor calls this once per (deployment, attempt) tuple so tests can
/// return a scripted stub.
public typealias RealtimeWebSocketFactory = @Sendable (_ deployment: String) throws -> any RealtimeWebSocket

/// Injected clock so reconnect tests do not have to wait real wall time.
public typealias RealtimeClockSleep = @Sendable (_ milliseconds: Int) async throws -> Void

/// Stable default clock backed by `Task.sleep(nanoseconds:)`.
public let defaultRealtimeClockSleep: RealtimeClockSleep = { ms in
    try await Task.sleep(nanoseconds: UInt64(max(0, ms)) * 1_000_000)
}

/// Bidirectional OpenAI realtime voice session with automatic model fallback.
///
/// Responsibilities kept narrow:
/// - Pick the next deployment from the `RealtimeCapabilityConfig.attemptOrder`.
/// - Dial via an injected `RealtimeWebSocketFactory`; on transient close codes
///   emit `.fallbackActivated` and try the next model, up to `policy.maxAttempts`
///   reconnects per deployment.
/// - Translate the OpenAI realtime JSON protocol to `RealtimeVoiceEvent`.
/// - Buffer outbound audio into `input_audio_buffer.append` frames (24 kHz PCM16).
public actor OpenAIRealtimeVoiceSession {
    private let config: RealtimeCapabilityConfig
    private let policy: RealtimeReconnectPolicy
    private let factory: RealtimeWebSocketFactory
    private let sleep: RealtimeClockSleep
    private let turnDetection: TurnDetectionConfig
    private let transcriptionModel: String

    private var eventContinuation: AsyncStream<RealtimeVoiceEvent>.Continuation?
    public nonisolated let events: AsyncStream<RealtimeVoiceEvent>

    private var socket: (any RealtimeWebSocket)?
    private var receiveTask: Task<Void, Never>?
    private var runTask: Task<Void, Never>?
    private var activeDeployment: String?
    private var isClosed = false

    /// Which server-side turn detection strategy to request. `semanticVad` is the
    /// iOS-talk default now because it is less twitchy with self-playback audio
    /// bleed when voice-chat AEC is also on; `serverVad` stays available as an
    /// opt-out and for tests.
    public enum TurnDetectionKind: String, Sendable, Equatable {
        case serverVad = "server_vad"
        case semanticVad = "semantic_vad"

        /// Parse a gateway-supplied string override. Unknown / nil values fall back
        /// to the caller's default. Accepts the canonical `server_vad` /
        /// `semantic_vad` plus a few forgiving spellings.
        public static func from(rawString raw: String?) -> TurnDetectionKind? {
            guard let raw else { return nil }
            switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
            case "server_vad", "server", "servervad": return .serverVad
            case "semantic_vad", "semantic", "semanticvad": return .semanticVad
            default: return nil
            }
        }
    }

    /// Tuning knobs kept as a small struct so tests and tier-2 tuning patches stay
    /// trivial. Defaults are tuned for the iOS echo-loop fix: `semanticVad` trims
    /// false-positive "assistant audio interrupted the user" triggers and a longer
    /// silence window keeps the model from cutting users off mid-thought.
    public struct TurnDetectionConfig: Sendable, Equatable {
        public let kind: TurnDetectionKind
        public let threshold: Double
        public let silenceDurationMs: Int
        public let prefixPaddingMs: Int
        public let createResponse: Bool

        public static let `default` = TurnDetectionConfig(
            kind: .semanticVad,
            threshold: 0.5,
            silenceDurationMs: 700,
            prefixPaddingMs: 300,
            createResponse: true)

        public init(
            kind: TurnDetectionKind = .semanticVad,
            threshold: Double,
            silenceDurationMs: Int,
            prefixPaddingMs: Int,
            createResponse: Bool
        ) {
            self.kind = kind
            self.threshold = threshold
            self.silenceDurationMs = silenceDurationMs
            self.prefixPaddingMs = prefixPaddingMs
            self.createResponse = createResponse
        }

        /// Produce a copy with selective overrides. Used by the iOS talk manager
        /// when the gateway config supplies `realtimeVadType` / `realtimeSilenceMs`.
        public func overriding(kind: TurnDetectionKind? = nil, silenceDurationMs: Int? = nil) -> TurnDetectionConfig {
            TurnDetectionConfig(
                kind: kind ?? self.kind,
                threshold: self.threshold,
                silenceDurationMs: silenceDurationMs ?? self.silenceDurationMs,
                prefixPaddingMs: self.prefixPaddingMs,
                createResponse: self.createResponse)
        }
    }

    public init(
        config: RealtimeCapabilityConfig,
        policy: RealtimeReconnectPolicy = .default,
        factory: @escaping RealtimeWebSocketFactory,
        sleep: @escaping RealtimeClockSleep = defaultRealtimeClockSleep,
        turnDetection: TurnDetectionConfig = .default,
        transcriptionModel: String = "whisper-1"
    ) {
        self.config = config
        self.policy = policy
        self.factory = factory
        self.sleep = sleep
        self.turnDetection = turnDetection
        self.transcriptionModel = transcriptionModel

        var continuation: AsyncStream<RealtimeVoiceEvent>.Continuation!
        self.events = AsyncStream { continuation = $0 }
        self.eventContinuation = continuation
    }

    // MARK: - Public API.

    /// Connect, performing model fallback as needed. Throws the last classified
    /// error if every deployment in `attemptOrder` fails.
    public func connect() async throws {
        precondition(self.runTask == nil, "connect() called twice on the same session")
        var lastError: VoiceProviderError?
        let deployments = self.config.attemptOrder
        for (index, deployment) in deployments.enumerated() {
            do {
                try await self.openSocket(deployment: deployment)
                self.activeDeployment = deployment
                try await self.sendSessionUpdate()
                self.emit(.connected(deployment: deployment))
                self.runTask = Task { [weak self] in
                    await self?.runReceiveLoop(deployment: deployment)
                }
                return
            } catch let error as RealtimeWebSocketError {
                let transient = error.transientFailure
                if let transient, index + 1 < deployments.count {
                    let next = deployments[index + 1]
                    self.emit(.fallbackActivated(from: deployment, to: next, reason: transient))
                    lastError = Self.providerError(from: error)
                    continue
                }
                lastError = Self.providerError(from: error)
                if transient != nil, index + 1 >= deployments.count {
                    // Last deployment exhausted its first dial; fall through to throw.
                }
                break
            } catch {
                lastError = VoiceProviderError(
                    code: .network,
                    message: "realtime connect failed: \(error.localizedDescription)")
                break
            }
        }
        let resolved = lastError
            ?? VoiceProviderError(code: .network, message: "realtime connect failed")
        self.emit(.error(resolved))
        self.emit(.closed)
        self.finish()
        throw resolved
    }

    /// Send a chunk of 24 kHz PCM16 mono little-endian audio.
    public func sendAudio(pcm16: Data) async throws {
        guard !pcm16.isEmpty else { return }
        let base64 = pcm16.base64EncodedString()
        let payload = Self.encodeJSON([
            "type": "input_audio_buffer.append",
            "audio": base64,
        ])
        try await self.sendJSON(payload)
    }

    /// Send a text turn (used when the user types instead of speaking). Triggers a
    /// model response by emitting `response.create` after the message.
    public func sendText(_ text: String) async throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let item = Self.encodeJSON([
            "type": "conversation.item.create",
            "item": [
                "type": "message",
                "role": "user",
                "content": [
                    ["type": "input_text", "text": trimmed],
                ],
            ] as [String: Any],
        ])
        try await self.sendJSON(item)
        try await self.sendJSON(Self.encodeJSON([
            "type": "response.create",
        ]))
    }

    /// Seed an opening assistant turn without user input.
    public func triggerGreeting(_ instructions: String) async throws {
        let trimmed = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let payload = Self.encodeJSON([
            "type": "response.create",
            "response": [
                "instructions": trimmed,
            ],
        ])
        try await self.sendJSON(payload)
    }

    /// Cancel the in-flight assistant response so the client can start playing the
    /// user's next turn immediately. Used for barge-in: when the microphone detects
    /// the user speaking while the assistant audio is still streaming, we tear down
    /// the current response over the WS so the server stops generating more audio.
    /// Keeps the session open — server_vad will create the next response on its own
    /// once the next user utterance ends.
    public func cancelActiveResponse() async throws {
        let payload = Self.encodeJSON([
            "type": "response.cancel",
        ])
        try await self.sendJSON(payload)
    }

    public func close() async {
        guard !self.isClosed else { return }
        self.isClosed = true
        self.runTask?.cancel()
        await self.socket?.close(code: .normal)
        self.socket = nil
        self.emit(.closed)
        self.finish()
    }

    // MARK: - Private.

    /// Open a fresh socket for `deployment` with the configured reconnect policy.
    /// This is the single place that builds the target URL from the generic
    /// endpoint layer, so Azure vs OpenAI remains a one-switch decision inside
    /// `VoiceProviderEndpoints`.
    private func openSocket(deployment: String) async throws {
        let socket = try self.factory(deployment)
        self.socket = socket
        try await socket.connect()
    }

    /// Run the receive loop until close. Handles reconnection within the current
    /// deployment using the exponential backoff policy; a transient failure after
    /// the reconnect budget is exhausted trips the fallback selector on the next
    /// connect invocation.
    private func runReceiveLoop(deployment: String) async {
        var attempt = 0
        while !self.isClosed {
            guard let socket = self.socket else { break }
            do {
                while let frame = try await socket.receive() {
                    if Task.isCancelled { return }
                    self.handleFrame(frame)
                }
                // Clean close from the peer.
                self.emit(.closed)
                self.finish()
                return
            } catch let error as RealtimeWebSocketError {
                guard !self.isClosed else { return }
                if let transient = error.transientFailure, self.policy.shouldRetry(attempt: attempt + 1) {
                    attempt += 1
                    let delay = self.policy.delayMs(forAttempt: attempt)
                    self.emit(.reconnectScheduled(attempt: attempt, delayMs: delay))
                    do {
                        try await self.sleep(delay)
                    } catch {
                        self.emit(.error(VoiceProviderError(
                            code: .canceled,
                            message: "reconnect backoff canceled")))
                        self.emit(.closed)
                        self.finish()
                        return
                    }
                    do {
                        try await self.openSocket(deployment: deployment)
                        try await self.sendSessionUpdate()
                        // Reset the attempt counter on a successful dial.
                        attempt = 0
                        _ = transient
                        continue
                    } catch {
                        // Loop; the next receive will surface the same or another error.
                        continue
                    }
                }
                self.emit(.error(Self.providerError(from: error)))
                self.emit(.closed)
                self.finish()
                return
            } catch {
                self.emit(.error(VoiceProviderError(
                    code: .network,
                    message: "realtime receive error: \(error.localizedDescription)")))
                self.emit(.closed)
                self.finish()
                return
            }
        }
    }

    /// Initial `session.update` message. Kept deterministic so the live prompt
    /// prefix and any testing golden strings stay byte-stable. Exposed as
    /// `nonisolated` (reads only immutable init values) so frame tests can assert
    /// the payload without awaiting the actor.
    public nonisolated func makeSessionUpdatePayload() -> Data {
        let body: [String: Any] = [
            "type": "session.update",
            "session": [
                "input_audio_format": "pcm16",
                "output_audio_format": "pcm16",
                "voice": self.config.voice,
                "turn_detection": [
                    "type": self.turnDetection.kind.rawValue,
                    "threshold": self.turnDetection.threshold,
                    "silence_duration_ms": self.turnDetection.silenceDurationMs,
                    "prefix_padding_ms": self.turnDetection.prefixPaddingMs,
                    "create_response": self.turnDetection.createResponse,
                ] as [String: Any],
                "input_audio_transcription": [
                    "model": self.transcriptionModel,
                ] as [String: Any],
            ] as [String: Any],
        ]
        return (try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]))
            ?? Data()
    }

    private func sendSessionUpdate() async throws {
        let data = self.makeSessionUpdatePayload()
        guard let text = String(data: data, encoding: .utf8) else { return }
        try await self.sendJSON(text)
    }

    private func sendJSON(_ text: String) async throws {
        guard let socket = self.socket else {
            throw VoiceProviderError(code: .network, message: "socket not open")
        }
        do {
            try await socket.sendText(text)
        } catch let error as RealtimeWebSocketError {
            throw Self.providerError(from: error)
        }
    }

    private func handleFrame(_ frame: RealtimeWebSocketFrame) {
        switch frame {
        case .text(let text):
            self.handleTextFrame(text)
        case .data:
            // The OpenAI realtime protocol is JSON over text frames; any binary
            // frame is unexpected. Drop silently.
            return
        }
    }

    /// Parse an individual realtime server frame. Exposed internally for frame
    /// tests.
    func handleTextFrame(_ text: String) {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }
        guard let type = object["type"] as? String else { return }
        switch type {
        case "conversation.item.input_audio_transcription.delta":
            if let delta = object["delta"] as? String, !delta.isEmpty {
                self.emit(.partialTranscript(text: delta))
            }
        case "conversation.item.input_audio_transcription.completed":
            if let transcript = object["transcript"] as? String {
                self.emit(.finalTranscript(text: transcript))
            }
        case "response.output_text.delta", "response.text.delta":
            if let delta = object["delta"] as? String, !delta.isEmpty {
                self.emit(.assistantTextDelta(text: delta))
            }
        case "response.audio.delta", "response.output_audio.delta":
            if let b64 = object["delta"] as? String,
               let bytes = Data(base64Encoded: b64)
            {
                self.emit(.assistantAudioChunk(pcm16: bytes))
            }
        case "error":
            let message = ((object["error"] as? [String: Any])?["message"] as? String) ?? "realtime error"
            self.emit(.error(VoiceProviderError(code: .server, message: message)))
        default:
            return
        }
    }

    private static func encodeJSON(_ body: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8)
        else {
            return "{}"
        }
        return text
    }

    private static func providerError(from error: RealtimeWebSocketError) -> VoiceProviderError {
        switch error.kind {
        case .rateLimited:
            return VoiceProviderError(code: .server, httpStatus: 429, message: error.message)
        case .serviceUnavailable:
            return VoiceProviderError(code: .server, httpStatus: 503, message: error.message)
        case .timeout:
            return VoiceProviderError(code: .timeout, message: error.message)
        case .handshakeFailed, .transport, .closedAbnormally, .serverError:
            return VoiceProviderError(code: .network, message: error.message)
        }
    }

    private func emit(_ event: RealtimeVoiceEvent) {
        self.eventContinuation?.yield(event)
    }

    private func finish() {
        self.eventContinuation?.finish()
        self.eventContinuation = nil
    }
}

public extension OpenAIRealtimeVoiceSession {
    /// Convenience factory that wires `URLSessionRealtimeWebSocket` through the
    /// generic `VoiceProviderEndpoints` builder. This is the default used by the
    /// iOS talk manager.
    static func makeURLSessionFactory(
        config: RealtimeCapabilityConfig,
        urlSession: URLSession = .shared
    ) -> RealtimeWebSocketFactory {
        let kind = config.kind
        let credentials = config.credentials
        return { @Sendable deployment in
            let target = try VoiceProviderEndpoints.build(
                kind: kind,
                capability: .realtime,
                credentials: credentials,
                model: deployment)
            return URLSessionRealtimeWebSocket(
                url: target.url,
                headers: target.headers,
                session: urlSession)
        }
    }
}
