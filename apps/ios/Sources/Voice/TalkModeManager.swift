import AVFAudio
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import Foundation
import Observation
import OSLog
import Speech

private final class StreamFailureBox: @unchecked Sendable {
    private let lock = NSLock()
    private var valueInternal: Error?

    func set(_ error: Error) {
        self.lock.lock()
        self.valueInternal = error
        self.lock.unlock()
    }

    var value: Error? {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.valueInternal
    }
}

// This file intentionally centralizes talk mode state + behavior.
// It's large, and splitting would force `private` -> `fileprivate` across many members.
// We'll refactor into smaller files when the surface stabilizes.
// swiftlint:disable type_body_length file_length
@MainActor
@Observable
final class TalkModeManager: NSObject {
    private typealias SpeechRequest = SFSpeechAudioBufferRecognitionRequest
    private static let defaultModelIdFallback = "eleven_v3"
    private static let defaultTalkProvider = "elevenlabs"
    private static let defaultSilenceTimeoutMs = TalkDefaults.silenceTimeoutMs
    private static let redactedConfigSentinel = "__OPENCLAW_REDACTED__"
    var isEnabled: Bool = false
    var isListening: Bool = false
    var isSpeaking: Bool = false
    var isPushToTalkActive: Bool = false
    var statusText: String = "Off"
    /// 0..1-ish (not calibrated). Intended for UI feedback only.
    var micLevel: Double = 0
    var gatewayTalkConfigLoaded: Bool = false
    var gatewayTalkApiKeyConfigured: Bool = false
    var gatewayTalkDefaultModelId: String?
    var gatewayTalkDefaultVoiceId: String?

    private enum CaptureMode {
        case idle
        case continuous
        case pushToTalk
    }

    private var captureMode: CaptureMode = .idle
    private var resumeContinuousAfterPTT: Bool = false
    private var activePTTCaptureId: String?
    private var pttAutoStopEnabled: Bool = false
    private var pttCompletion: CheckedContinuation<OpenClawTalkPTTStopPayload, Never>?
    private var pttTimeoutTask: Task<Void, Never>?

    private let allowSimulatorCapture: Bool

    private let audioEngine = AVAudioEngine()
    private var inputTapInstalled = false
    private var audioTapDiagnostics: AudioTapDiagnostics?
    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var silenceTask: Task<Void, Never>?

    private var lastHeard: Date?
    private var lastTranscript: String = ""
    private var loggedPartialThisCycle: Bool = false
    private var lastSpokenText: String?
    private var lastInterruptedAtSeconds: Double?

    private var defaultVoiceId: String?
    private var currentVoiceId: String?
    private var defaultModelId: String?
    private var currentModelId: String?
    private var voiceOverrideActive = false
    private var modelOverrideActive = false
    private var defaultOutputFormat: String?
    private var apiKey: String?
    private var voiceAliases: [String: String] = [:]
    private var interruptOnSpeech: Bool = true
    /// Parsed generic provider surface. Non-nil whenever the gateway served a
    /// resolved talk config; used to route OpenAI / Azure-OpenAI TTS without
    /// branching on provider id across the call sites.
    private var providerSurface: TalkProviderSurface?
    private var openAIRuntime = TalkOpenAICompatibleTTSRuntime()
    private var mainSessionKey: String = "main"
    private var fallbackVoiceId: String?
    private var lastPlaybackWasPCM: Bool = false
    /// Set when the ElevenLabs API rejects PCM format (e.g. 403 subscription_required).
    /// Once set, all subsequent requests in this session use MP3 instead of re-trying PCM.
    private var pcmFormatUnavailable: Bool = false
    var pcmPlayer: PCMStreamingAudioPlaying = PCMStreamingAudioPlayer.shared
    var mp3Player: StreamingAudioPlaying = StreamingAudioPlayer.shared

    // Realtime splice state. All fields are `@MainActor`-confined because they
    // are only touched from `TalkModeManager`'s main-actor-owned methods. Kept
    // private so the Tier 1 code paths remain the default surface area.
    private let talkRealtimeRuntime = TalkRealtimeSessionRuntime()
    private var realtimeActive = false
    private var realtimeDegraded = false
    private var realtimeResampler: RealtimeAudioResampler?
    /// Continuation used to push PCM16 24 kHz audio chunks received from the
    /// realtime session into `pcmPlayer`. Nil until the first assistant audio
    /// chunk arrives; torn down on session close or on barge-in.
    private var realtimeAudioFeed: AsyncThrowingStream<Data, Error>.Continuation?
    private var realtimePlaybackTask: Task<Void, Never>?
    /// Test hook: when non-nil, `start()` skips the real network dial and uses
    /// this factory to produce a scripted `RealtimeWebSocket`.
    var realtimeWebSocketFactoryOverride: RealtimeWebSocketFactory?

    private var gateway: GatewayNodeSession?
    private var gatewayConnected = false
    private var silenceWindow: TimeInterval = TimeInterval(TalkModeManager.defaultSilenceTimeoutMs) / 1000
    private var lastAudioActivity: Date?
    private var noiseFloorSamples: [Double] = []
    private var noiseFloor: Double?
    private var noiseFloorReady: Bool = false

    private var chatSubscribedSessionKeys = Set<String>()
    private var incrementalSpeechQueue: [String] = []
    private var incrementalSpeechTask: Task<Void, Never>?
    private var incrementalSpeechActive = false
    private var incrementalSpeechUsed = false
    private var incrementalSpeechLanguage: String?
    private var incrementalSpeechBuffer = IncrementalSpeechBuffer()
    private var incrementalSpeechContext: IncrementalSpeechContext?
    private var incrementalSpeechDirective: TalkDirective?
    private var incrementalSpeechPrefetch: IncrementalSpeechPrefetchState?
    private var incrementalSpeechPrefetchMonitorTask: Task<Void, Never>?

    private let logger = Logger(subsystem: "ai.openclaw", category: "TalkMode")

    init(allowSimulatorCapture: Bool = false) {
        self.allowSimulatorCapture = allowSimulatorCapture
        super.init()
    }

    func attachGateway(_ gateway: GatewayNodeSession) {
        self.gateway = gateway
    }

    func updateGatewayConnected(_ connected: Bool) {
        self.gatewayConnected = connected
        if connected {
            // If talk mode is enabled before the gateway connects (common on cold start),
            // kick recognition once we're online so the UI doesn’t stay “Offline”.
            if self.isEnabled, !self.isListening, self.captureMode != .pushToTalk {
                Task { await self.start() }
            }
        } else {
            if self.isEnabled, !self.isSpeaking {
                self.statusText = "Offline"
            }
        }
    }

