import { describe, expect, it, vi } from "vitest";
import {
  createSileroVad,
  findSileroModel,
  SILERO_CHUNK_SAMPLES,
  type OrtRuntime,
} from "./silero-vad.js";

class FakeTensor {
  constructor(
    readonly type: string,
    readonly data: Float32Array | BigInt64Array,
    readonly dims: readonly number[],
  ) {}
}

function fakeOrt(run: (feeds: Record<string, FakeTensor>) => Promise<Record<string, unknown>>) {
  const runs: Record<string, FakeTensor>[] = [];
  const ort = {
    InferenceSession: {
      create: vi.fn(async () => ({
        run: async (feeds: Record<string, unknown>) => {
          runs.push(feeds as Record<string, FakeTensor>);
          return run(feeds as Record<string, FakeTensor>);
        },
      })),
    },
    Tensor: FakeTensor,
  } as unknown as OrtRuntime;
  return { ort, runs };
}

const settle = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 10);
  });

describe("createSileroVad", () => {
  it("scores 32 ms chunks in order, with 32 samples of context and the carried state", async () => {
    let call = 0;
    const { ort, runs } = fakeOrt(async () => ({
      output: { data: [++call / 10] },
      stateN: new FakeTensor("float32", new Float32Array(256).fill(call), [2, 1, 128]),
    }));
    const vad = await createSileroVad(ort, "model.onnx");
    const probs: number[] = [];
    const stream = vad.open(
      (prob) => probs.push(prob),
      () => {},
    );
    // 600 mu-law samples: two full chunks, 88 samples carried over.
    stream.push(Buffer.alloc(300, 0x80));
    stream.push(Buffer.alloc(300, 0x00));
    await settle();
    expect(probs).toEqual([0.1, 0.2]);
    expect(runs).toHaveLength(2);
    expect(runs[0]?.input?.dims).toEqual([1, 32 + SILERO_CHUNK_SAMPLES]);
    expect(runs[0]?.sr?.data).toEqual(BigInt64Array.from([8_000n]));
    const first = runs[0]?.input?.data as Float32Array;
    const second = runs[1]?.input?.data as Float32Array;
    expect(Array.from(second.subarray(0, 32))).toEqual(Array.from(first.subarray(-32)));
    expect(runs[1]?.state?.data).toEqual(new Float32Array(256).fill(1));
  });

  it("reports a failed inference once and stops scoring", async () => {
    const { ort, runs } = fakeOrt(async () => {
      throw new Error("boom");
    });
    const vad = await createSileroVad(ort, "model.onnx");
    const onError = vi.fn();
    const stream = vad.open(() => {}, onError);
    stream.push(Buffer.alloc(1_024, 0x80));
    await settle();
    stream.push(Buffer.alloc(1_024, 0x80));
    await settle();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(runs).toHaveLength(1);
  });

  it("finds the bundled model next to the plugin source", () => {
    expect(findSileroModel(import.meta.url)).toMatch(/assets[/\\]silero_vad\.onnx$/u);
  });

  it("runs the real model: line silence scores as no speech", async () => {
    const modelPath = findSileroModel(import.meta.url);
    const ort = (await import("onnxruntime-node").catch(() => undefined)) as
      | { default?: OrtRuntime }
      | undefined;
    if (!ort || !modelPath) {
      return;
    }
    const vad = await createSileroVad(ort.default ?? (ort as unknown as OrtRuntime), modelPath);
    const probs: number[] = [];
    const stream = vad.open(
      (prob) => probs.push(prob),
      (error) => {
        throw error;
      },
    );
    stream.push(Buffer.alloc(8_000, 0xff)); // one second of mu-law silence
    await vi.waitFor(() => expect(probs).toHaveLength(31));
    expect(Math.max(...probs)).toBeLessThan(0.1);
  });
});
