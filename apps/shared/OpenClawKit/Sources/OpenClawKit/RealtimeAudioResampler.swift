import Foundation

/// Pure-value resampler from a mic capture buffer (float, any sample rate, mono)
/// to the 24 kHz signed 16-bit little-endian mono PCM frames expected by the
/// OpenAI realtime protocol.
///
/// Why a dedicated helper:
/// - We need deterministic math so tests can assert byte-exact output.
/// - The session actor should only see finished PCM16 frames; any resampling /
///   clipping / endian logic lives here and only here.
///
/// The resampler emits 40ms frames (960 samples at 24 kHz, 1920 bytes). Input
/// buffers whose duration isn't a clean multiple get buffered; call `flush()` at
/// end-of-utterance to drain the tail.
public final class RealtimeAudioResampler: @unchecked Sendable {
    public enum Constants {
        public static let targetSampleRate: Double = 24_000
        public static let frameDurationMs: Int = 40
        /// 960 samples per frame at 24 kHz.
        public static let samplesPerFrame: Int = 960
        /// Signed 16-bit mono → 2 bytes per sample.
        public static let bytesPerFrame: Int = 1_920
    }

    private let lock = NSLock()
    private var residual: [Int16] = []
    /// Linear-interpolation read cursor for the current source buffer, carries
    /// across chunks so decimation stays phase-consistent.
    private var sourcePhase: Double = 0

    public init() {}

    /// Feed a mono float32 buffer at `sourceSampleRate` Hz and receive zero or
    /// more 40 ms PCM16 frames. Samples outside [-1, 1] are clipped.
    public func append(floatSamples: [Float], sourceSampleRate: Double) -> [Data] {
        guard !floatSamples.isEmpty, sourceSampleRate > 0 else { return [] }
        self.lock.lock()
        defer { self.lock.unlock() }

        let target = Constants.targetSampleRate
        // Fast path: exactly 24 kHz input — skip resampling.
        var int16Samples: [Int16]
        if abs(sourceSampleRate - target) < 0.5 {
            self.sourcePhase = 0
            int16Samples = floatSamples.map(Self.clipToInt16)
        } else {
            int16Samples = []
            let ratio = sourceSampleRate / target
            // `sourcePhase` is an index into `floatSamples` accumulated over chunks.
            // Use linear interpolation between adjacent source samples.
            var phase = self.sourcePhase
            let lastIndex = Double(floatSamples.count - 1)
            while phase <= lastIndex {
                let lower = Int(phase.rounded(.down))
                let upper = min(lower + 1, floatSamples.count - 1)
                let frac = Float(phase - Double(lower))
                let sample = floatSamples[lower] * (1 - frac) + floatSamples[upper] * frac
                int16Samples.append(Self.clipToInt16(sample))
                phase += ratio
            }
            // Carry the phase overrun into the next chunk so we stay aligned across
            // buffer boundaries.
            self.sourcePhase = phase - Double(floatSamples.count)
            if self.sourcePhase < 0 { self.sourcePhase = 0 }
        }

        self.residual.append(contentsOf: int16Samples)
        return self.drainCompleteFramesLocked()
    }

    /// Drain any partial frame, zero-padding to a full 40ms frame. Called at the
    /// end of an utterance so we do not swallow the trailing audio.
    public func flush() -> [Data] {
        self.lock.lock()
        defer { self.lock.unlock() }
        var out = self.drainCompleteFramesLocked()
        if !self.residual.isEmpty {
            let padCount = Constants.samplesPerFrame - self.residual.count
            if padCount > 0 {
                self.residual.append(contentsOf: Array(repeating: Int16(0), count: padCount))
            }
            if let frame = self.packFrameLocked() {
                out.append(frame)
            }
        }
        self.sourcePhase = 0
        return out
    }

    /// Reset the resampler state. Used when a session disconnects so residual
    /// samples from the previous attempt do not bleed into the reconnect.
    public func reset() {
        self.lock.lock()
        self.residual.removeAll(keepingCapacity: true)
        self.sourcePhase = 0
        self.lock.unlock()
    }

    private func drainCompleteFramesLocked() -> [Data] {
        var out: [Data] = []
        while self.residual.count >= Constants.samplesPerFrame {
            if let frame = self.packFrameLocked() {
                out.append(frame)
            }
        }
        return out
    }

    private func packFrameLocked() -> Data? {
        guard self.residual.count >= Constants.samplesPerFrame else { return nil }
        let frame = Array(self.residual.prefix(Constants.samplesPerFrame))
        self.residual.removeFirst(Constants.samplesPerFrame)
        return Self.encodeInt16Le(frame)
    }

    /// Exposed for tests: clip a floating-point sample to the signed-16-bit range.
    public static func clipToInt16(_ sample: Float) -> Int16 {
        let scaled = sample * 32767.0
        if scaled >= 32767 { return 32767 }
        if scaled <= -32768 { return -32768 }
        return Int16(scaled.rounded())
    }

    /// Exposed for tests: pack an `Int16` array as little-endian bytes.
    public static func encodeInt16Le(_ samples: [Int16]) -> Data {
        var data = Data(count: samples.count * 2)
        data.withUnsafeMutableBytes { raw in
            guard let base = raw.baseAddress else { return }
            var offset = 0
            for s in samples {
                let u = UInt16(bitPattern: s)
                base.storeBytes(of: UInt8(u & 0xff), toByteOffset: offset, as: UInt8.self)
                base.storeBytes(of: UInt8((u >> 8) & 0xff), toByteOffset: offset + 1, as: UInt8.self)
                offset += 2
            }
        }
        return data
    }
}