    func updateMainSessionKey(_ sessionKey: String?) {
        let trimmed = (sessionKey ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if trimmed == self.mainSessionKey { return }
        self.mainSessionKey = trimmed
        if self.gatewayConnected, self.isEnabled {
            Task { await self.subscribeChatIfNeeded(sessionKey: trimmed) }
        }
    }

    func setEnabled(_ enabled: Bool) {
        self.isEnabled = enabled
        if enabled {
            self.logger.info("enabled")
            Task { await self.start() }
        } else {
            self.logger.info("disabled")
            self.stop()
        }
    }

    func start() async {
        guard self.isEnabled else { return }
        guard self.captureMode != .pushToTalk else { return }
        if self.isListening { return }
        guard self.gatewayConnected else {
            self.statusText = "Offline"
            return
        }

        self.logger.info("start")
        self.statusText = "Requesting permissions…"
        let micOk = await Self.requestMicrophonePermission()
        guard micOk else {
            self.logger.warning("start blocked: microphone permission denied")
            self.statusText = "Microphone permission denied"
            return
        }
        let speechOk = await Self.requestSpeechPermission()
        guard speechOk else {
            self.logger.warning("start blocked: speech permission denied")
            self.statusText = Self.permissionMessage(
                kind: "Speech recognition",
                status: SFSpeechRecognizer.authorizationStatus())
            return
        }

        await self.reloadConfig()
        // Realtime splice: when the gateway's provider surface opts in and the
        // capability config resolves cleanly, run the full duplex realtime loop
        // instead of the Tier 1 SFSpeechRecognizer + HTTP TTS path. A transient
        // failure flips `realtimeDegraded` so we don't dial into a dead loop —
        // the Tier 1 path takes over for the remainder of this Talk Mode entry.
        if !self.realtimeDegraded,
           self.isRealtimeEnabled,
           let realtimeConfig = self.resolveRealtimeCapabilityConfig(directive: nil)
        {
            do {
                try Self.configureAudioSession()
                self.captureMode = .continuous
                try await self.startRealtimeRecognition(config: realtimeConfig)
                self.isListening = true
                self.realtimeActive = true
                self.statusText = "Listening"
                self.startSilenceMonitor()
                await self.subscribeChatIfNeeded(sessionKey: self.mainSessionKey)
                self.logger.info("listening (realtime)")
                GatewayDiagnostics.log("talk realtime: session started model=\(realtimeConfig.model)")
                return
            } catch {
                self.realtimeDegraded = true
                GatewayDiagnostics.log(
                    "talk realtime: start failed error=\(error.localizedDescription); degrading to tier 1")
                self.logger.error(
                    "realtime start failed: \(error.localizedDescription, privacy: .public); degrading")
                await self.tearDownRealtimeSession()
                // Fall through into the Tier 1 startup below.
            }
        }

        do {
            try Self.configureAudioSession()
            // Set this before starting recognition so any early speech errors are classified correctly.
            self.captureMode = .continuous
            try self.startRecognition()
            self.isListening = true
            self.statusText = "Listening"
            self.startSilenceMonitor()
            await self.subscribeChatIfNeeded(sessionKey: self.mainSessionKey)
            self.logger.info("listening")
        } catch {
            self.isListening = false
            self.statusText = "Start failed: \(error.localizedDescription)"
            self.logger.error("start failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func stop() {
        self.isEnabled = false
        self.isListening = false
        self.isPushToTalkActive = false
        self.captureMode = .idle
        self.statusText = "Off"
        self.lastTranscript = ""
        self.lastHeard = nil
        self.silenceTask?.cancel()
        self.silenceTask = nil
        // Reset the degrade flag so a subsequent enable re-enters realtime when
        // the feature flag + config still say so.
        self.realtimeDegraded = false
        Task { @MainActor [weak self] in
            await self?.tearDownRealtimeSession()
        }
        self.stopRecognition()
        self.stopSpeaking()
        self.lastInterruptedAtSeconds = nil
        let pendingPTT = self.pttCompletion != nil
        let pendingCaptureId = self.activePTTCaptureId ?? UUID().uuidString
        self.pttTimeoutTask?.cancel()
        self.pttTimeoutTask = nil
        self.pttAutoStopEnabled = false
        if pendingPTT {
            let payload = OpenClawTalkPTTStopPayload(
                captureId: pendingCaptureId,
                transcript: nil,
                status: "cancelled")
            self.finishPTTOnce(payload)
        }
        self.resumeContinuousAfterPTT = false
        self.activePTTCaptureId = nil
        TalkSystemSpeechSynthesizer.shared.stop()
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        } catch {
            self.logger.warning("audio session deactivate failed: \(error.localizedDescription, privacy: .public)")
        }
        Task { await self.unsubscribeAllChats() }
    }

    /// Suspends microphone usage without disabling Talk Mode.
    /// Used when the app backgrounds (or when we need to temporarily release the mic).
    func suspendForBackground(keepActive: Bool = false) -> Bool {
        guard self.isEnabled else { return false }
        if keepActive {
            self.statusText = self.isListening ? "Listening" : self.statusText
            return false
        }
        let wasActive = self.isListening || self.isSpeaking || self.isPushToTalkActive

        self.isListening = false
        self.isPushToTalkActive = false
        self.captureMode = .idle
        self.statusText = "Paused"
        self.lastTranscript = ""
        self.lastHeard = nil
        self.silenceTask?.cancel()
        self.silenceTask = nil

        // Background = tear down the realtime socket so we don't hold a stale
        // connection. Suspended Talk Mode state (`isEnabled`) stays untouched, so
        // `resumeAfterBackground()` can dial again.
        Task { @MainActor [weak self] in
            await self?.tearDownRealtimeSession()
        }
        self.stopRecognition()
        self.stopSpeaking()
        self.lastInterruptedAtSeconds = nil
        TalkSystemSpeechSynthesizer.shared.stop()

        do {
            try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        } catch {
            self.logger.warning("audio session deactivate failed: \(error.localizedDescription, privacy: .public)")
        }

        Task { await self.unsubscribeAllChats() }
        return wasActive
    }

    func resumeAfterBackground(wasSuspended: Bool, wasKeptActive: Bool = false) async {
        if wasKeptActive { return }
        guard wasSuspended else { return }
        guard self.isEnabled else { return }
        await self.start()
    }

    func userTappedOrb() {
        self.stopSpeaking()
    }

    func beginPushToTalk() async throws -> OpenClawTalkPTTStartPayload {
        guard self.gatewayConnected else {
            self.statusText = "Offline"
            throw NSError(domain: "TalkMode", code: 7, userInfo: [
                NSLocalizedDescriptionKey: "Gateway not connected",
            ])
        }
        if self.isPushToTalkActive, let captureId = self.activePTTCaptureId {
            return OpenClawTalkPTTStartPayload(captureId: captureId)
        }

        self.stopSpeaking(storeInterruption: false)
        self.pttTimeoutTask?.cancel()
        self.pttTimeoutTask = nil
        self.pttAutoStopEnabled = false

        self.resumeContinuousAfterPTT = self.isEnabled && self.captureMode == .continuous
        self.silenceTask?.cancel()
        self.silenceTask = nil
        self.stopRecognition()
        self.isListening = false

        let captureId = UUID().uuidString
        self.activePTTCaptureId = captureId
        self.lastTranscript = ""
        self.lastHeard = nil

        self.statusText = "Requesting permissions…"
        if !self.allowSimulatorCapture {
            let micOk = await Self.requestMicrophonePermission()
            guard micOk else {
                self.statusText = "Microphone permission denied"
                throw NSError(domain: "TalkMode", code: 4, userInfo: [
                    NSLocalizedDescriptionKey: "Microphone permission denied",
                ])
            }
            let speechOk = await Self.requestSpeechPermission()
            guard speechOk else {
                self.statusText = Self.permissionMessage(
                    kind: "Speech recognition",
                    status: SFSpeechRecognizer.authorizationStatus())
                throw NSError(domain: "TalkMode", code: 5, userInfo: [
                    NSLocalizedDescriptionKey: "Speech recognition permission denied",
                ])
            }
        }

        do {
            try Self.configureAudioSession()
            self.captureMode = .pushToTalk
            try self.startRecognition()
            self.isListening = true
            self.isPushToTalkActive = true
            self.statusText = "Listening (PTT)"
        } catch {
            self.isListening = false
            self.isPushToTalkActive = false
            self.captureMode = .idle
            self.statusText = "Start failed: \(error.localizedDescription)"
            throw error
        }

        return OpenClawTalkPTTStartPayload(captureId: captureId)
    }

    func endPushToTalk() async -> OpenClawTalkPTTStopPayload {
        let captureId = self.activePTTCaptureId ?? UUID().uuidString
        guard self.isPushToTalkActive else {
            let payload = OpenClawTalkPTTStopPayload(
                captureId: captureId,
                transcript: nil,
                status: "idle")
            self.finishPTTOnce(payload)
            return payload
        }

        self.isPushToTalkActive = false
        self.isListening = false
        self.captureMode = .idle
        self.stopRecognition()
        self.pttTimeoutTask?.cancel()
        self.pttTimeoutTask = nil
        self.pttAutoStopEnabled = false

        let transcript = self.lastTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        self.lastTranscript = ""
        self.lastHeard = nil

        guard !transcript.isEmpty else {
            self.statusText = "Ready"
            if self.resumeContinuousAfterPTT {
                await self.start()
            }
            self.resumeContinuousAfterPTT = false
            self.activePTTCaptureId = nil
            let payload = OpenClawTalkPTTStopPayload(
                captureId: captureId,
                transcript: nil,
                status: "empty")
            self.finishPTTOnce(payload)
            return payload
        }

        guard self.gatewayConnected else {
            self.statusText = "Gateway not connected"
            if self.resumeContinuousAfterPTT {
                await self.start()
            }
            self.resumeContinuousAfterPTT = false
            self.activePTTCaptureId = nil
            let payload = OpenClawTalkPTTStopPayload(
                captureId: captureId,
                transcript: transcript,
                status: "offline")
            self.finishPTTOnce(payload)
            return payload
        }

        self.statusText = "Thinking…"
        Task { @MainActor in
            await self.processTranscript(transcript, restartAfter: self.resumeContinuousAfterPTT)
        }
        self.resumeContinuousAfterPTT = false
        self.activePTTCaptureId = nil
        let payload = OpenClawTalkPTTStopPayload(
            captureId: captureId,
            transcript: transcript,
            status: "queued")
        self.finishPTTOnce(payload)
        return payload
    }

    func runPushToTalkOnce(maxDurationSeconds: TimeInterval = 12) async throws -> OpenClawTalkPTTStopPayload {
        if self.pttCompletion != nil {
            _ = await self.cancelPushToTalk()
        }

        if self.isPushToTalkActive {
            let captureId = self.activePTTCaptureId ?? UUID().uuidString
            return OpenClawTalkPTTStopPayload(
                captureId: captureId,
                transcript: nil,
                status: "busy")
        }

        _ = try await self.beginPushToTalk()

        return await withCheckedContinuation { cont in
            self.pttCompletion = cont
            self.pttAutoStopEnabled = true
            self.startSilenceMonitor()
            self.schedulePTTTimeout(seconds: maxDurationSeconds)
        }
    }

    func cancelPushToTalk() async -> OpenClawTalkPTTStopPayload {
        let captureId = self.activePTTCaptureId ?? UUID().uuidString
        guard self.isPushToTalkActive else {
            let payload = OpenClawTalkPTTStopPayload(
                captureId: captureId,
                transcript: nil,
                status: "idle")
            self.finishPTTOnce(payload)
            self.pttAutoStopEnabled = false
            self.pttTimeoutTask?.cancel()
            self.pttTimeoutTask = nil
            self.resumeContinuousAfterPTT = false
            self.activePTTCaptureId = nil
            return payload
        }

        let shouldResume = self.resumeContinuousAfterPTT
        self.isPushToTalkActive = false
        self.isListening = false
        self.captureMode = .idle
        self.stopRecognition()
        self.lastTranscript = ""
        self.lastHeard = nil
        self.pttAutoStopEnabled = false
        self.pttTimeoutTask?.cancel()
        self.pttTimeoutTask = nil
        self.resumeContinuousAfterPTT = false
        self.activePTTCaptureId = nil
        self.statusText = "Ready"

        let payload = OpenClawTalkPTTStopPayload(
            captureId: captureId,
            transcript: nil,
            status: "cancelled")
        self.finishPTTOnce(payload)

        if shouldResume {
            await self.start()
        }
        return payload
    }

    private func startRecognition() throws {
        #if targetEnvironment(simulator)
            if self.allowSimulatorCapture {
                self.recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
                self.recognitionRequest?.shouldReportPartialResults = true
                return
            }
            if !self.allowSimulatorCapture {
                throw NSError(domain: "TalkMode", code: 2, userInfo: [
                    NSLocalizedDescriptionKey: "Talk mode is not supported on the iOS simulator",
                ])
            }
        #endif

        self.stopRecognition()
        self.speechRecognizer = SFSpeechRecognizer()
        guard let recognizer = self.speechRecognizer else {
            throw NSError(domain: "TalkMode", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Speech recognizer unavailable",
            ])
        }

        self.recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        self.recognitionRequest?.shouldReportPartialResults = true
        self.recognitionRequest?.taskHint = .dictation
        guard let request = self.recognitionRequest else { return }

        GatewayDiagnostics.log("talk audio: session \(Self.describeAudioSession())")

        let input = self.audioEngine.inputNode
        let format = input.inputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw NSError(domain: "TalkMode", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "Invalid audio input format",
            ])
        }
        input.removeTap(onBus: 0)
        let tapDiagnostics = AudioTapDiagnostics(label: "talk") { [weak self] level in
            guard let self else { return }
            Task { @MainActor in
                // Smooth + clamp for UI, and keep it cheap.
                let raw = max(0, min(Double(level) * 10.0, 1.0))
                let next = (self.micLevel * 0.80) + (raw * 0.20)
                self.micLevel = next

                // Dynamic thresholding so background noise doesn’t prevent endpointing.
                if self.isListening, !self.isSpeaking, !self.noiseFloorReady {
                    self.noiseFloorSamples.append(raw)
                    if self.noiseFloorSamples.count >= 22 {
                        let sorted = self.noiseFloorSamples.sorted()
                        let take = max(6, sorted.count / 2)
                        let slice = sorted.prefix(take)
                        let avg = slice.reduce(0.0, +) / Double(slice.count)
                        self.noiseFloor = avg
                        self.noiseFloorReady = true
                        self.noiseFloorSamples.removeAll(keepingCapacity: true)
                        let threshold = min(0.35, max(0.12, avg + 0.10))
                        GatewayDiagnostics.log(
                            "talk audio: noiseFloor=\(String(format: "%.3f", avg)) "
                                + "threshold=\(String(format: "%.3f", threshold))"
                        )
                    }
                }

                let threshold: Double = if let floor = self.noiseFloor, self.noiseFloorReady {
                    min(0.35, max(0.12, floor + 0.10))
                } else {
                    0.18
                }
                if raw >= threshold {
                    self.lastAudioActivity = Date()
                }
            }
        }
        self.audioTapDiagnostics = tapDiagnostics
        let tapBlock = Self.makeAudioTapAppendCallback(request: request, diagnostics: tapDiagnostics)
        input.installTap(onBus: 0, bufferSize: 2048, format: format, block: tapBlock)
        self.inputTapInstalled = true

        self.audioEngine.prepare()
        try self.audioEngine.start()
        self.loggedPartialThisCycle = false

