import Foundation
import OpenClawKit
import Testing

@Suite struct RealtimeReconnectPolicyTests {
    @Test func defaultScheduleMatchesBridgeSpec() {
        let policy = RealtimeReconnectPolicy.default
        #expect(policy.maxAttempts == 5)
        #expect(policy.schedule == [1_000, 2_000, 4_000, 8_000, 16_000])
    }

    @Test func delayClampsAtCap() {
        let policy = RealtimeReconnectPolicy.default
        // Attempt 6 would naively be 32000 ms; clamped to the cap.
        #expect(policy.delayMs(forAttempt: 6) == 16_000)
        #expect(policy.delayMs(forAttempt: 99) == 16_000)
    }

    @Test func attemptZeroReturnsInitialDelay() {
        let policy = RealtimeReconnectPolicy.default
        #expect(policy.delayMs(forAttempt: 0) == 1_000)
    }

    @Test func shouldRetryRespectsBudget() {
        let policy = RealtimeReconnectPolicy.default
        #expect(policy.shouldRetry(attempt: 1) == true)
        #expect(policy.shouldRetry(attempt: 5) == true)
        #expect(policy.shouldRetry(attempt: 6) == false)
    }

    @Test func customPolicyRespectsConstructorBounds() {
        let policy = RealtimeReconnectPolicy(
            maxAttempts: 3,
            initialDelayMs: 250,
            multiplier: 3.0,
            capMs: 2_000)
        #expect(policy.schedule == [250, 750, 2_000])
    }

    @Test func invalidInputsAreClamped() {
        let policy = RealtimeReconnectPolicy(
            maxAttempts: 0,
            initialDelayMs: -100,
            multiplier: 0.5,
            capMs: 10)
        // maxAttempts floors at 1, initialDelayMs floors at 0, multiplier floors at 1.0,
        // capMs lifted to >= initialDelayMs.
        #expect(policy.maxAttempts == 1)
        #expect(policy.initialDelayMs == 0)
        #expect(policy.multiplier == 1.0)
        #expect(policy.capMs >= 0)
        #expect(policy.schedule.count == 1)
    }
}
