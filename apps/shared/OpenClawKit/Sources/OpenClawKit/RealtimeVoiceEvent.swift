import Foundation

/// Events emitted by `OpenAIRealtimeVoiceSession` through its `events`
/// `AsyncStream`. Consumers (the iOS talk manager) switch on these to drive UI and
/// audio playback.
public enum RealtimeVoiceEvent: Sendable, Equatable {
    /// WebSocket handshake succeeded and the initial `session.update` was sent.
    /// `deployment` is whichever model/deployment id from `attemptOrder` won.
    case connected(deployment: String)

    /// Partial user transcript from the model's `input_audio_buffer` transcription.
    case partialTranscript(text: String)

    /// Final user transcript committed to the conversation.
    case finalTranscript(text: String)

    /// Incremental assistant text delta (matches `response.output_text.delta`).
    case assistantTextDelta(text: String)

    /// Raw PCM16 24 kHz mono little-endian audio chunk for playback.
    case assistantAudioChunk(pcm16: Data)

    /// Fallback activated after a transient failure on `from`. `to` is the next
    /// model in the attempt order.
    case fallbackActivated(from: String, to: String, reason: RealtimeTransientFailure)

    /// Reconnect scheduled after a transient WebSocket drop for the same model.
    /// `attempt` is 1-based; `delayMs` is the backoff window before the next dial.
    case reconnectScheduled(attempt: Int, delayMs: Int)

    /// Unrecoverable error for the current session (all attempts exhausted).
    case error(VoiceProviderError)

    /// Session closed cleanly (explicit `close()` or remote 1000 close).
    case closed
}

/// Classification of a transient WebSocket/connection failure. Used to decide
/// whether we should fall back to the next model and emit `.fallbackActivated`.
public enum RealtimeTransientFailure: String, Sendable, Equatable {
    /// Abnormal closure without a close frame (typical `URLSessionWebSocketTask`
    /// error when the remote tears down the TCP socket).
    case abnormalClose1006
    /// Remote server error close code.
    case serverErrorClose1011
    /// HTTP 429 / rate limit surfaced by URLSession during the handshake or close.
    case rateLimited
    /// HTTP 503 / service unavailable surfaced during handshake.
    case serviceUnavailable
    /// Network timeout (both handshake and idle tear-down).
    case timeout
    /// Other transient transport error (URLError networkConnectionLost, cannotFindHost
    /// within the transient window, etc). Kept for coverage; do not use as a catch-all.
    case transport
}