        GatewayDiagnostics.log(
            "talk speech: recognition started mode=\(String(describing: self.captureMode)) "
                + "engineRunning=\(self.audioEngine.isRunning)"
        )
        self.recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let error {
                let msg = error.localizedDescription
                let lowered = msg.lowercased()
                let isCancellation = lowered.contains("cancelled") || lowered.contains("canceled")
                if isCancellation {
                    GatewayDiagnostics.log("talk speech: cancelled")
                    if self.captureMode == .continuous, self.isEnabled, !self.isSpeaking {
                        self.statusText = "Listening"
                    }
                    self.logger.debug("speech recognition cancelled")
                    return
                }
                GatewayDiagnostics.log("talk speech: error=\(msg)")
                if !self.isSpeaking {
                    if msg.localizedCaseInsensitiveContains("no speech detected") {
                        // Treat as transient silence. Don't scare users with an error banner.
                        self.statusText = self.isEnabled ? "Listening" : "Speech error: \(msg)"
                    } else {
                        self.statusText = "Speech error: \(msg)"
                    }
                }
                self.logger.debug("speech recognition error: \(msg, privacy: .public)")
                // Speech recognition can terminate on transient errors (e.g. no speech detected).
                // If talk mode is enabled and we're in continuous capture, try to restart.
                if self.captureMode == .continuous, self.isEnabled, !self.isSpeaking {
                    // Treat the task as terminal on error so we don't get stuck with a dead recognizer.
                    self.stopRecognition()
                    Task { @MainActor [weak self] in
                        await self?.restartRecognitionAfterError()
                    }
                }
            }
            guard let result else { return }
            let transcript = result.bestTranscription.formattedString
            if !result.isFinal, !self.loggedPartialThisCycle {
                let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    self.loggedPartialThisCycle = true
                    GatewayDiagnostics.log("talk speech: partial chars=\(trimmed.count)")
                }
            }
            Task { @MainActor in
                await self.handleTranscript(transcript: transcript, isFinal: result.isFinal)
            }
        }
    }

    private func restartRecognitionAfterError() async {
        guard self.isEnabled, self.captureMode == .continuous else { return }
        // Avoid thrashing the audio engine if it’s already running.
        if self.recognitionTask != nil, self.audioEngine.isRunning { return }
        try? await Task.sleep(nanoseconds: 250_000_000)
        guard self.isEnabled, self.captureMode == .continuous else { return }
        do {
            try Self.configureAudioSession()
            try self.startRecognition()
            self.isListening = true
            if self.statusText.localizedCaseInsensitiveContains("speech error") {
                self.statusText = "Listening"
            }
            GatewayDiagnostics.log("talk speech: recognition restarted")
        } catch {
            let msg = error.localizedDescription
            GatewayDiagnostics.log("talk speech: restart failed error=\(msg)")
        }
    }

    private func stopRecognition() {
        self.recognitionTask?.cancel()
        self.recognitionTask = nil
        self.recognitionRequest?.endAudio()
        self.recognitionRequest = nil
        self.micLevel = 0
        self.lastAudioActivity = nil
        self.noiseFloorSamples.removeAll(keepingCapacity: true)
        self.noiseFloor = nil
        self.noiseFloorReady = false
        self.audioTapDiagnostics = nil
        if self.inputTapInstalled {
            self.audioEngine.inputNode.removeTap(onBus: 0)
            self.inputTapInstalled = false
        }
        self.audioEngine.stop()
        self.speechRecognizer = nil
    }

    // MARK: - Realtime splice.
    //
    // The realtime path replaces the SFSpeechRecognizer + HTTP TTS flow with a
    // single bidirectional WebSocket session. Microphone buffers are resampled to
    // 24 kHz PCM16 and streamed out as `input_audio_buffer.append`; assistant
    // audio deltas come back over the same socket and are pushed into the
    // existing `PCMStreamingAudioPlayer` bus (same player the Tier 1 TTS path
    // uses, so we don't double up output).
    //
    // Invariant: everything provider-specific (OpenAI vs Azure) already lives in
    // `VoiceProviderEndpoints.swift` via the factory; this splice never branches
    // on provider kind.

    /// Bring up the realtime mic pipeline. On success the mic tap is live and the
    /// runtime is connected to the chosen deployment; on failure we throw so the
    /// caller can fall back to the Tier 1 path.
    private func startRealtimeRecognition(config: RealtimeCapabilityConfig) async throws {
        // Tear any stale Tier 1 recognizer state down so the mic tap we install
        // below owns bus 0 exclusively. Safe to call when idle.
        self.stopRecognition()

        GatewayDiagnostics.log("talk audio: session \(Self.describeAudioSession())")

        #if targetEnvironment(simulator)
            // The simulator cannot reliably tap the mic for live realtime audio,
            // but the session actor + connect logic still need to be exercised in
            // test builds. Skip the mic install and let the runtime connect; tests
            // drive audio through `_test_` helpers below.
            if !self.allowSimulatorCapture {
                throw NSError(domain: "TalkMode", code: 8, userInfo: [
                    NSLocalizedDescriptionKey: "Realtime mic capture is not supported on the iOS simulator",
                ])
            }
        #else
            try self.installRealtimeMicTap()
        #endif

        let runtime = self.talkRealtimeRuntime
        runtime.delegate = self.makeRealtimeDelegate()
        do {
            try await runtime.start(
                config: config,
                factoryOverride: self.realtimeWebSocketFactoryOverride)
        } catch {
            self.teardownRealtimeMicTap()
            throw error
        }
    }

    /// Install the realtime mic tap. Reuses `AudioTapDiagnostics` so the UI level
    /// meter and barge-in threshold stay consistent with Tier 1. The tap block
    /// is `nonisolated` (runs on an AVAudioEngine-owned queue), so it hops back to
    /// `MainActor` for every resampled frame send.
    private func installRealtimeMicTap() throws {
        let input = self.audioEngine.inputNode
        let format = input.inputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw NSError(domain: "TalkMode", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "Invalid audio input format",
            ])
        }
        input.removeTap(onBus: 0)
        let resampler = RealtimeAudioResampler()
        self.realtimeResampler = resampler
        let tapDiagnostics = self.makeMicVADDiagnostics()
        self.audioTapDiagnostics = tapDiagnostics
        let runtime = self.talkRealtimeRuntime
        let tapBlock = Self.makeRealtimeAudioTapCallback(
            resampler: resampler,
            diagnostics: tapDiagnostics) { [weak runtime] frames in
            // Hop to the main actor to feed the runtime. The frame list is small
            // (0–2 frames per tap given 40ms frames + ~80ms tap buffer), so we
            // avoid per-frame Task churn here.
            guard let runtime else { return }
            Task { @MainActor in
                for frame in frames {
                    try? await runtime.sendAudio(pcm16: frame)
                }
            }
        }
        input.installTap(onBus: 0, bufferSize: 2048, format: format, block: tapBlock)
        self.inputTapInstalled = true
        self.audioEngine.prepare()
        try self.audioEngine.start()
    }

    /// Factored so unit tests can assert the resampler <-> runtime edge without
    /// touching AVAudioEngine. Returns a tap block that, for every PCM buffer:
    ///   1. Runs the existing VAD diagnostics (level smoothing, noise floor).
    ///   2. Resamples to 24 kHz PCM16 and forwards complete 40 ms frames to
    ///      `onFrames` (a callback the caller wires to the runtime).
    nonisolated static func makeRealtimeAudioTapCallback(
        resampler: RealtimeAudioResampler,
        diagnostics: AudioTapDiagnostics,
        onFrames: @escaping @Sendable ([Data]) -> Void
    ) -> AVAudioNodeTapBlock {
        { buffer, _ in
            diagnostics.onBuffer(buffer)
            guard let data = buffer.floatChannelData?.pointee else { return }
            let n = Int(buffer.frameLength)
            guard n > 0 else { return }
            var samples = [Float](repeating: 0, count: n)
            for i in 0..<n {
                samples[i] = data[i]
            }
            let frames = resampler.append(
                floatSamples: samples,
                sourceSampleRate: buffer.format.sampleRate)
            if !frames.isEmpty {
                onFrames(frames)
            }
        }
    }

    /// Create the VAD/level-meter diagnostics bound to the current instance. The
    /// callback also powers barge-in: when the user's mic exceeds the threshold
    /// while realtime playback is active, we interrupt the response.
    private func makeMicVADDiagnostics() -> AudioTapDiagnostics {
        AudioTapDiagnostics(label: "talk-realtime") { [weak self] level in
            guard let self else { return }
            Task { @MainActor in
                let raw = max(0, min(Double(level) * 10.0, 1.0))
                let next = (self.micLevel * 0.80) + (raw * 0.20)
                self.micLevel = next

                if self.realtimeActive, !self.isSpeaking, !self.noiseFloorReady {
                    self.noiseFloorSamples.append(raw)
                    if self.noiseFloorSamples.count >= 22 {
                        let sorted = self.noiseFloorSamples.sorted()
                        let take = max(6, sorted.count / 2)
                        let slice = sorted.prefix(take)
                        let avg = slice.reduce(0.0, +) / Double(slice.count)
                        self.noiseFloor = avg
                        self.noiseFloorReady = true
                        self.noiseFloorSamples.removeAll(keepingCapacity: true)
                    }
                }

                let threshold: Double = if let floor = self.noiseFloor, self.noiseFloorReady {
                    min(0.35, max(0.12, floor + 0.10))
                } else {
                    0.18
                }
                if raw >= threshold {
                    self.lastAudioActivity = Date()
                    // Barge-in: if the assistant is speaking back through the PCM
                    // bus, cut playback and cancel the in-flight response over the
                    // WS so the server stops generating more audio.
                    if self.isSpeaking,
                       self.interruptOnSpeech,
                       self.shouldAllowSpeechInterruptForCurrentRoute()
                    {
                        await self.handleRealtimeBargeIn()
                    }
                }
            }
        }
    }

    /// Build the delegate forwarded to `TalkRealtimeSessionRuntime`. The delegate
    /// stitches together transcript updates, assistant audio playback, fallback
    /// logging, and graceful degrade to Tier 1 on unrecoverable errors.
    private func makeRealtimeDelegate() -> TalkRealtimeSessionRuntime.Delegate {
        var delegate = TalkRealtimeSessionRuntime.Delegate()
        delegate.onConnected = { [weak self] deployment in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.logger.info("realtime connected deployment=\(deployment, privacy: .public)")
                GatewayDiagnostics.log("talk realtime: connected deployment=\(deployment)")
            }
        }
        delegate.onFinalTranscript = { [weak self] text in
            Task { @MainActor [weak self] in
                guard let self else { return }
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { return }
                self.lastTranscript = trimmed
                self.lastHeard = Date()
                GatewayDiagnostics.log("talk realtime: final transcript chars=\(trimmed.count)")
            }
        }
        delegate.onAssistantTextDelta = { [weak self] text in
            Task { @MainActor [weak self] in
                guard let self else { return }
                guard !text.isEmpty else { return }
                // Mirror Tier 1's lightweight transcript presentation: keep the
                // last-spoken text updated so `stopSpeaking()` has something to
                // compare against for barge-in suppression. Full chat surface
                // mirroring lives on the server event stream and arrives via the
                // same history fetch used by Tier 1.
                let appended = (self.lastSpokenText ?? "") + text
                self.lastSpokenText = appended
            }
        }
        delegate.onAssistantAudioChunk = { [weak self] pcm16 in
            Task { @MainActor [weak self] in
                self?.enqueueRealtimeAssistantAudio(pcm16: pcm16)
            }
        }
        delegate.onFallbackActivated = { [weak self] from, to, reason in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.logger.warning(
                    "realtime fallback from=\(from, privacy: .public) to=\(to, privacy: .public) reason=\(reason.rawValue, privacy: .public)")
                GatewayDiagnostics.log(
                    "talk realtime: fallback from=\(from) to=\(to) reason=\(reason.rawValue)")
            }
        }
        delegate.onReconnectScheduled = { [weak self] attempt, delayMs in
            Task { @MainActor [weak self] in
                self?.logger.info("realtime reconnect attempt=\(attempt) delayMs=\(delayMs)")
                GatewayDiagnostics.log(
                    "talk realtime: reconnect scheduled attempt=\(attempt) delayMs=\(delayMs)")
            }
        }
        delegate.onError = { [weak self] error in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.logger.error("realtime error: \(error.message, privacy: .public)")
                GatewayDiagnostics.log("talk realtime: error msg=\(error.message)")
                // Unrecoverable error: flip degrade, close the session, and let
                // the next `start()` fall through to the Tier 1 path.
                self.realtimeDegraded = true
                await self.tearDownRealtimeSession()
                if self.isEnabled {
                    await self.start()
                }
            }
        }
        delegate.onClosed = { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.logger.info("realtime closed")
                GatewayDiagnostics.log("talk realtime: closed")
                // Clean close from the peer — finish any buffered playback and
                // leave `realtimeDegraded` alone; user can reopen Talk Mode.
                self.realtimeAudioFeed?.finish()
                self.realtimeAudioFeed = nil
            }
        }
        return delegate
    }

    /// Push a PCM16 24 kHz chunk into the playback feeder, lazily starting the
    /// playback task on the first chunk.
    private func enqueueRealtimeAssistantAudio(pcm16: Data) {
        guard !pcm16.isEmpty else { return }
        if self.realtimeAudioFeed == nil {
            self.startRealtimePlaybackFeed()
        }
        self.realtimeAudioFeed?.yield(pcm16)
    }

    /// Start a single long-lived playback task that drains PCM chunks from the
    /// realtime session into `pcmPlayer`. Using one task per session keeps the
    /// `PCMStreamingAudioPlayer` queue stable across multiple assistant turns —
    /// otherwise each `play(stream:)` call would race the next chunk arriving.
    private func startRealtimePlaybackFeed() {
        let stream = AsyncThrowingStream<Data, Error> { continuation in
            self.realtimeAudioFeed = continuation
        }
        let player = self.pcmPlayer
        self.lastPlaybackWasPCM = true
        self.isSpeaking = true
        self.statusText = "Speaking…"
        self.realtimePlaybackTask = Task { @MainActor [weak self] in
            let result = await player.play(
                stream: stream,
                sampleRate: RealtimeAudioResampler.Constants.targetSampleRate)
            guard let self else { return }
            if !result.finished, let interruptedAt = result.interruptedAt {
                self.lastInterruptedAtSeconds = interruptedAt
            }
            self.isSpeaking = false
            self.realtimePlaybackTask = nil
            self.realtimeAudioFeed = nil
            if self.realtimeActive, self.isEnabled {
                self.statusText = "Listening"
            }
        }
    }

    /// Barge-in: stop playback immediately, tell the server to cancel the
    /// in-flight response, and reset for the next user utterance.
    private func handleRealtimeBargeIn() async {
        // Stop any buffered PCM playback first so we don't continue speaking over
        // the user even if the WS cancel takes a moment to round-trip.
        _ = self.pcmPlayer.stop()
        self.realtimeAudioFeed?.finish()
        self.realtimeAudioFeed = nil
        self.realtimePlaybackTask?.cancel()
        self.realtimePlaybackTask = nil
        self.isSpeaking = false
        self.lastInterruptedAtSeconds = Date().timeIntervalSince1970
        do {
            try await self.talkRealtimeRuntime.cancelActiveResponse()
            GatewayDiagnostics.log("talk realtime: barge-in cancelled active response")
        } catch {
            self.logger.warning(
                "realtime cancel failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Tear down everything owned by the realtime splice. Idempotent.
    private func tearDownRealtimeSession() async {
        self.realtimeAudioFeed?.finish()
        self.realtimeAudioFeed = nil
        self.realtimePlaybackTask?.cancel()
        self.realtimePlaybackTask = nil
        _ = self.pcmPlayer.stop()
        self.teardownRealtimeMicTap()
        await self.talkRealtimeRuntime.close()
        self.realtimeActive = false
    }

    /// Remove the mic tap and stop the engine if we installed it for realtime.
    /// Mirrors the Tier 1 `stopRecognition()` mic teardown but without touching
    /// SFSpeechRecognizer state (which the realtime path never wires up).
    private func teardownRealtimeMicTap() {
        self.realtimeResampler?.reset()
        self.realtimeResampler = nil
        self.audioTapDiagnostics = nil
        if self.inputTapInstalled {
            self.audioEngine.inputNode.removeTap(onBus: 0)
            self.inputTapInstalled = false
        }
        if self.audioEngine.isRunning {
            self.audioEngine.stop()
        }
        self.micLevel = 0
        self.noiseFloorSamples.removeAll(keepingCapacity: true)
        self.noiseFloor = nil
        self.noiseFloorReady = false
    }

    private nonisolated static func makeAudioTapAppendCallback(
        request: SpeechRequest,
        diagnostics: AudioTapDiagnostics) -> AVAudioNodeTapBlock
    {
        { buffer, _ in
            request.append(buffer)
            diagnostics.onBuffer(buffer)
        }
    }

    private func handleTranscript(transcript: String, isFinal: Bool) async {
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        let ttsActive = self.isSpeechOutputActive
        if ttsActive, self.interruptOnSpeech {
            if self.shouldInterrupt(with: trimmed) {
                self.stopSpeaking()
            }
            return
        }

        guard self.isListening else { return }
        if !trimmed.isEmpty {
            self.lastTranscript = trimmed
            self.lastHeard = Date()
        }
        if isFinal {
            self.lastTranscript = trimmed
            guard !trimmed.isEmpty else { return }
            GatewayDiagnostics.log("talk speech: final transcript chars=\(trimmed.count)")
            self.loggedPartialThisCycle = false
            if self.captureMode == .pushToTalk, self.pttAutoStopEnabled, self.isPushToTalkActive {
                _ = await self.endPushToTalk()
                return
            }
            if self.captureMode == .continuous, !self.isSpeechOutputActive {
                await self.processTranscript(trimmed, restartAfter: true)
            }
        }
    }

    private func startSilenceMonitor() {
        self.silenceTask?.cancel()
        self.silenceTask = Task { [weak self] in
            guard let self else { return }
            while self.isEnabled || (self.isPushToTalkActive && self.pttAutoStopEnabled) {
                try? await Task.sleep(nanoseconds: 200_000_000)
                await self.checkSilence()
            }
        }
    }

    private func checkSilence() async {
        if self.captureMode == .continuous {
            guard self.isListening, !self.isSpeechOutputActive else { return }
            let transcript = self.lastTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !transcript.isEmpty else { return }
            let lastActivity = [self.lastHeard, self.lastAudioActivity].compactMap { $0 }.max()
            guard let lastActivity else { return }
            if Date().timeIntervalSince(lastActivity) < self.silenceWindow { return }
            await self.processTranscript(transcript, restartAfter: true)
            return
        }

        guard self.captureMode == .pushToTalk, self.pttAutoStopEnabled else { return }
        guard self.isListening, !self.isSpeaking, self.isPushToTalkActive else { return }
        let transcript = self.lastTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !transcript.isEmpty else { return }
        let lastActivity = [self.lastHeard, self.lastAudioActivity].compactMap { $0 }.max()
        guard let lastActivity else { return }
        if Date().timeIntervalSince(lastActivity) < self.silenceWindow { return }
        _ = await self.endPushToTalk()
    }

    // Guardrail for PTT once so we don't stay open indefinitely.
    private func schedulePTTTimeout(seconds: TimeInterval) {
        guard seconds > 0 else { return }
        let nanos = UInt64(seconds * 1_000_000_000)
        self.pttTimeoutTask?.cancel()
        self.pttTimeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: nanos)
            await self?.handlePTTTimeout()
        }
    }

    private func handlePTTTimeout() async {
        guard self.pttAutoStopEnabled, self.isPushToTalkActive else { return }
        _ = await self.endPushToTalk()
    }

    private func finishPTTOnce(_ payload: OpenClawTalkPTTStopPayload) {
        guard let continuation = self.pttCompletion else { return }
        self.pttCompletion = nil
        continuation.resume(returning: payload)
    }

    private func processTranscript(_ transcript: String, restartAfter: Bool) async {
        self.isListening = false
        self.captureMode = .idle
        self.statusText = "Thinking…"
        self.lastTranscript = ""
        self.lastHeard = nil
        self.stopRecognition()

        GatewayDiagnostics.log("talk: process transcript chars=\(transcript.count) restartAfter=\(restartAfter)")
        await self.reloadConfig()
        let prompt = self.buildPrompt(transcript: transcript)
        guard self.gatewayConnected, let gateway else {
            self.statusText = "Gateway not connected"
            self.logger.warning("finalize: gateway not connected")
            GatewayDiagnostics.log("talk: abort gateway not connected")
            if restartAfter {
                await self.start()
            }
            return
        }

        do {
            let startedAt = Date().timeIntervalSince1970
            let sessionKey = self.mainSessionKey
            await self.subscribeChatIfNeeded(sessionKey: sessionKey)
            self.logger.info(
                "chat.send start sessionKey=\(sessionKey, privacy: .public) chars=\(prompt.count, privacy: .public)")
            GatewayDiagnostics.log("talk: chat.send start sessionKey=\(sessionKey) chars=\(prompt.count)")
            let runId = try await self.sendChat(prompt, gateway: gateway)
            self.logger.info("chat.send ok runId=\(runId, privacy: .public)")
            GatewayDiagnostics.log("talk: chat.send ok runId=\(runId)")
            let shouldIncremental = self.shouldUseIncrementalTTS()
            var streamingTask: Task<Void, Never>?
            if shouldIncremental {
                self.resetIncrementalSpeech()
                streamingTask = Task { @MainActor [weak self] in
                    guard let self else { return }
                    await self.streamAssistant(runId: runId, gateway: gateway)
                }
            }
            let completion = await self.waitForChatCompletion(runId: runId, gateway: gateway, timeoutSeconds: 120)
            if completion == .timeout {
                self.logger.warning(
                    "chat completion timeout runId=\(runId, privacy: .public); attempting history fallback")
                GatewayDiagnostics.log("talk: chat completion timeout runId=\(runId)")
            } else if completion == .aborted {
                self.statusText = "Aborted"
                self.logger.warning("chat completion aborted runId=\(runId, privacy: .public)")
                GatewayDiagnostics.log("talk: chat completion aborted runId=\(runId)")
                streamingTask?.cancel()
                await self.finishIncrementalSpeech()
                await self.start()
                return
            } else if completion == .error {
                self.statusText = "Chat error"
                self.logger.warning("chat completion error runId=\(runId, privacy: .public)")
                GatewayDiagnostics.log("talk: chat completion error runId=\(runId)")
                streamingTask?.cancel()
                await self.finishIncrementalSpeech()
                await self.start()
                return
            }

            var assistantText = try await self.waitForAssistantText(
                gateway: gateway,
                since: startedAt,
                timeoutSeconds: completion == .final ? 12 : 25)
            if assistantText == nil, shouldIncremental {
                let fallback = self.incrementalSpeechBuffer.latestText
                if !fallback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    assistantText = fallback
                }
            }
            guard let assistantText else {
                self.statusText = "No reply"
                self.logger.warning("assistant text timeout runId=\(runId, privacy: .public)")
                GatewayDiagnostics.log("talk: assistant text timeout runId=\(runId)")
                streamingTask?.cancel()
                await self.finishIncrementalSpeech()
                await self.start()
                return
            }
            self.logger.info("assistant text ok chars=\(assistantText.count, privacy: .public)")
            GatewayDiagnostics.log("talk: assistant text ok chars=\(assistantText.count)")
            streamingTask?.cancel()
            if shouldIncremental {
                await self.handleIncrementalAssistantFinal(text: assistantText)
            } else {
                await self.playAssistant(text: assistantText)
            }
        } catch {
            self.statusText = "Talk failed: \(error.localizedDescription)"
            self.logger.error("finalize failed: \(error.localizedDescription, privacy: .public)")
            GatewayDiagnostics.log("talk: failed error=\(error.localizedDescription)")
        }

        if restartAfter {
            await self.start()
        }
    }

    private func subscribeChatIfNeeded(sessionKey: String) async {
        let key = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return }
        guard !self.chatSubscribedSessionKeys.contains(key) else { return }

        // Operator clients receive chat events without node-style subscriptions.
        self.chatSubscribedSessionKeys.insert(key)
    }

    private func unsubscribeAllChats() async {
        self.chatSubscribedSessionKeys.removeAll()
    }

    private func buildPrompt(transcript: String) -> String {
        let interrupted = self.lastInterruptedAtSeconds
        self.lastInterruptedAtSeconds = nil
        return TalkPromptBuilder.build(
            transcript: transcript,
            interruptedAtSeconds: interrupted,
            includeVoiceDirectiveHint: false)
    }

    private enum ChatCompletionState: CustomStringConvertible {
        case final
        case aborted
        case error
        case timeout

        var description: String {
            switch self {
            case .final: "final"
            case .aborted: "aborted"
            case .error: "error"
            case .timeout: "timeout"
            }
        }
    }

    private func sendChat(_ message: String, gateway: GatewayNodeSession) async throws -> String {
        struct SendResponse: Decodable { let runId: String }
        let payload: [String: Any] = [
            "sessionKey": self.mainSessionKey,
            "message": message,
            "thinking": "low",
            "timeoutMs": 30000,
            "idempotencyKey": UUID().uuidString,
        ]
        let data = try JSONSerialization.data(withJSONObject: payload)
        guard let json = String(bytes: data, encoding: .utf8) else {
            throw NSError(
                domain: "TalkModeManager",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Failed to encode chat payload"])
        }
        let res = try await gateway.request(method: "chat.send", paramsJSON: json, timeoutSeconds: 30)
        let decoded = try JSONDecoder().decode(SendResponse.self, from: res)
        return decoded.runId
    }

    private func waitForChatCompletion(
        runId: String,
        gateway: GatewayNodeSession,
        timeoutSeconds: Int = 120) async -> ChatCompletionState
    {
        let stream = await gateway.subscribeServerEvents(bufferingNewest: 200)
        return await withTaskGroup(of: ChatCompletionState.self) { group in
            group.addTask { [runId] in
                for await evt in stream {
                    if Task.isCancelled { return .timeout }
                    guard evt.event == "chat", let payload = evt.payload else { continue }
                    guard let chatEvent = try? GatewayPayloadDecoding.decode(payload, as: ChatEvent.self) else {
                        continue
                    }
                    guard chatEvent.runid == runId else { continue }
                    if let state = chatEvent.state.value as? String {
                        switch state {
                        case "final": return .final
                        case "aborted": return .aborted
                        case "error": return .error
                        default: break
                        }
                    }
                }
                return .timeout
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds) * 1_000_000_000)
                return .timeout
            }
            let result = await group.next() ?? .timeout
            group.cancelAll()
            return result
        }
    }

    private func waitForAssistantText(
        gateway: GatewayNodeSession,
        since: Double,
        timeoutSeconds: Int) async throws -> String?
    {
        let deadline = Date().addingTimeInterval(TimeInterval(timeoutSeconds))
        while Date() < deadline {
            if let text = try await self.fetchLatestAssistantText(gateway: gateway, since: since) {
                return text
            }
            try? await Task.sleep(nanoseconds: 300_000_000)
        }
        return nil
    }

    private func fetchLatestAssistantText(gateway: GatewayNodeSession, since: Double? = nil) async throws -> String? {
        let res = try await gateway.request(
            method: "chat.history",
            paramsJSON: "{\"sessionKey\":\"\(self.mainSessionKey)\"}",
            timeoutSeconds: 15)
        guard let json = try JSONSerialization.jsonObject(with: res) as? [String: Any] else { return nil }
        guard let messages = json["messages"] as? [[String: Any]] else { return nil }
        for msg in messages.reversed() {
            guard (msg["role"] as? String) == "assistant" else { continue }
            if let since, let timestamp = msg["timestamp"] as? Double,
               TalkHistoryTimestamp.isAfter(timestamp, sinceSeconds: since) == false
            {
                continue
            }
            guard let content = msg["content"] as? [[String: Any]] else { continue }
            let text = content.compactMap { $0["text"] as? String }.joined(separator: "\n")
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
        return nil
    }

    private func playAssistant(text: String) async {
        let parsed = TalkDirectiveParser.parse(text)
        let directive = parsed.directive
        let cleaned = parsed.stripped.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return }
        self.applyDirective(directive)

        self.statusText = "Generating voice…"
        self.isSpeaking = true
        self.lastSpokenText = cleaned

        do {
            let started = Date()
            let language = ElevenLabsTTSClient.validatedLanguage(directive?.language)
            let requestedVoice = directive?.voiceId?.trimmingCharacters(in: .whitespacesAndNewlines)
            let resolvedVoice = self.resolveVoiceAlias(requestedVoice)
            if requestedVoice?.isEmpty == false, resolvedVoice == nil {
                self.logger.warning("unknown voice alias \(requestedVoice ?? "?", privacy: .public)")
            }

            let configuredKey = self.apiKey?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? self.apiKey : nil
            #if DEBUG
            let resolvedKey = configuredKey ?? ProcessInfo.processInfo.environment["ELEVENLABS_API_KEY"]
            #else
            let resolvedKey = configuredKey
            #endif
            let apiKey = resolvedKey?.trimmingCharacters(in: .whitespacesAndNewlines)
            let preferredVoice = resolvedVoice ?? self.currentVoiceId ?? self.defaultVoiceId
            let voiceId: String? = if let apiKey, !apiKey.isEmpty {
                await self.resolveVoiceId(preferred: preferredVoice, apiKey: apiKey)
            } else {
                nil
            }
            let canUseElevenLabs = (voiceId?.isEmpty == false) && (apiKey?.isEmpty == false)

            // Route OpenAI / Azure-OpenAI ahead of the ElevenLabs branch. When the
            // provider surface maps to an OpenAI-compatible provider, we use the
            // generic TTS runtime. Any failure here falls through to system voice
            // rather than to the ElevenLabs path (which would fail without a key).
            if let openAIConfig = self.resolveOpenAICompatibleTTSConfig(directive: directive) {
                GatewayDiagnostics.log(
                    "talk tts: provider=\(openAIConfig.kind.rawValue) voice=\(openAIConfig.voice) model=\(openAIConfig.model)")
                if self.interruptOnSpeech {
                    do { try self.startRecognition() } catch {
                        self.logger.warning(
                            "startRecognition during speak failed: \(error.localizedDescription, privacy: .public)")
                    }
                }
                self.statusText = "Speaking…"
                self.lastPlaybackWasPCM = (openAIConfig.responseFormat == .pcm)
                do {
                    let result = try await self.openAIRuntime.speak(text: cleaned, config: openAIConfig)
                    let duration = Date().timeIntervalSince(started)
                    self.logger
                        .info("openai-tts stream finished=\(result.finished, privacy: .public) dur=\(duration, privacy: .public)s")
                    if !result.finished, let interruptedAt = result.interruptedAt {
                        self.lastInterruptedAtSeconds = interruptedAt
                    }
                    self.stopRecognition()
                    self.isSpeaking = false
                    return
                } catch {
                    self.logger.error(
                        "openai-tts failed: \(error.localizedDescription, privacy: .public); falling back to system voice")
                    GatewayDiagnostics.log(
                        "talk tts: provider=\(openAIConfig.kind.rawValue) error msg=\(error.localizedDescription)")
                    // Fall through to system-voice path below.
                    self.statusText = "Speaking (System)…"
                    do {
                        try await TalkSystemSpeechSynthesizer.shared.speak(text: cleaned, language: language)
                    } catch {
                        self.statusText = "Speak failed: \(error.localizedDescription)"
                    }
                    self.stopRecognition()
                    self.isSpeaking = false
                    return
                }
            }

            if canUseElevenLabs, let voiceId, let apiKey {
                GatewayDiagnostics.log("talk tts: provider=elevenlabs voiceId=\(voiceId)")
                let desiredOutputFormat = (directive?.outputFormat ?? self.defaultOutputFormat)?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                let requestedOutputFormat = (desiredOutputFormat?.isEmpty == false) ? desiredOutputFormat : nil
                let outputFormat = ElevenLabsTTSClient.validatedOutputFormat(
                    requestedOutputFormat ?? self.effectiveDefaultOutputFormat)
                if outputFormat == nil, let requestedOutputFormat {
                    self.logger.warning(
                        "talk output_format unsupported for local playback: \(requestedOutputFormat, privacy: .public)")
                }

                let modelId = directive?.modelId ?? self.currentModelId ?? self.defaultModelId
                if let modelId {
                    GatewayDiagnostics.log("talk tts: modelId=\(modelId)")
                }
                func makeRequest(outputFormat: String?) -> ElevenLabsTTSRequest {
                    ElevenLabsTTSRequest(
                        text: cleaned,
                        modelId: modelId,
                        outputFormat: outputFormat,
                        speed: TalkTTSValidation.resolveSpeed(speed: directive?.speed, rateWPM: directive?.rateWPM),
                        stability: TalkTTSValidation.validatedStability(directive?.stability, modelId: modelId),
                        similarity: TalkTTSValidation.validatedUnit(directive?.similarity),
                        style: TalkTTSValidation.validatedUnit(directive?.style),
                        speakerBoost: directive?.speakerBoost,
                        seed: TalkTTSValidation.validatedSeed(directive?.seed),
                        normalize: ElevenLabsTTSClient.validatedNormalize(directive?.normalize),
                        language: language,
                        latencyTier: TalkTTSValidation.validatedLatencyTier(directive?.latencyTier))
                }

                let request = makeRequest(outputFormat: outputFormat)

                let client = ElevenLabsTTSClient(apiKey: apiKey)
                let rawStream = client.streamSynthesize(voiceId: voiceId, request: request)

                if self.interruptOnSpeech {
                    do {
                        try self.startRecognition()
                    } catch {
                        self.logger.warning(
                            "startRecognition during speak failed: \(error.localizedDescription, privacy: .public)")
                    }
                }

                self.statusText = "Speaking…"
                let sampleRate = TalkTTSValidation.pcmSampleRate(from: outputFormat)
                let result: StreamingPlaybackResult
                if let sampleRate {
                    let streamFailure = StreamFailureBox()
                    let stream = Self.monitorStreamFailures(rawStream, failureBox: streamFailure)
                    self.lastPlaybackWasPCM = true
                    var playback = await self.pcmPlayer.play(stream: stream, sampleRate: sampleRate)
                    if !playback.finished, playback.interruptedAt == nil {
                        let mp3Format = ElevenLabsTTSClient.validatedOutputFormat("mp3_44100_128")
                        self.logger.warning("pcm playback failed; retrying mp3")
                        if Self.isPCMFormatRejectedByAPI(streamFailure.value) {
                            self.pcmFormatUnavailable = true
                        }
                        self.lastPlaybackWasPCM = false
                        let mp3Stream = client.streamSynthesize(
                            voiceId: voiceId,
                            request: makeRequest(outputFormat: mp3Format))
                        playback = await self.mp3Player.play(stream: mp3Stream)
                    }
                    result = playback
                } else {
                    self.lastPlaybackWasPCM = false
                    result = await self.mp3Player.play(stream: rawStream)
                }
                let duration = Date().timeIntervalSince(started)
                self.logger.info("elevenlabs stream finished=\(result.finished, privacy: .public) dur=\(duration, privacy: .public)s")
                if !result.finished, let interruptedAt = result.interruptedAt {
                    self.lastInterruptedAtSeconds = interruptedAt
                }
            } else {
                self.logger.warning("tts unavailable; falling back to system voice (missing key or voiceId)")
                GatewayDiagnostics.log("talk tts: provider=system (missing key or voiceId)")
                if self.interruptOnSpeech {
                    do {
                        try self.startRecognition()
                    } catch {
                        self.logger.warning(
                            "startRecognition during speak failed: \(error.localizedDescription, privacy: .public)")
                    }
                }
                self.statusText = "Speaking (System)…"
                try await TalkSystemSpeechSynthesizer.shared.speak(text: cleaned, language: language)
            }
        } catch {
            self.logger.error(
                "tts failed: \(error.localizedDescription, privacy: .public); falling back to system voice")
            GatewayDiagnostics.log("talk tts: provider=system (error) msg=\(error.localizedDescription)")
            do {
                if self.interruptOnSpeech {
                    do {
                        try self.startRecognition()
                    } catch {
                        self.logger.warning(
                            "startRecognition during speak failed: \(error.localizedDescription, privacy: .public)")
                    }
                }
                self.statusText = "Speaking (System)…"
                let language = ElevenLabsTTSClient.validatedLanguage(directive?.language)
                try await TalkSystemSpeechSynthesizer.shared.speak(text: cleaned, language: language)
            } catch {
                self.statusText = "Speak failed: \(error.localizedDescription)"
                self.logger.error("system voice failed: \(error.localizedDescription, privacy: .public)")
            }
        }

        self.stopRecognition()
        self.isSpeaking = false
    }

    private func stopSpeaking(storeInterruption: Bool = true) {
        let hasIncremental = self.incrementalSpeechActive ||
            self.incrementalSpeechTask != nil ||
            !self.incrementalSpeechQueue.isEmpty
        if self.isSpeaking {
            let interruptedAt = self.lastPlaybackWasPCM
                ? self.pcmPlayer.stop()
                : self.mp3Player.stop()
            if storeInterruption {
                self.lastInterruptedAtSeconds = interruptedAt
            }
            _ = self.lastPlaybackWasPCM
                ? self.mp3Player.stop()
                : self.pcmPlayer.stop()
        } else if !hasIncremental {
            return
        }
        TalkSystemSpeechSynthesizer.shared.stop()
        self.cancelIncrementalSpeech()
        self.isSpeaking = false
    }

    private func shouldInterrupt(with transcript: String) -> Bool {
        guard self.shouldAllowSpeechInterruptForCurrentRoute() else { return false }
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 3 else { return false }
        if let spoken = self.lastSpokenText?.lowercased(), spoken.contains(trimmed.lowercased()) {
            return false
        }
        return true
    }

    private func shouldAllowSpeechInterruptForCurrentRoute() -> Bool {
        let route = AVAudioSession.sharedInstance().currentRoute
        // Built-in speaker/receiver often feeds TTS back into STT, causing false interrupts.
        // Allow barge-in for isolated outputs (headphones/Bluetooth/USB/CarPlay/AirPlay).
        return !route.outputs.contains { output in
            switch output.portType {
            case .builtInSpeaker, .builtInReceiver:
                return true
            default:
                return false
            }
        }
    }

    private func shouldUseIncrementalTTS() -> Bool {
        true
    }

    private var isSpeechOutputActive: Bool {
        self.isSpeaking ||
            self.incrementalSpeechActive ||
            self.incrementalSpeechTask != nil ||
            !self.incrementalSpeechQueue.isEmpty
    }

    private func applyDirective(_ directive: TalkDirective?) {
        let requestedVoice = directive?.voiceId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedVoice = self.resolveVoiceAlias(requestedVoice)
        if requestedVoice?.isEmpty == false, resolvedVoice == nil {
            self.logger.warning("unknown voice alias \(requestedVoice ?? "?", privacy: .public)")
        }
        if let voice = resolvedVoice {
            if directive?.once != true {
                self.currentVoiceId = voice
                self.voiceOverrideActive = true
            }
        }
        if let model = directive?.modelId {
            if directive?.once != true {
                self.currentModelId = model
                self.modelOverrideActive = true
            }
        }
    }

    private func resetIncrementalSpeech() {
        self.incrementalSpeechQueue.removeAll()
        self.incrementalSpeechTask?.cancel()
        self.incrementalSpeechTask = nil
        self.cancelIncrementalPrefetch()
        self.incrementalSpeechActive = true
        self.incrementalSpeechUsed = false
        self.incrementalSpeechLanguage = nil
        self.incrementalSpeechBuffer = IncrementalSpeechBuffer()
        self.incrementalSpeechContext = nil
        self.incrementalSpeechDirective = nil
    }

    private func cancelIncrementalSpeech() {
        self.incrementalSpeechQueue.removeAll()
        self.incrementalSpeechTask?.cancel()
        self.incrementalSpeechTask = nil
        self.cancelIncrementalPrefetch()
        self.incrementalSpeechActive = false
        self.incrementalSpeechContext = nil
        self.incrementalSpeechDirective = nil
    }

    private func enqueueIncrementalSpeech(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        self.incrementalSpeechQueue.append(trimmed)
        self.incrementalSpeechUsed = true
        if self.incrementalSpeechTask == nil {
            self.startIncrementalSpeechTask()
        }
    }

    private func startIncrementalSpeechTask() {
        if self.interruptOnSpeech {
            do {
                try self.startRecognition()
            } catch {
                self.logger.warning(
                    "startRecognition during incremental speak failed: \(error.localizedDescription, privacy: .public)")
            }
        }

        self.incrementalSpeechTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                self.cancelIncrementalPrefetch()
                self.isSpeaking = false
                self.stopRecognition()
                self.incrementalSpeechTask = nil
            }
            while !Task.isCancelled {
                guard !self.incrementalSpeechQueue.isEmpty else { break }
                let segment = self.incrementalSpeechQueue.removeFirst()
                self.statusText = "Speaking…"
                self.isSpeaking = true
                self.lastSpokenText = segment
                await self.updateIncrementalContextIfNeeded()
                let context = self.incrementalSpeechContext
                let prefetchedAudio = await self.consumeIncrementalPrefetchedAudioIfAvailable(
                    for: segment,
                    context: context)
                if let context {
                    self.startIncrementalPrefetchMonitor(context: context)
                }
                await self.speakIncrementalSegment(
                    segment,
                    context: context,
                    prefetchedAudio: prefetchedAudio)
                self.cancelIncrementalPrefetchMonitor()
            }
        }
    }

    private func cancelIncrementalPrefetch() {
        self.cancelIncrementalPrefetchMonitor()
        self.incrementalSpeechPrefetch?.task.cancel()
        self.incrementalSpeechPrefetch = nil
    }

    private func cancelIncrementalPrefetchMonitor() {
        self.incrementalSpeechPrefetchMonitorTask?.cancel()
        self.incrementalSpeechPrefetchMonitorTask = nil
    }

    private func startIncrementalPrefetchMonitor(context: IncrementalSpeechContext) {
        self.cancelIncrementalPrefetchMonitor()
        self.incrementalSpeechPrefetchMonitorTask = Task { @MainActor [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                if self.ensureIncrementalPrefetchForUpcomingSegment(context: context) {
                    return
                }
                try? await Task.sleep(nanoseconds: 40_000_000)
            }
        }
    }

    private func ensureIncrementalPrefetchForUpcomingSegment(context: IncrementalSpeechContext) -> Bool {
        guard context.canUseElevenLabs else {
            self.cancelIncrementalPrefetch()
            return false
        }
        guard let nextSegment = self.incrementalSpeechQueue.first else { return false }
        if let existing = self.incrementalSpeechPrefetch {
            if existing.segment == nextSegment, existing.context == context {
                return true
            }
            existing.task.cancel()
            self.incrementalSpeechPrefetch = nil
        }
        self.startIncrementalPrefetch(segment: nextSegment, context: context)
        return self.incrementalSpeechPrefetch != nil
    }

    private func startIncrementalPrefetch(segment: String, context: IncrementalSpeechContext) {
        guard context.canUseElevenLabs, let apiKey = context.apiKey, let voiceId = context.voiceId else { return }
        let prefetchOutputFormat = self.resolveIncrementalPrefetchOutputFormat(context: context)
        let request = self.makeIncrementalTTSRequest(
            text: segment,
            context: context,
            outputFormat: prefetchOutputFormat)
        let id = UUID()
        let task = Task { [weak self] in
            let stream = ElevenLabsTTSClient(apiKey: apiKey).streamSynthesize(voiceId: voiceId, request: request)
            var chunks: [Data] = []
            do {
                for try await chunk in stream {
                    try Task.checkCancellation()
                    chunks.append(chunk)
                }
                self?.completeIncrementalPrefetch(id: id, chunks: chunks)
            } catch is CancellationError {
                self?.clearIncrementalPrefetch(id: id)
            } catch {
                self?.failIncrementalPrefetch(id: id, error: error)
            }
        }
        self.incrementalSpeechPrefetch = IncrementalSpeechPrefetchState(
            id: id,
            segment: segment,
            context: context,
            outputFormat: prefetchOutputFormat,
            chunks: nil,
            task: task)
    }

    private func completeIncrementalPrefetch(id: UUID, chunks: [Data]) {
        guard var prefetch = self.incrementalSpeechPrefetch, prefetch.id == id else { return }
        prefetch.chunks = chunks
        self.incrementalSpeechPrefetch = prefetch
    }

    private func clearIncrementalPrefetch(id: UUID) {
        guard let prefetch = self.incrementalSpeechPrefetch, prefetch.id == id else { return }
        prefetch.task.cancel()
        self.incrementalSpeechPrefetch = nil
    }

    private func failIncrementalPrefetch(id: UUID, error: any Error) {
        guard let prefetch = self.incrementalSpeechPrefetch, prefetch.id == id else { return }
        self.logger.debug("incremental prefetch failed: \(error.localizedDescription, privacy: .public)")
        prefetch.task.cancel()
        self.incrementalSpeechPrefetch = nil
    }

    private func consumeIncrementalPrefetchedAudioIfAvailable(
        for segment: String,
        context: IncrementalSpeechContext?
    ) async -> IncrementalPrefetchedAudio?
    {
        guard let context else {
            self.cancelIncrementalPrefetch()
            return nil
        }
        guard let prefetch = self.incrementalSpeechPrefetch else {
            return nil
        }
        guard prefetch.context == context else {
            prefetch.task.cancel()
            self.incrementalSpeechPrefetch = nil
            return nil
        }
        guard prefetch.segment == segment else {
            return nil
        }
        if let chunks = prefetch.chunks, !chunks.isEmpty {
            let prefetched = IncrementalPrefetchedAudio(chunks: chunks, outputFormat: prefetch.outputFormat)
            self.incrementalSpeechPrefetch = nil
            return prefetched
        }
        await prefetch.task.value
        guard let completed = self.incrementalSpeechPrefetch else { return nil }
        guard completed.context == context, completed.segment == segment else { return nil }
        guard let chunks = completed.chunks, !chunks.isEmpty else { return nil }
        let prefetched = IncrementalPrefetchedAudio(chunks: chunks, outputFormat: completed.outputFormat)
        self.incrementalSpeechPrefetch = nil
        return prefetched
    }

    private func resolveIncrementalPrefetchOutputFormat(context: IncrementalSpeechContext) -> String? {
        if TalkTTSValidation.pcmSampleRate(from: context.outputFormat) != nil {
            return ElevenLabsTTSClient.validatedOutputFormat("mp3_44100_128")
        }
        return context.outputFormat
    }

    private func finishIncrementalSpeech() async {
        guard self.incrementalSpeechActive else { return }
        let leftover = self.incrementalSpeechBuffer.flush()
        if let leftover {
            self.enqueueIncrementalSpeech(leftover)
        }
        if let task = self.incrementalSpeechTask {
            _ = await task.result
        }
        self.incrementalSpeechActive = false
    }

    private func handleIncrementalAssistantFinal(text: String) async {
        let parsed = TalkDirectiveParser.parse(text)
        self.applyDirective(parsed.directive)
        if let lang = parsed.directive?.language {
            self.incrementalSpeechLanguage = ElevenLabsTTSClient.validatedLanguage(lang)
        }
        await self.updateIncrementalContextIfNeeded()
        let segments = self.incrementalSpeechBuffer.ingest(text: text, isFinal: true)
        for segment in segments {
            self.enqueueIncrementalSpeech(segment)
        }
        await self.finishIncrementalSpeech()
        if !self.incrementalSpeechUsed {
            await self.playAssistant(text: text)
        }
    }

    private func streamAssistant(runId: String, gateway: GatewayNodeSession) async {
        let stream = await gateway.subscribeServerEvents(bufferingNewest: 200)
        for await evt in stream {
            if Task.isCancelled { return }
            guard evt.event == "agent", let payload = evt.payload else { continue }
            guard let agentEvent = try? GatewayPayloadDecoding.decode(
                payload,
                as: OpenClawAgentEventPayload.self
            ) else {
                continue
            }
            guard agentEvent.runId == runId, agentEvent.stream == "assistant" else { continue }
            guard let text = agentEvent.data["text"]?.value as? String else { continue }
            let segments = self.incrementalSpeechBuffer.ingest(text: text, isFinal: false)
            if let lang = self.incrementalSpeechBuffer.directive?.language {
                self.incrementalSpeechLanguage = ElevenLabsTTSClient.validatedLanguage(lang)
            }
            await self.updateIncrementalContextIfNeeded()
            for segment in segments {
                self.enqueueIncrementalSpeech(segment)
            }
        }
    }

    private func updateIncrementalContextIfNeeded() async {
        let directive = self.incrementalSpeechBuffer.directive
        if let existing = self.incrementalSpeechContext, directive == self.incrementalSpeechDirective {
            if existing.language != self.incrementalSpeechLanguage {
                self.incrementalSpeechContext = IncrementalSpeechContext(
                    apiKey: existing.apiKey,
                    voiceId: existing.voiceId,
                    modelId: existing.modelId,
                    outputFormat: existing.outputFormat,
                    language: self.incrementalSpeechLanguage,
                    directive: existing.directive,
                    canUseElevenLabs: existing.canUseElevenLabs)
            }
            return
        }
        let context = await self.buildIncrementalSpeechContext(directive: directive)
        self.incrementalSpeechContext = context
        self.incrementalSpeechDirective = directive
    }

    private func buildIncrementalSpeechContext(directive: TalkDirective?) async -> IncrementalSpeechContext {
        // When the configured provider is not ElevenLabs, skip the `listVoices`
        // resolution entirely. The incremental speak path checks for an OpenAI-compatible
        // surface before using this context, so returning `canUseElevenLabs=false` is
        // safe and keeps the code below provider-scoped to ElevenLabs.
        if let providerKind = self.providerSurface?.kind, providerKind != .elevenlabs {
            return IncrementalSpeechContext(
                apiKey: nil,
                voiceId: nil,
                modelId: directive?.modelId ?? self.currentModelId ?? self.defaultModelId,
                outputFormat: nil,
                language: self.incrementalSpeechLanguage,
                directive: directive,
                canUseElevenLabs: false)
        }
        let requestedVoice = directive?.voiceId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedVoice = self.resolveVoiceAlias(requestedVoice)
        if requestedVoice?.isEmpty == false, resolvedVoice == nil {
            self.logger.warning("unknown voice alias \(requestedVoice ?? "?", privacy: .public)")
        }
        let preferredVoice = resolvedVoice ?? self.currentVoiceId ?? self.defaultVoiceId
        let modelId = directive?.modelId ?? self.currentModelId ?? self.defaultModelId
        let desiredOutputFormat = (directive?.outputFormat ?? self.defaultOutputFormat)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let requestedOutputFormat = (desiredOutputFormat?.isEmpty == false) ? desiredOutputFormat : nil
        let outputFormat = ElevenLabsTTSClient.validatedOutputFormat(
            requestedOutputFormat ?? self.effectiveDefaultOutputFormat)
        if outputFormat == nil, let requestedOutputFormat {
            self.logger.warning(
                "talk output_format unsupported for local playback: \(requestedOutputFormat, privacy: .public)")
        }

        let configuredKey = self.apiKey?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? self.apiKey : nil
        #if DEBUG
        let resolvedKey = configuredKey ?? ProcessInfo.processInfo.environment["ELEVENLABS_API_KEY"]
        #else
        let resolvedKey = configuredKey
        #endif
        let apiKey = resolvedKey?.trimmingCharacters(in: .whitespacesAndNewlines)
        let voiceId: String? = if let apiKey, !apiKey.isEmpty {
            await self.resolveVoiceId(preferred: preferredVoice, apiKey: apiKey)
        } else {
            nil
        }
        let canUseElevenLabs = (voiceId?.isEmpty == false) && (apiKey?.isEmpty == false)
        return IncrementalSpeechContext(
            apiKey: apiKey,
            voiceId: voiceId,
            modelId: modelId,
            outputFormat: outputFormat,
            language: self.incrementalSpeechLanguage,
            directive: directive,
            canUseElevenLabs: canUseElevenLabs)
    }

    private func makeIncrementalTTSRequest(
        text: String,
        context: IncrementalSpeechContext,
        outputFormat: String?
    ) -> ElevenLabsTTSRequest
    {
        ElevenLabsTTSRequest(
            text: text,
            modelId: context.modelId,
            outputFormat: outputFormat,
            speed: TalkTTSValidation.resolveSpeed(
                speed: context.directive?.speed,
                rateWPM: context.directive?.rateWPM),
            stability: TalkTTSValidation.validatedStability(
                context.directive?.stability,
                modelId: context.modelId),
            similarity: TalkTTSValidation.validatedUnit(context.directive?.similarity),
            style: TalkTTSValidation.validatedUnit(context.directive?.style),
            speakerBoost: context.directive?.speakerBoost,
            seed: TalkTTSValidation.validatedSeed(context.directive?.seed),
            normalize: ElevenLabsTTSClient.validatedNormalize(context.directive?.normalize),
            language: context.language,
            latencyTier: TalkTTSValidation.validatedLatencyTier(context.directive?.latencyTier))
    }

    /// Returns `mp3_44100_128` when the API has already rejected PCM, otherwise `pcm_44100`.
    private var effectiveDefaultOutputFormat: String {
        self.pcmFormatUnavailable ? "mp3_44100_128" : "pcm_44100"
    }

    private static func monitorStreamFailures(
        _ stream: AsyncThrowingStream<Data, Error>,
        failureBox: StreamFailureBox
    ) -> AsyncThrowingStream<Data, Error>
    {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await chunk in stream {
                        continuation.yield(chunk)
                    }
                    continuation.finish()
                } catch {
                    failureBox.set(error)
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    private static func isPCMFormatRejectedByAPI(_ error: Error?) -> Bool {
        guard let error = error as NSError? else { return false }
        guard error.domain == "ElevenLabsTTS", error.code >= 400 else { return false }
        let message = (error.userInfo[NSLocalizedDescriptionKey] as? String ?? error.localizedDescription).lowercased()
        return message.contains("output_format")
            || message.contains("pcm_")
            || message.contains("pcm ")
            || message.contains("subscription_required")
    }

    private static func makeBufferedAudioStream(chunks: [Data]) -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { continuation in
            for chunk in chunks {
                continuation.yield(chunk)
            }
            continuation.finish()
        }
    }

    private func speakIncrementalSegment(
        _ text: String,
        context preferredContext: IncrementalSpeechContext? = nil,
        prefetchedAudio: IncrementalPrefetchedAudio? = nil
    ) async
    {
        // OpenAI / Azure-OpenAI incremental path. Skip the ElevenLabs-specific
        // pre-fetch machinery and call the generic runtime segment-by-segment. This
        // is slightly less optimal than ElevenLabs today but keeps the provider layer
        // generic and well below the ~200 ms per-segment user-visible latency.
        if let openAIConfig = self.resolveOpenAICompatibleTTSConfig(directive: nil) {
            self.statusText = "Speaking…"
            self.lastPlaybackWasPCM = (openAIConfig.responseFormat == .pcm)
            do {
                let result = try await self.openAIRuntime.speak(text: text, config: openAIConfig)
                if !result.finished, let interruptedAt = result.interruptedAt {
                    self.lastInterruptedAtSeconds = interruptedAt
                }
            } catch {
                self.logger.error(
                    "openai-tts incremental failed: \(error.localizedDescription, privacy: .public)")
                try? await TalkSystemSpeechSynthesizer.shared.speak(
                    text: text,
                    language: self.incrementalSpeechLanguage)
            }
            return
        }

        let context: IncrementalSpeechContext
        if let preferredContext {
            context = preferredContext
        } else {
            await self.updateIncrementalContextIfNeeded()
            guard let resolvedContext = self.incrementalSpeechContext else {
                try? await TalkSystemSpeechSynthesizer.shared.speak(
                    text: text,
                    language: self.incrementalSpeechLanguage)
                return
            }
            context = resolvedContext
        }

        guard context.canUseElevenLabs, let apiKey = context.apiKey, let voiceId = context.voiceId else {
            try? await TalkSystemSpeechSynthesizer.shared.speak(
                text: text,
                language: self.incrementalSpeechLanguage)
            return
        }

        let client = ElevenLabsTTSClient(apiKey: apiKey)
        let request = self.makeIncrementalTTSRequest(
            text: text,
            context: context,
            outputFormat: context.outputFormat)
        let rawStream: AsyncThrowingStream<Data, Error>
        if let prefetchedAudio, !prefetchedAudio.chunks.isEmpty {
            rawStream = Self.makeBufferedAudioStream(chunks: prefetchedAudio.chunks)
        } else {
            rawStream = client.streamSynthesize(voiceId: voiceId, request: request)
        }
        let playbackFormat = prefetchedAudio?.outputFormat ?? context.outputFormat
        let sampleRate = TalkTTSValidation.pcmSampleRate(from: playbackFormat)
        let result: StreamingPlaybackResult
        if let sampleRate {
            let streamFailure = StreamFailureBox()
            let stream = Self.monitorStreamFailures(rawStream, failureBox: streamFailure)
            self.lastPlaybackWasPCM = true
            var playback = await self.pcmPlayer.play(stream: stream, sampleRate: sampleRate)
            if !playback.finished, playback.interruptedAt == nil {
                self.logger.warning("pcm playback failed; retrying mp3")
                if Self.isPCMFormatRejectedByAPI(streamFailure.value) {
                    self.pcmFormatUnavailable = true
                }
                self.lastPlaybackWasPCM = false
                let mp3Format = ElevenLabsTTSClient.validatedOutputFormat("mp3_44100_128")
                let mp3Stream = client.streamSynthesize(
                    voiceId: voiceId,
                    request: self.makeIncrementalTTSRequest(
                        text: text,
                        context: context,
                        outputFormat: mp3Format))
                playback = await self.mp3Player.play(stream: mp3Stream)
            }
            result = playback
        } else {
            self.lastPlaybackWasPCM = false
            result = await self.mp3Player.play(stream: rawStream)
        }
        if !result.finished, let interruptedAt = result.interruptedAt {
            self.lastInterruptedAtSeconds = interruptedAt
        }
    }

}

