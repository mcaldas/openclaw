import Foundation
import OpenClawKit
import Testing

@Suite struct RealtimeAudioResamplerTests {
    @Test func identityPassThroughAt24kHz() {
        let resampler = RealtimeAudioResampler()
        // 960 samples at 24 kHz = exactly one 40ms frame.
        let samples: [Float] = (0..<960).map { Float($0) / 32768.0 }
        let frames = resampler.append(floatSamples: samples, sourceSampleRate: 24_000)
        #expect(frames.count == 1)
        #expect(frames.first?.count == RealtimeAudioResampler.Constants.bytesPerFrame)
        // First sample is 0 — encodes to 0x00 0x00.
        let bytes = [UInt8](frames[0])
        #expect(bytes[0] == 0x00)
        #expect(bytes[1] == 0x00)
        // Second sample is 1/32768 ≈ 1 in int16.
        #expect(bytes[2] == 0x01)
        #expect(bytes[3] == 0x00)
    }

    @Test func clipsAbovePositiveFullScale() {
        let sample = RealtimeAudioResampler.clipToInt16(1.5)
        #expect(sample == 32_767)
    }

    @Test func clipsBelowNegativeFullScale() {
        let sample = RealtimeAudioResampler.clipToInt16(-1.5)
        #expect(sample == -32_768)
    }

    @Test func encodesLittleEndianBytes() {
        // 0x1234 stored little-endian => 0x34 0x12.
        let data = RealtimeAudioResampler.encodeInt16Le([0x1234, -1])
        let bytes = [UInt8](data)
        #expect(bytes == [0x34, 0x12, 0xff, 0xff])
    }

    @Test func buffersPartialFramesUntilComplete() {
        let resampler = RealtimeAudioResampler()
        let half: [Float] = Array(repeating: 0, count: 480) // half a frame at 24 kHz.
        let first = resampler.append(floatSamples: half, sourceSampleRate: 24_000)
        #expect(first.isEmpty)
        let second = resampler.append(floatSamples: half, sourceSampleRate: 24_000)
        #expect(second.count == 1)
    }

    @Test func flushZeroPadsResidual() {
        let resampler = RealtimeAudioResampler()
        let partial: [Float] = Array(repeating: 0.5, count: 100)
        let empty = resampler.append(floatSamples: partial, sourceSampleRate: 24_000)
        #expect(empty.isEmpty)
        let tail = resampler.flush()
        #expect(tail.count == 1)
        #expect(tail[0].count == RealtimeAudioResampler.Constants.bytesPerFrame)
    }

    @Test func resamplesFrom48kHzProducesRoughlyHalfFrameCount() {
        let resampler = RealtimeAudioResampler()
        // 48 kHz → 24 kHz is a 2:1 decimation. Feed enough source samples to produce
        // exactly one 40 ms target frame (960 target samples = 1920 source samples).
        let samples: [Float] = (0..<1_920).map { _ in 0.25 }
        let frames = resampler.append(floatSamples: samples, sourceSampleRate: 48_000)
        #expect(frames.count == 1)
        #expect(frames[0].count == RealtimeAudioResampler.Constants.bytesPerFrame)
    }

    @Test func resetClearsResidual() {
        let resampler = RealtimeAudioResampler()
        _ = resampler.append(
            floatSamples: Array(repeating: 0.1, count: 500),
            sourceSampleRate: 24_000)
        resampler.reset()
        let empty = resampler.flush()
        #expect(empty.isEmpty)
    }
}
