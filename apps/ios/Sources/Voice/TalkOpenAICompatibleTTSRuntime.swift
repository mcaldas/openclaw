import Foundation
import OpenClawKit

/// Small facade that calls `OpenAICompatibleTTSClient` and routes playback through
/// the same streaming-audio players used by the ElevenLabs path. The TTS path is the
/// only piece of the talk mode loop that we re-home when the gateway is configured
/// for `openai` / `azure-openai`. STT (today) and chat routing stay identical.
@MainActor
struct TalkOpenAICompatibleTTSRuntime {
    let client: OpenAICompatibleTTSClient
    let pcmPlayer: PCMStreamingAudioPlaying
    let mp3Player: StreamingAudioPlaying

    init(
        client: OpenAICompatibleTTSClient = OpenAICompatibleTTSClient(),
        pcmPlayer: PCMStreamingAudioPlaying = PCMStreamingAudioPlayer.shared,
        mp3Player: StreamingAudioPlaying = StreamingAudioPlayer.shared
    ) {
        self.client = client
        self.pcmPlayer = pcmPlayer
        self.mp3Player = mp3Player
    }

    /// Synthesize `text` with `config`, play via the matching audio player, and return
    /// the playback result. Throws on non-2xx responses so the caller can fall back.
    func speak(text: String, config: TTSCapabilityConfig) async throws -> StreamingPlaybackResult {
        let stream = self.client.streamSynthesize(text: text, config: config)
        switch config.responseFormat {
        case .pcm:
            // OpenAI TTS `pcm` is 24 kHz signed 16-bit mono little-endian. The gateway's
            // Azure TTS deployment matches.
            return await self.pcmPlayer.play(stream: stream, sampleRate: 24_000)
        case .mp3, .opus, .wav:
            return await self.mp3Player.play(stream: stream)
        }
    }
}