private struct IncrementalSpeechBuffer {
    private static let softBoundaryMinChars = 72

    private(set) var latestText: String = ""
    private(set) var directive: TalkDirective?
    private var spokenOffset: Int = 0
    private var inCodeBlock = false
    private var directiveParsed = false

    mutating func ingest(text: String, isFinal: Bool) -> [String] {
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n")
        guard let usable = self.stripDirectiveIfReady(from: normalized) else { return [] }
        self.updateText(usable)
        return self.extractSegments(isFinal: isFinal)
    }

    mutating func flush() -> String? {
        guard !self.latestText.isEmpty else { return nil }
        let segments = self.extractSegments(isFinal: true)
        return segments.first
    }

    private mutating func stripDirectiveIfReady(from text: String) -> String? {
        guard !self.directiveParsed else { return text }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.hasPrefix("{") {
            guard let newlineRange = text.range(of: "\n") else { return nil }
            let firstLine = text[..<newlineRange.lowerBound]
            let head = firstLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard head.hasSuffix("}") else { return nil }
            let parsed = TalkDirectiveParser.parse(text)
            if let directive = parsed.directive {
                self.directive = directive
            }
            self.directiveParsed = true
            return parsed.stripped
        }
        self.directiveParsed = true
        return text
    }

    private mutating func updateText(_ newText: String) {
        if newText.hasPrefix(self.latestText) {
            self.latestText = newText
        } else if self.latestText.hasPrefix(newText) {
            // Stream reset or correction; prefer the newer prefix.
            self.latestText = newText
            self.spokenOffset = min(self.spokenOffset, newText.count)
        } else {
            // Diverged text means chunks arrived out of order or stream restarted.
            let commonPrefix = Self.commonPrefixCount(self.latestText, newText)
            self.latestText = newText
            if self.spokenOffset > commonPrefix {
                self.spokenOffset = commonPrefix
            }
        }
        if self.spokenOffset > self.latestText.count {
            self.spokenOffset = self.latestText.count
        }
    }

