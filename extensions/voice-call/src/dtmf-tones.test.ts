import { mulawToPcm } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it } from "vitest";
import { encodeDtmfMulaw } from "./dtmf-tones.js";

const SAMPLE_RATE = 8_000;
const FRAME = 160;
const ROW_HZ = [697, 770, 852, 941];
const COLUMN_HZ = [1209, 1336, 1477, 1633];
const KEYPAD = ["123A", "456B", "789C", "*0#D"];
const DBM0_RMS = 22_656 / Math.SQRT2;

function goertzelPower(frame: number[], hz: number): number {
  const coeff = 2 * Math.cos((2 * Math.PI * hz) / SAMPLE_RATE);
  let prev = 0;
  let prev2 = 0;
  for (const sample of frame) {
    const next = sample + coeff * prev - prev2;
    prev2 = prev;
    prev = next;
  }
  return prev * prev + prev2 * prev2 - coeff * prev * prev2;
}

function strongest(frame: number[], freqs: number[]): { index: number; share: number } {
  const energy = frame.reduce((sum, sample) => sum + sample * sample, 0);
  const shares = freqs.map((hz) => (2 * goertzelPower(frame, hz)) / (frame.length * energy));
  const index = shares.indexOf(Math.max(...shares));
  const runnerUp = Math.max(...shares.filter((_, i) => i !== index));
  return { index, share: runnerUp * 4 < (shares[index] ?? 0) ? (shares[index] ?? 0) : 0 };
}

/** Decode keys from 8 kHz PCM in 20 ms frames; a silence of 400 ms or more between keys reads as "w". */
function decodeDtmf(pcm: Buffer): string {
  const samples = Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2));
  let out = "";
  let previous: string | undefined;
  let candidate: string | undefined;
  let silentFrames = 0;
  for (let start = 0; start + FRAME <= samples.length; start += FRAME) {
    const frame = samples.slice(start, start + FRAME);
    const rms = Math.sqrt(frame.reduce((sum, s) => sum + s * s, 0) / FRAME);
    const row = strongest(frame, ROW_HZ);
    const column = strongest(frame, COLUMN_HZ);
    const key =
      rms > DBM0_RMS * 0.05 &&
      row.share > 0.2 &&
      column.share > 0.2 &&
      row.share + column.share > 0.8
        ? KEYPAD[row.index]?.[column.index]
        : undefined;
    if (!key) {
      silentFrames += 1;
      previous = undefined;
      candidate = undefined;
      continue;
    }
    // A key counts once it holds for two frames, and again only after a break.
    if (key === candidate && key !== previous) {
      if (out && silentFrames * 20 >= 400) {
        out += "w";
      }
      out += key;
      previous = key;
      silentFrames = 0;
    }
    candidate = key;
  }
  return out;
}

function withNoise(pcm: Buffer, offsetSamples: number): Buffer {
  const out = Buffer.alloc(pcm.length + offsetSamples * 2);
  let seed = 7;
  for (let i = 0; i < out.length / 2; i += 1) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    const noise = ((seed / 2_147_483_648) * 2 - 1) * 300;
    const signal = i >= offsetSamples ? pcm.readInt16LE((i - offsetSamples) * 2) : 0;
    out.writeInt16LE(Math.max(-32_768, Math.min(32_767, Math.round(signal + noise))), i * 2);
  }
  return out;
}

describe("encodeDtmfMulaw", () => {
  it("renders every key so a Goertzel decoder reads the digits back", () => {
    const audio = encodeDtmfMulaw("1w*#09ad5");
    // 8 keys at 240 ms and one 500 ms pause, one mu-law byte per 8 kHz sample.
    expect(audio.length).toBe((8 * 240 + 500) * 8);
    // Off-grid start and line noise so frames straddle tone edges.
    expect(decodeDtmf(withNoise(mulawToPcm(audio), 37))).toBe("1w*#09AD5");
  });

  it("plays each key at a level and twist telephone receivers accept", () => {
    const pcm = mulawToPcm(encodeDtmfMulaw("5"));
    const tone = Array.from({ length: 1280 }, (_, i) => pcm.readInt16LE(i * 2));
    const rms = Math.sqrt(tone.reduce((sum, s) => sum + s * s, 0) / tone.length);
    // -7 dBm0 plus -5 dBm0 is about -2.9 dBm0 in total.
    expect(20 * Math.log10(rms / DBM0_RMS)).toBeCloseTo(-2.9, 0);
    const twistDb = 10 * Math.log10(goertzelPower(tone, 1336) / goertzelPower(tone, 770));
    expect(twistDb).toBeCloseTo(2, 0);
    const gap = Array.from({ length: 640 }, (_, i) => pcm.readInt16LE((1280 + i) * 2));
    expect(Math.max(...gap.map(Math.abs))).toBeLessThan(10);
  });

  it("rejects characters that are not keys or pauses", () => {
    expect(() => encodeDtmfMulaw("12x")).toThrow(/digits may only contain/);
    expect(() => encodeDtmfMulaw("")).toThrow(/digits may only contain/);
  });
});
