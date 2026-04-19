import Foundation
import OpenClawKit
import OSLog

/// Thin facade around `OpenAIRealtimeVoiceSession` that pipes the session's event
/// stream into the iOS talk loop.
///
/// Responsibilities kept narrow:
/// - Own the active session actor.
/// - Subscribe to its event stream and forward:
///   - assistant PCM16 chunks -> `PCMStreamingAudioPlayer.shared` via a feeder
///     channel (when playback is wired) or a delegate callback.
///   - transcripts + state -> delegate callback consumed by `TalkModeManager`.
///
/// The runtime is intentionally small so it can be exercised from unit tests that
/// don't need to touch AVAudioEngine. Tier 2 consumes it opt-in; the default
/// Tier 1 STT + TTS flow continues to own the production voice path until the
/// feature is explicitly enabled via `providerSurface.enableRealtime`.
@MainActor
final class TalkRealtimeSessionRuntime {
    struct Delegate: Sendable {
        /// Called once the WebSocket handshake + `session.update` succeed.
        var onConnected: @Sendable (_ deployment: String) -> Void = { _ in }
        /// Incremental partial user transcript. Safe to call frequently.
        var onPartialTranscript: @Sendable (_ text: String) -> Void = { _ in }
        /// Final committed user transcript.
        var onFinalTranscript: @Sendable (_ text: String) -> Void = { _ in }
        /// Assistant text delta (for chat surface mirroring).
        var onAssistantTextDelta: @Sendable (_ text: String) -> Void = { _ in }
        /// PCM16 24 kHz mono audio chunk to feed into the playback layer.
        var onAssistantAudioChunk: @Sendable (_ pcm16: Data) -> Void = { _ in }
        /// Fallback activated for a transient dial failure.
        var onFallbackActivated: @Sendable (_ from: String, _ to: String, _ reason: RealtimeTransientFailure) -> Void = { _, _, _ in }
        /// Reconnect scheduled after a transient drop on the same deployment.
        var onReconnectScheduled: @Sendable (_ attempt: Int, _ delayMs: Int) -> Void = { _, _ in }
        /// Unrecoverable error; session closed.
        var onError: @Sendable (_ error: VoiceProviderError) -> Void = { _ in }
        /// Session closed cleanly.
        var onClosed: @Sendable () -> Void = {}
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "TalkRealtime")
    private var session: OpenAIRealtimeVoiceSession?
    private var eventConsumerTask: Task<Void, Never>?

    /// Currently configured delegate. Kept on the `@MainActor` side so mutation is
    /// serial; dispatch back to the delegate hops out to the main actor.
    var delegate: Delegate = Delegate()

    /// Start a realtime session with `config`. Returns after the initial connect
    /// (including fallback selection) finishes. Caller is expected to keep the
    /// runtime alive until `close()` is invoked.
    func start(
        config: RealtimeCapabilityConfig,
        policy: RealtimeReconnectPolicy = .default
    ) async throws {
        await self.stopIfActive()
        let session = OpenAIRealtimeVoiceSession(
            config: config,
            policy: policy,
            factory: OpenAIRealtimeVoiceSession.makeURLSessionFactory(config: config))
        self.session = session
        let events = session.events
        self.eventConsumerTask = Task { [weak self] in
            await self?.consume(events: events)
        }
        do {
            try await session.connect()
        } catch {
            self.logger.error("realtime connect failed: \(String(describing: error), privacy: .public)")
            await self.stopIfActive()
            throw error
        }
    }

    /// Send a single PCM16 24 kHz frame to the active session.
    func sendAudio(pcm16: Data) async throws {
        try await self.session?.sendAudio(pcm16: pcm16)
    }

    /// Close the session and drop all state.
    func close() async {
        await self.stopIfActive()
    }

    private func stopIfActive() async {
        self.eventConsumerTask?.cancel()
        self.eventConsumerTask = nil
        if let session = self.session {
            await session.close()
        }
        self.session = nil
    }

    private func consume(events: AsyncStream<RealtimeVoiceEvent>) async {
        let delegate = self.delegate
        for await event in events {
            if Task.isCancelled { return }
            switch event {
            case .connected(let deployment):
                delegate.onConnected(deployment)
            case .partialTranscript(let text):
                delegate.onPartialTranscript(text)
            case .finalTranscript(let text):
                delegate.onFinalTranscript(text)
            case .assistantTextDelta(let text):
                delegate.onAssistantTextDelta(text)
            case .assistantAudioChunk(let pcm16):
                delegate.onAssistantAudioChunk(pcm16)
            case .fallbackActivated(let from, let to, let reason):
                delegate.onFallbackActivated(from, to, reason)
            case .reconnectScheduled(let attempt, let delayMs):
                delegate.onReconnectScheduled(attempt, delayMs)
            case .error(let error):
                delegate.onError(error)
            case .closed:
                delegate.onClosed()
                return
            }
        }
    }
}