    private static func commonPrefixCount(_ lhs: String, _ rhs: String) -> Int {
        let left = Array(lhs)
        let right = Array(rhs)
        let limit = min(left.count, right.count)
        var idx = 0
        while idx < limit, left[idx] == right[idx] {
            idx += 1
        }
        return idx
    }

    private mutating func extractSegments(isFinal: Bool) -> [String] {
        let chars = Array(self.latestText)
        guard self.spokenOffset < chars.count else { return [] }
        var idx = self.spokenOffset
        var lastBoundary: Int?
        var inCodeBlock = self.inCodeBlock
        var buffer = ""
        var bufferAtBoundary = ""
        var inCodeBlockAtBoundary = inCodeBlock

        while idx < chars.count {
            if idx + 2 < chars.count,
               chars[idx] == "`",
               chars[idx + 1] == "`",
               chars[idx + 2] == "`"
            {
                inCodeBlock.toggle()
                idx += 3
                continue
            }

            if !inCodeBlock {
                let currentChar = chars[idx]
                buffer.append(currentChar)
                if Self.isBoundary(currentChar) || Self.isSoftBoundary(currentChar, bufferedChars: buffer.count) {
                    lastBoundary = idx + 1
                    bufferAtBoundary = buffer
                    inCodeBlockAtBoundary = inCodeBlock
                }
            }

            idx += 1
        }

        if let boundary = lastBoundary {
            self.spokenOffset = boundary
            self.inCodeBlock = inCodeBlockAtBoundary
            let trimmed = bufferAtBoundary.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? [] : [trimmed]
        }

        guard isFinal else { return [] }
        self.spokenOffset = chars.count
        self.inCodeBlock = inCodeBlock
        let trimmed = buffer.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? [] : [trimmed]
    }

