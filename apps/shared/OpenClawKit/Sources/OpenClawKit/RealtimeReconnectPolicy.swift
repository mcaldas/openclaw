import Foundation

/// Pure-value exponential-backoff policy for realtime WebSocket reconnects, kept
/// separate from the session actor so we can test the schedule deterministically.
///
/// Policy mirrors the backend and bridge design note:
///   attempts = 5, initial = 1000ms, multiplier = 2, cap = 16000ms, reset on success.
/// The schedule emitted for attempts 1..maxAttempts is the delay to wait *before*
/// attempt N, so `delayMs(forAttempt: 1) == initialDelayMs`.
public struct RealtimeReconnectPolicy: Sendable, Equatable {
    public let maxAttempts: Int
    public let initialDelayMs: Int
    public let multiplier: Double
    public let capMs: Int

    public static let `default` = RealtimeReconnectPolicy(
        maxAttempts: 5,
        initialDelayMs: 1_000,
        multiplier: 2.0,
        capMs: 16_000)

    public init(maxAttempts: Int, initialDelayMs: Int, multiplier: Double, capMs: Int) {
        self.maxAttempts = max(1, maxAttempts)
        self.initialDelayMs = max(0, initialDelayMs)
        self.multiplier = max(1.0, multiplier)
        self.capMs = max(initialDelayMs, capMs)
    }

    /// Delay (ms) before attempt `n` (1-based). Attempts beyond `maxAttempts` are
    /// not scheduled, but the function still returns a valid clamped value to make
    /// callers robust.
    public func delayMs(forAttempt n: Int) -> Int {
        guard n >= 1 else { return self.initialDelayMs }
        let exponent = Double(max(0, n - 1))
        let raw = Double(self.initialDelayMs) * pow(self.multiplier, exponent)
        if !raw.isFinite { return self.capMs }
        // Clamp via Double comparison before the Int conversion to avoid overflowing
        // for large attempt counts or large multipliers (the cap is usually small
        // relative to Int.max so we can rely on Double precision here).
        let capDouble = Double(self.capMs)
        let clamped = min(raw, capDouble)
        if clamped <= 0 { return 0 }
        return Int(clamped.rounded(.down))
    }

    /// Full schedule for attempts 1..maxAttempts. Useful for tests and log previews.
    public var schedule: [Int] {
        (1...self.maxAttempts).map { self.delayMs(forAttempt: $0) }
    }

    /// Whether attempt number `n` (1-based) is still within the retry budget.
    public func shouldRetry(attempt n: Int) -> Bool {
        n <= self.maxAttempts
    }
}
