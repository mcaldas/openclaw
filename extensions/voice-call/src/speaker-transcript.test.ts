import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSpeakerTranscript,
  encodeWavMono,
  findSpeechSegments,
  readWavChannel,
} from "./speaker-transcript.js";

const RATE = 8_000;
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** Seconds of audio: "speech" is 150 ms bursts with gaps, "music" a steady tone, "quiet" silence. */
function audio(parts: ["speech" | "music" | "quiet", number][]): Int16Array {
  const samples: number[] = [];
  for (const [kind, seconds] of parts) {
    for (let i = 0; i < seconds * RATE; i += 1) {
      const t = (i / RATE) * 1000;
      const on = kind === "music" || (kind === "speech" && t % 250 < 150);
      const amplitude = kind === "music" ? 3_000 : 9_000;
      samples.push(on ? Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / RATE)) : 0);
    }
  }
  return Int16Array.from(samples);
}

/** Two-channel WAV the way Twilio serves recordings: channel 0 the far end, channel 1 the room. */
function stereoWav(left: Int16Array, right: Int16Array): Buffer {
  const mono = encodeWavMono(new Int16Array(left.length * 2), RATE);
  mono.writeUInt16LE(2, 22);
  mono.writeUInt32LE(RATE * 4, 28);
  mono.writeUInt16LE(4, 32);
  for (let i = 0; i < left.length; i += 1) {
    mono.writeInt16LE(left[i] ?? 0, 44 + i * 4);
    mono.writeInt16LE(right[i] ?? 0, 46 + i * 4);
  }
  return mono;
}

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-call-transcript-"));
  dirs.push(dir);
  return dir;
}

describe("readWavChannel", () => {
  it("splits a two-channel recording", () => {
    const left = Int16Array.from([1, 2, 3]);
    const right = Int16Array.from([-1, -2, -3]);
    const wav = stereoWav(left, right);
    expect(Array.from(readWavChannel(wav, 0).samples)).toEqual([1, 2, 3]);
    expect(Array.from(readWavChannel(wav, 1).samples)).toEqual([-1, -2, -3]);
    expect(readWavChannel(wav, 0).rate).toBe(RATE);
    expect(() => readWavChannel(Buffer.from("RIFF-two-channel-wav"), 0)).toThrow();
  });
});

describe("findSpeechSegments", () => {
  it("finds speech by loudness and marks sustained music", () => {
    const segments = findSpeechSegments(
      audio([
        ["quiet", 1],
        ["speech", 2],
        ["quiet", 2],
        ["music", 6],
      ]),
      RATE,
    );
    expect(segments).toHaveLength(2);
    expect(segments[0]?.music).toBe(false);
    expect(segments[0]?.start).toBeCloseTo(0.8, 1);
    expect(segments[0]?.end).toBeGreaterThan(2.8);
    expect(segments[1]?.music).toBe(true);
  });
});

describe("buildSpeakerTranscript", () => {
  it("merges each person's channel with the assistant's own words, by time", async () => {
    const dir = await tempDir();
    const callee = path.join(dir, "callee.wav");
    const owner = path.join(dir, "owner.wav");
    const silence = audio([["quiet", 8]]);
    await fs.writeFile(
      callee,
      stereoWav(
        audio([
          ["speech", 1],
          ["quiet", 1],
          ["music", 6],
        ]),
        silence,
      ),
    );
    await fs.writeFile(
      owner,
      stereoWav(
        audio([
          ["quiet", 1],
          ["speech", 1],
          ["quiet", 1],
        ]),
        silence,
      ),
    );
    const seen: string[] = [];
    const transcript = await buildSpeakerTranscript({
      legs: [
        { label: "Callee", file: callee, startedAt: 100_000 },
        { label: "Mathias", file: owner, startedAt: 104_000 },
      ],
      assistant: [{ at: 102_000, text: "Please hold for Mathias." }],
      assistantLabel: "Assistant",
      transcribe: async (file) => {
        seen.push(file);
        return seen.length === 1
          ? "שלום, במה אפשר לעזור?\nEN: Hello, how can I help?"
          : "Hi, it's me.";
      },
      workDir: path.join(dir, "work"),
      concurrency: 1,
    });
    expect(transcript.split("\n")).toEqual([
      "[00:00] **Callee:** שלום, במה אפשר לעזור? _(Hello, how can I help?)_",
      "[00:02] **Callee:** [hold music]",
      "[00:02] **Assistant:** Please hold for Mathias.",
      "[00:05] **Mathias:** Hi, it's me.",
    ]);
    expect(seen).toHaveLength(2);
    await expect(fs.stat(path.join(dir, "work"))).rejects.toThrow();
  });

  it("drops segments the model hears as no speech", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "callee.wav");
    await fs.writeFile(file, stereoWav(audio([["speech", 1]]), audio([["quiet", 1]])));
    const transcript = await buildSpeakerTranscript({
      legs: [{ label: "Callee", file, startedAt: 0 }],
      assistant: [],
      assistantLabel: "Assistant",
      transcribe: async () => "[no speech]",
      workDir: path.join(dir, "work"),
    });
    expect(transcript).toBe("");
  });
});