    private static func isBoundary(_ ch: Character) -> Bool {
        ch == "." || ch == "!" || ch == "?" || ch == "\n"
    }

    private static func isSoftBoundary(_ ch: Character, bufferedChars: Int) -> Bool {
        bufferedChars >= Self.softBoundaryMinChars && ch.isWhitespace
    }
}

extension TalkModeManager {
    nonisolated static func requestMicrophonePermission() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            return true
        case .denied:
            return false
        case .undetermined:
            return await self.requestPermissionWithTimeout { completion in
                AVAudioApplication.requestRecordPermission(completionHandler: { ok in
                    completion(ok)
                })
            }
        @unknown default:
            return false
        }
    }

    nonisolated static func requestSpeechPermission() async -> Bool {
        let status = SFSpeechRecognizer.authorizationStatus()
        switch status {
        case .authorized:
            return true
        case .denied, .restricted:
            return false
        case .notDetermined:
            break
        @unknown default:
            return false
        }

        return await self.requestPermissionWithTimeout { completion in
            SFSpeechRecognizer.requestAuthorization { authStatus in
                completion(authStatus == .authorized)
            }
        }
    }

    private nonisolated static func requestPermissionWithTimeout(
        _ operation: @escaping @Sendable (@escaping @Sendable (Bool) -> Void) -> Void) async -> Bool
    {
        do {
            return try await AsyncTimeout.withTimeout(
                seconds: 8,
                onTimeout: { NSError(domain: "TalkMode", code: 6, userInfo: [
                    NSLocalizedDescriptionKey: "permission request timed out",
                ]) },
                operation: {
                    await withCheckedContinuation(isolation: nil) { cont in
                        Task { @MainActor in
                            operation { ok in
                                cont.resume(returning: ok)
                            }
                        }
                    }
                })
        } catch {
            return false
        }
    }

    static func permissionMessage(
        kind: String,
        status: AVAudioSession.RecordPermission) -> String
    {
        switch status {
        case .denied:
            return "\(kind) permission denied"
        case .undetermined:
            return "\(kind) permission not granted"
        case .granted:
            return "\(kind) permission denied"
        @unknown default:
            return "\(kind) permission denied"
        }
    }

    static func permissionMessage(
        kind: String,
        status: SFSpeechRecognizerAuthorizationStatus) -> String
    {
        switch status {
        case .denied:
            return "\(kind) permission denied"
        case .restricted:
            return "\(kind) permission restricted"
        case .notDetermined:
            return "\(kind) permission not granted"
        case .authorized:
            return "\(kind) permission denied"
        @unknown default:
            return "\(kind) permission denied"
        }
    }
}

