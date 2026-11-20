import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mulawToPcm } from "openclaw/plugin-sdk/realtime-voice";
import { createHoldGate, type HoldGateEvent, type WakeCheck } from "./hold-gate.js";
import { createLoopDetector } from "./loop-detector.js";
import { roomOf } from "./room.js";
import { createSileroProbSource, type SileroVad } from "./silero-vad.js";
import { encodeWavMono } from "./speaker-transcript.js";
import type { CallRecord } from "./types.js";

/** Set once at startup by room mode: Silero and the configured audio model, when available. */
export const holdWakeServices: {
  vad?: SileroVad;
  transcribe?: (wavPath: string) => Promise<string | undefined>;
} = {};

export const WAKE_TRANSCRIPT_PROMPT =
  "Transcribe the speech in this phone audio verbatim, in its original language. Reply with the words only, or [no speech] if nobody speaks.";

/** The detector a room call asked for at its start ("silero" unless configured otherwise). */
export function holdDetectorOf(call: CallRecord): "silero" | "energy" {
  return roomOf(call)?.holdDetector === "energy" ? "energy" : "silero";
}

async function transcribeMulaw(
  audio: Buffer,
  transcribe: (wavPath: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  const pcm = mulawToPcm(audio);
  const samples = Int16Array.from({ length: audio.length }, (_, i) => pcm.readInt16LE(i * 2));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-call-wake-"));
  try {
    const file = path.join(dir, "wake.wav");
    await fs.writeFile(file, encodeWavMono(samples, 8_000), { mode: 0o600 });
    const text = (await transcribe(file))?.trim();
    return text && !/^\[no speech\]$/iu.test(text) ? text : undefined;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Slowest transcription that may hold back a wake; the gate gives up after 2.5 s anyway. */
const BLOCKING_TRANSCRIBE_MS = 2_000;
/** Latest transcription time on this gateway; the audio model is shared by every call. */
let lastTranscribeMs: number | undefined;

/**
 * Remembers what recorded announcements said on this call's holds (LiveKit's TF-IDF loop
 * detector). Every wake is transcribed and learned as an announcement when nobody answers it.
 * A later wake waits for its transcript, and stays on hold if it repeats one, only while the
 * audio model answers within 2 s: a person must never wait on a slow transcription. With
 * gemini-3.8-flash (4.5-8.5 s for a 3 s clip, measured 2026-11-20) it only learns.
 */
export function createAnnouncementMemory(
  transcribe: (audio: Buffer) => Promise<string | undefined>,
  log: (message: string) => void,
  now: () => number = Date.now,
) {
  const detector = createLoopDetector();
  let known = 0;
  let heard: Promise<string | undefined> | undefined;
  const timed = (audio: Buffer) => {
    const started = now();
    return transcribe(audio)
      .catch(() => undefined)
      .finally(() => {
        lastTranscribeMs = now() - started;
      });
  };
  const check: WakeCheck = async (audio) => {
    const fast = lastTranscribeMs !== undefined && lastTranscribeMs <= BLOCKING_TRANSCRIBE_MS;
    const text = timed(audio);
    heard = text;
    if (known === 0 || !fast) {
      return "wake";
    }
    const said = await text;
    if (!said) {
      return "wake";
    }
    const similarity = detector.similarity(said);
    const repeat = detector.isRepeat(said);
    log(`hold wake check similarity=${similarity.toFixed(2)} ${repeat ? "repeat" : "new"}`);
    if (repeat) {
      detector.addChunk(said);
      heard = undefined;
    }
    return repeat ? "repeat" : "wake";
  };
  return {
    check,
    /** The line went back on hold and nobody had answered: what woke us was a recording. */
    async noteRecording(): Promise<void> {
      const said = await heard;
      heard = undefined;
      if (said) {
        detector.addChunk(said);
        known += 1;
        log(`hold announcement learned (${known}) transcribeMs=${lastTranscribeMs ?? "?"}`);
      }
    },
    /** The assistant spoke: what woke us was a conversation, not an announcement. */
    noteConversation(): void {
      heard = undefined;
    },
  };
}

/** Tests: forget the measured transcription time. */
export function resetTranscribeTimingForTest(ms?: number): void {
  lastTranscribeMs = ms;
}

/**
 * The hold gate for one room call. "energy" is the original gate exactly (silence fed while
 * holding). "silero" judges speech with Silero, sends the model nothing while holding, and
 * checks wakes against known announcements; without Silero it falls back to "energy".
 */
export function createRoomHoldGate(
  call: CallRecord,
  onEvent: (event: HoldGateEvent) => void,
  log: (message: string) => void,
) {
  const vad = holdWakeServices.vad;
  if (holdDetectorOf(call) === "energy" || !vad) {
    return { gate: createHoldGate(onEvent), detector: "energy" as const, close: () => {} };
  }
  const transcribe = holdWakeServices.transcribe;
  const memory = transcribe
    ? createAnnouncementMemory((audio) => transcribeMulaw(audio, transcribe), log)
    : undefined;
  // Inference errors arrive asynchronously, after the gate below exists.
  let failed = false;
  const probs = createSileroProbSource(vad, (error) => {
    // A broken detector must not leave the model deaf: hand it the whole line instead.
    log(`Silero VAD failed (${String(error)}); hold gate off for this call`);
    failed = true;
    gate.setEnabled(false);
  });
  const gate = createHoldGate(
    (event) => {
      if (event === "hold" || event === "rehold") {
        void memory?.noteRecording();
      } else if (event === "release") {
        memory?.noteConversation();
      }
      onEvent(event);
    },
    { speechProbs: probs, holdFeed: "none", checkWake: memory?.check },
  );
  // The room re-enables the gate when the owner leaves; a dead detector must stay off.
  const setEnabled = gate.setEnabled.bind(gate);
  gate.setEnabled = (on) => setEnabled(on && !failed);
  return { gate, detector: "silero" as const, close: () => probs.close() };
}
