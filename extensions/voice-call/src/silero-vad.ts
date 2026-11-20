// Silero VAD (https://github.com/snakers4/silero-vad), MIT License,
// Copyright (c) 2020-present Silero Team. The model file ships as assets/silero_vad.onnx with its
// licence in assets/silero_vad.LICENSE; this wrapper follows the project's OnnxWrapper at 8 kHz.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mulawToPcm } from "openclaw/plugin-sdk/realtime-voice";

const SAMPLE_RATE = 8_000;
/** Silero takes 256 new samples (32 ms) at 8 kHz, preceded by the last 32 samples it saw. */
export const SILERO_CHUNK_SAMPLES = 256;
const CONTEXT_SAMPLES = 32;
const STATE_SIZE = 2 * 128;
const MODEL_FILE = "silero_vad.onnx";

type OrtTensor = { data: ArrayLike<number> };
type OrtSession = {
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
};
/** The slice of onnxruntime-node this wrapper uses, so tests can pass a fake runtime. */
export type OrtRuntime = {
  InferenceSession: {
    create(
      model: string | Uint8Array,
      options?: { intraOpNumThreads?: number; interOpNumThreads?: number },
    ): Promise<OrtSession>;
  };
  Tensor: new (type: string, data: unknown, dims: readonly number[]) => unknown;
};

export type SpeechProbStream = {
  /** Feeds 8 kHz G.711 mu-law; one probability per completed 32 ms chunk, in order. */
  push(mulaw: Buffer): void;
  close(): void;
};

export type SileroVad = {
  open(onProb: (prob: number) => void, onError: (error: unknown) => void): SpeechProbStream;
};

/** Looks for the model next to the plugin: src/ and both dist/ depths sit under the package root. */
export function findSileroModel(fromUrl: string = import.meta.url): string | undefined {
  let dir = path.dirname(fileURLToPath(fromUrl));
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = path.join(dir, "assets", MODEL_FILE);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    dir = path.dirname(dir);
  }
  return undefined;
}

/** One inference session per process; each call keeps its own recurrent state. */
export async function createSileroVad(ort: OrtRuntime, modelPath: string): Promise<SileroVad> {
  const session = await ort.InferenceSession.create(modelPath, {
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
  });
  const sampleRate = new ort.Tensor("int64", BigInt64Array.from([BigInt(SAMPLE_RATE)]), []);
  return {
    open(onProb, onError) {
      let state: unknown = new ort.Tensor("float32", new Float32Array(STATE_SIZE), [2, 1, 128]);
      let context = new Float32Array(CONTEXT_SAMPLES);
      let samples = new Float32Array(0);
      let queue = Promise.resolve();
      let closed = false;
      let failed = false;
      const runChunk = async (chunk: Float32Array) => {
        const input = new Float32Array(CONTEXT_SAMPLES + SILERO_CHUNK_SAMPLES);
        input.set(context);
        input.set(chunk, CONTEXT_SAMPLES);
        context = input.slice(-CONTEXT_SAMPLES);
        const out = await session.run({
          input: new ort.Tensor("float32", input, [1, input.length]),
          state,
          sr: sampleRate,
        });
        state = out.stateN;
        if (!closed) {
          onProb(out.output?.data[0] ?? 0);
        }
      };
      return {
        push(mulaw) {
          if (closed || failed || mulaw.length === 0) {
            return;
          }
          const pcm = mulawToPcm(mulaw);
          const next = new Float32Array(samples.length + mulaw.length);
          next.set(samples);
          for (let i = 0; i < mulaw.length; i += 1) {
            next[samples.length + i] = pcm.readInt16LE(i * 2) / 32_768;
          }
          let offset = 0;
          while (next.length - offset >= SILERO_CHUNK_SAMPLES) {
            const chunk = next.slice(offset, offset + SILERO_CHUNK_SAMPLES);
            offset += SILERO_CHUNK_SAMPLES;
            queue = queue.then(() => (failed || closed ? undefined : runChunk(chunk)));
          }
          samples = next.slice(offset);
          queue = queue.catch((error: unknown) => {
            if (!failed && !closed) {
              failed = true;
              onError(error);
            }
          });
        },
        close() {
          closed = true;
        },
      };
    },
  };
}

let shared: Promise<SileroVad | undefined> | undefined;

/**
 * Loads onnxruntime-node (an optional dependency) and the bundled model once per process.
 * Resolves undefined when either is missing, so callers fall back to the energy detector.
 */
export function loadSileroVad(log: (message: string) => void = console.warn) {
  shared ??= (async () => {
    const modelPath = findSileroModel();
    if (!modelPath) {
      log(`[voice-call] Silero VAD model ${MODEL_FILE} not found; hold detection uses energy`);
      return undefined;
    }
    try {
      // SAFETY: onnxruntime-node's InferenceSession and Tensor cover OrtRuntime, the slice used here.
      const ort = (await import("onnxruntime-node")) as unknown as OrtRuntime & {
        default?: OrtRuntime;
      };
      return await createSileroVad(ort.default ?? ort, modelPath);
    } catch (error) {
      log(`[voice-call] Silero VAD unavailable (${String(error)}); hold detection uses energy`);
      return undefined;
    }
  })();
  return shared;
}

/**
 * Feeds a call's inbound frames to Silero and keeps the recent probabilities for the hold gate.
 * Inference runs off the audio path; a window may miss the newest 32 ms chunk, never more.
 */
export function createSileroProbSource(
  vad: SileroVad,
  onError: (error: unknown) => void,
  keep = 512,
) {
  let probs: number[] = [];
  const stream = vad.open((prob) => {
    probs.push(prob);
    if (probs.length > keep * 2) {
      probs = probs.slice(-keep);
    }
  }, onError);
  return {
    push: (frame: Buffer) => stream.push(frame),
    recent: (count: number) => probs.slice(-count),
    close: () => stream.close(),
  };
}