extension TalkModeManager {
    func resolveVoiceAlias(_ value: String?) -> String? {
        let trimmed = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let normalized = trimmed.lowercased()
        if let mapped = self.voiceAliases[normalized] { return mapped }
        if self.voiceAliases.values.contains(where: { $0.caseInsensitiveCompare(trimmed) == .orderedSame }) {
            return trimmed
        }
        return Self.isLikelyVoiceId(trimmed) ? trimmed : nil
    }

    func resolveVoiceId(preferred: String?, apiKey: String) async -> String? {
        let trimmed = preferred?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty {
            // Config / directives can provide a raw ElevenLabs voiceId (not an alias).
            // Accept it directly to avoid unnecessary listVoices calls (and accidental fallback selection).
            if Self.isLikelyVoiceId(trimmed) {
                return trimmed
            }
            if let resolved = self.resolveVoiceAlias(trimmed) { return resolved }
            self.logger.warning("unknown voice alias \(trimmed, privacy: .public)")
        }
        if let fallbackVoiceId { return fallbackVoiceId }

        do {
            let voices = try await ElevenLabsTTSClient(apiKey: apiKey).listVoices()
            guard let first = voices.first else {
                self.logger.warning("elevenlabs voices list empty")
                return nil
            }
            self.fallbackVoiceId = first.voiceId
            if self.defaultVoiceId == nil {
                self.defaultVoiceId = first.voiceId
            }
            if !self.voiceOverrideActive {
                self.currentVoiceId = first.voiceId
            }
            let name = first.name ?? "unknown"
            self.logger
                .info("default voice selected \(name, privacy: .public) (\(first.voiceId, privacy: .public))")
            return first.voiceId
        } catch {
            self.logger.error("elevenlabs list voices failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    static func isLikelyVoiceId(_ value: String) -> Bool {
        guard value.count >= 10 else { return false }
        return value.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
    }

    private static func normalizedTalkApiKey(_ raw: String?) -> String? {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard trimmed != Self.redactedConfigSentinel else { return nil }
        // Config values may be env placeholders (for example `${ELEVENLABS_API_KEY}`).
        if trimmed.hasPrefix("${"), trimmed.hasSuffix("}") { return nil }
        return trimmed
    }

    func reloadConfig() async {
        guard let gateway else { return }
        self.pcmFormatUnavailable = false
        do {
            let res = try await gateway.request(
                method: "talk.config",
                paramsJSON: "{\"includeSecrets\":true}",
                timeoutSeconds: 8
            )
            guard let json = try JSONSerialization.jsonObject(with: res) as? [String: Any] else { return }
            guard let config = json["config"] as? [String: Any] else { return }
            let parsed = TalkModeGatewayConfigParser.parse(
                config: config,
                defaultProvider: Self.defaultTalkProvider,
                defaultModelIdFallback: Self.defaultModelIdFallback,
                defaultSilenceTimeoutMs: Self.defaultSilenceTimeoutMs)
            if parsed.missingResolvedPayload {
                GatewayDiagnostics.log(
                    "talk config ignored: normalized payload missing talk.resolved")
            }
            let activeProvider = parsed.activeProvider
            self.defaultVoiceId = parsed.defaultVoiceId
            self.voiceAliases = parsed.voiceAliases
            if !self.voiceOverrideActive {
                self.currentVoiceId = self.defaultVoiceId
            }
            self.defaultModelId = parsed.defaultModelId
            if !self.modelOverrideActive {
                self.currentModelId = self.defaultModelId
            }
            self.defaultOutputFormat = parsed.defaultOutputFormat
            let rawConfigApiKey = parsed.rawConfigApiKey
            let configApiKey = Self.normalizedTalkApiKey(rawConfigApiKey)
            let localApiKey = Self.normalizedTalkApiKey(
                GatewaySettingsStore.loadTalkProviderApiKey(provider: activeProvider))
            if rawConfigApiKey == Self.redactedConfigSentinel {
                self.apiKey = (localApiKey?.isEmpty == false) ? localApiKey : nil
                GatewayDiagnostics.log("talk config apiKey redacted; using local override if present")
            } else {
                self.apiKey = (localApiKey?.isEmpty == false) ? localApiKey : configApiKey
            }
            // Store the generic provider surface so the TTS path can route openai /
            // azure-openai without a provider-id switch at each call site. For
            // ElevenLabs, the existing `apiKey`/voice state is already the source of
            // truth and the surface is consulted only to confirm the provider kind.
            self.providerSurface = parsed.providerSurface
            let providerKind = parsed.providerSurface?.kind
            let supportsOpenAICompatible = (providerKind == .openai || providerKind == .azureOpenai)
            if providerKind == nil, activeProvider != Self.defaultTalkProvider {
                // Unknown provider id: fall back to system voice.
                self.apiKey = nil
                GatewayDiagnostics.log(
                    "talk provider '\(activeProvider)' not recognized on iOS; using system voice fallback")
            } else if supportsOpenAICompatible {
                // Merge local keychain override with the surface so the generic TTS
                // runtime sees the same secret the ElevenLabs path would.
                if let localApiKey, !localApiKey.isEmpty, self.providerSurface?.apiKey == nil {
                    self.providerSurface = self.withOverriddenApiKey(
                        surface: self.providerSurface,
                        apiKey: localApiKey)
                }
                GatewayDiagnostics.log(
                    "talk provider '\(activeProvider)' uses OpenAI-compatible iOS TTS")
            } else if providerKind != .elevenlabs, activeProvider != Self.defaultTalkProvider {
                self.apiKey = nil
                GatewayDiagnostics.log(
                    "talk provider '\(activeProvider)' not yet supported on iOS; using system voice fallback")
            }
            self.gatewayTalkDefaultVoiceId = self.defaultVoiceId
            self.gatewayTalkDefaultModelId = self.defaultModelId
            self.gatewayTalkApiKeyConfigured = (self.apiKey?.isEmpty == false)
            self.gatewayTalkConfigLoaded = true
            if let interrupt = parsed.interruptOnSpeech {
                self.interruptOnSpeech = interrupt
            }
            self.silenceWindow = TimeInterval(parsed.silenceTimeoutMs) / 1000
            if parsed.normalizedPayload || parsed.defaultVoiceId != nil || parsed.rawConfigApiKey != nil {
                GatewayDiagnostics.log(
                    "talk config provider=\(activeProvider) silenceTimeoutMs=\(parsed.silenceTimeoutMs)")
            }
        } catch {
            self.defaultModelId = Self.defaultModelIdFallback
            if !self.modelOverrideActive {
                self.currentModelId = self.defaultModelId
            }
            self.gatewayTalkDefaultVoiceId = nil
            self.gatewayTalkDefaultModelId = nil
            self.gatewayTalkApiKeyConfigured = false
            self.gatewayTalkConfigLoaded = false
            self.silenceWindow = TimeInterval(Self.defaultSilenceTimeoutMs) / 1000
            self.providerSurface = nil
        }
    }

    /// Return a new surface copy with `apiKey` replaced. We cannot mutate the struct in
    /// place because iOS keychain-backed local overrides arrive after the config
    /// payload has already been normalized.
    private func withOverriddenApiKey(
        surface: TalkProviderSurface?,
        apiKey: String
    ) -> TalkProviderSurface? {
        guard let surface else { return nil }
        return TalkProviderSurface(
            kind: surface.kind,
            rawKindString: surface.rawKindString,
            apiKey: apiKey,
            apiKeyRedacted: false,
            baseUrl: surface.baseUrl,
            model: surface.model,
            voice: surface.voice,
            responseFormat: surface.responseFormat,
            instructions: surface.instructions,
            speed: surface.speed,
            azureEndpoint: surface.azureEndpoint,
            azureApiVersion: surface.azureApiVersion,
            transcribeModel: surface.transcribeModel,
            transcribeLanguage: surface.transcribeLanguage,
            useServerTranscribe: surface.useServerTranscribe,
            realtimeModel: surface.realtimeModel,
            realtimeVoice: surface.realtimeVoice,
            realtimeApiVersion: surface.realtimeApiVersion)
    }

    /// Resolve the TTS capability config for the currently loaded provider surface.
    /// Returns `nil` unless the surface maps to an OpenAI-compatible provider with
    /// credentials that can actually hit the endpoint (e.g. Azure with an endpoint).
    func resolveOpenAICompatibleTTSConfig(directive: TalkDirective?) -> TTSCapabilityConfig? {
        guard var config = self.providerSurface?.makeOpenAITTSConfig() else { return nil }
        // Directive overrides: voice + model + speed + format. `instructions` isn't
        // exposed via the TalkDirective schema; we stay with the provider default.
        let voice = directive?.voiceId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let model = directive?.modelId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let speed = directive?.speed
        let formatRaw = directive?.outputFormat?.lowercased()
        var responseFormat = config.responseFormat
        if let formatRaw {
            switch formatRaw {
            case "mp3": responseFormat = .mp3
            case "opus": responseFormat = .opus
            case "wav": responseFormat = .wav
            case "pcm", "pcm_24000", "pcm_16000", "pcm24000": responseFormat = .pcm
            default: break
            }
        }
        config = TTSCapabilityConfig(
            kind: config.kind,
            credentials: config.credentials,
            model: (model?.isEmpty == false) ? model! : config.model,
            voice: (voice?.isEmpty == false) ? voice! : config.voice,
            responseFormat: responseFormat,
            instructions: config.instructions,
            speed: speed ?? config.speed,
            baseUrl: config.baseUrl)
        return config
    }

    /// Whether the currently loaded provider surface has realtime enabled. Opt-in
    /// via `talk.<provider>.enableRealtime` (or nested `talk.<provider>.realtime.enabled`).
    /// When false, the Tier 1 STT + TTS fallback path continues to own the voice
    /// loop so existing deployments are unaffected.
    var isRealtimeEnabled: Bool {
        guard let surface = self.providerSurface else { return false }
        return surface.enableRealtime && surface.makeRealtimeConfig() != nil
    }

    /// Resolve a `RealtimeCapabilityConfig` for the current provider surface, with
    /// optional directive-level voice override. Returns nil when realtime is not
    /// configured or the provider does not map to an OpenAI-compatible kind.
    func resolveRealtimeCapabilityConfig(directive: TalkDirective?) -> RealtimeCapabilityConfig? {
        guard let baseConfig = self.providerSurface?.makeRealtimeConfig() else { return nil }
        let voice = directive?.voiceId?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let voice, !voice.isEmpty else { return baseConfig }
        return RealtimeCapabilityConfig(
            kind: baseConfig.kind,
            credentials: baseConfig.credentials,
            model: baseConfig.model,
            voice: voice,
            inputSampleRate: baseConfig.inputSampleRate,
            outputSampleRate: baseConfig.outputSampleRate,
            modelFallbacks: baseConfig.modelFallbacks)
    }

    #if DEBUG
    /// Test-only hook that mirrors `resolveOpenAICompatibleTTSConfig`. Kept inside
    /// the manager so callers can assert fallback/voice override behavior without
    /// exposing the private `providerSurface`.
    static func _test_resolveRealtimeCapabilityConfig(
        surface: TalkProviderSurface?,
        directive: TalkDirective?
    ) -> RealtimeCapabilityConfig? {
        guard let baseConfig = surface?.makeRealtimeConfig() else { return nil }
        let voice = directive?.voiceId?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let voice, !voice.isEmpty else { return baseConfig }
        return RealtimeCapabilityConfig(
            kind: baseConfig.kind,
            credentials: baseConfig.credentials,
            model: baseConfig.model,
            voice: voice,
            inputSampleRate: baseConfig.inputSampleRate,
            outputSampleRate: baseConfig.outputSampleRate,
            modelFallbacks: baseConfig.modelFallbacks)
    }

    /// Test-only accessor for `isRealtimeEnabled` that takes a surface instead of
    /// reading the instance's private state.
    static func _test_isRealtimeEnabled(surface: TalkProviderSurface?) -> Bool {
        guard let surface else { return false }
        return surface.enableRealtime && surface.makeRealtimeConfig() != nil
    }
    #endif

    static func configureAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        // Prefer `.spokenAudio` for STT; it tends to preserve speech energy better than `.voiceChat`.
        try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [
            .allowBluetoothHFP,
            .defaultToSpeaker,
        ])
        try? session.setPreferredSampleRate(48_000)
        try? session.setPreferredIOBufferDuration(0.02)
        try session.setActive(true, options: [])
    }

    private static func describeAudioSession() -> String {
        let session = AVAudioSession.sharedInstance()
        let inputs = session.currentRoute.inputs
            .map { "\($0.portType.rawValue):\($0.portName)" }
            .joined(separator: ",")
        let outputs = session.currentRoute.outputs
            .map { "\($0.portType.rawValue):\($0.portName)" }
            .joined(separator: ",")
        let available = session.availableInputs?
            .map { "\($0.portType.rawValue):\($0.portName)" }
            .joined(separator: ",") ?? ""
        return "category=\(session.category.rawValue) mode=\(session.mode.rawValue) "
            + "opts=\(session.categoryOptions.rawValue) inputAvail=\(session.isInputAvailable) "
            + "routeIn=[\(inputs)] routeOut=[\(outputs)] availIn=[\(available)]"
    }
}

final class AudioTapDiagnostics: @unchecked Sendable {
    private let label: String
    private let onLevel: (@Sendable (Float) -> Void)?
    private let lock = NSLock()
    private var bufferCount: Int = 0
    private var lastLoggedAt = Date.distantPast
    private var lastLevelEmitAt = Date.distantPast
    private var maxRmsWindow: Float = 0
    private var lastRms: Float = 0

    init(label: String, onLevel: (@Sendable (Float) -> Void)? = nil) {
        self.label = label
        self.onLevel = onLevel
    }

    func onBuffer(_ buffer: AVAudioPCMBuffer) {
        var shouldLog = false
        var shouldEmitLevel = false
        var count = 0
        lock.lock()
        bufferCount += 1
        count = bufferCount
        let now = Date()
        if now.timeIntervalSince(lastLoggedAt) >= 1.0 {
            lastLoggedAt = now
            shouldLog = true
        }
        if now.timeIntervalSince(lastLevelEmitAt) >= 0.12 {
            lastLevelEmitAt = now
            shouldEmitLevel = true
        }
        lock.unlock()

        let rate = buffer.format.sampleRate
        let ch = buffer.format.channelCount
        let frames = buffer.frameLength

        var rms: Float?
        if let data = buffer.floatChannelData?.pointee {
            let n = Int(frames)
            if n > 0 {
                var sum: Float = 0
                for i in 0..<n {
                    let v = data[i]
                    sum += v * v
                }
                rms = sqrt(sum / Float(n))
            }
        }

        let resolvedRms = rms ?? 0
        lock.lock()
        lastRms = resolvedRms
        if resolvedRms > maxRmsWindow { maxRmsWindow = resolvedRms }
        let maxRms = maxRmsWindow
        if shouldLog { maxRmsWindow = 0 }
        lock.unlock()

        if shouldEmitLevel, let onLevel {
            onLevel(resolvedRms)
        }

        guard shouldLog else { return }
        GatewayDiagnostics.log(
            "\(label) mic: buffers=\(count) frames=\(frames) rate=\(Int(rate))Hz ch=\(ch) "
                + "rms=\(String(format: "%.4f", resolvedRms)) max=\(String(format: "%.4f", maxRms))"
        )
    }
}

#if DEBUG
extension TalkModeManager {
    static func _test_isPCMFormatRejectedByAPI(_ error: Error?) -> Bool {
        self.isPCMFormatRejectedByAPI(error)
    }

    func _test_seedTranscript(_ transcript: String) {
        self.lastTranscript = transcript
        self.lastHeard = Date()
    }

    func _test_handleTranscript(_ transcript: String, isFinal: Bool) async {
        await self.handleTranscript(transcript: transcript, isFinal: isFinal)
    }

    func _test_backdateLastHeard(seconds: TimeInterval) {
        self.lastHeard = Date().addingTimeInterval(-seconds)
    }

    func _test_runSilenceCheck() async {
        await self.checkSilence()
    }

    func _test_incrementalReset() {
        self.incrementalSpeechBuffer = IncrementalSpeechBuffer()
    }

    func _test_incrementalIngest(_ text: String, isFinal: Bool) -> [String] {
        self.incrementalSpeechBuffer.ingest(text: text, isFinal: isFinal)
    }

    /// Drive the realtime startup without requiring gateway/mic/permissions. The
    /// mic tap install is skipped on the simulator path; the runtime connect uses
    /// whatever `realtimeWebSocketFactoryOverride` is configured.
    func _test_startRealtime(config: RealtimeCapabilityConfig) async throws {
        self.captureMode = .continuous
        try await self.startRealtimeRecognition(config: config)
        self.isListening = true
        self.realtimeActive = true
    }

    /// Inject a PCM16 chunk as if the realtime session had emitted it. Exercises
    /// the playback feeder without touching AVAudioEngine.
    func _test_enqueueAssistantAudio(pcm16: Data) {
        self.enqueueRealtimeAssistantAudio(pcm16: pcm16)
    }

    /// Tear down state the way `stop()` would. Exposed so lifecycle tests can
    /// assert idempotency without going through the full `stop()` side-effects
    /// (which touch AVAudioSession).
    func _test_tearDownRealtime() async {
        await self.tearDownRealtimeSession()
    }

    /// Observability hook for the lifecycle tests.
    var _test_realtimeActive: Bool { self.realtimeActive }

    /// Whether the runtime currently owns a connected session.
    var _test_runtimeIsActive: Bool { self.talkRealtimeRuntime.isActive }

    /// Returns the shared runtime so tests can wire their own delegate/factory if
    /// they need to.
    var _test_realtimeRuntime: TalkRealtimeSessionRuntime { self.talkRealtimeRuntime }
}
#endif

private struct IncrementalSpeechContext: Equatable {
    let apiKey: String?
    let voiceId: String?
    let modelId: String?
    let outputFormat: String?
    let language: String?
    let directive: TalkDirective?
    let canUseElevenLabs: Bool
}

private struct IncrementalSpeechPrefetchState {
    let id: UUID
    let segment: String
    let context: IncrementalSpeechContext
    let outputFormat: String?
    var chunks: [Data]?
    let task: Task<Void, Never>
}

private struct IncrementalPrefetchedAudio {
    let chunks: [Data]
    let outputFormat: String?
}

// swiftlint:enable type_body_length file_length
