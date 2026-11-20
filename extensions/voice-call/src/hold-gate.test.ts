import { convertPcmToMulaw8k } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it } from "vitest";
import { classifyWindow, createHoldGate, type HoldGateEvent } from "./hold-gate.js";

const RATE = 8_000;

/** A 440 Hz tone at `amplitude` (0..1), switched by `on(ms)` to mimic syllables or music. */
function mulaw(ms: number, amplitude: number, on: (t: number) => boolean): Buffer {
  const samples = Math.floor((RATE * ms) / 1000);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const level = on((i / RATE) * 1000) ? amplitude : 0;
    pcm.writeInt16LE(Math.round(level * 32_000 * Math.sin((2 * Math.PI * 440 * i) / RATE)), i * 2);
  }
  return convertPcmToMulaw8k(pcm, RATE);
}

const speech = (ms: number) => mulaw(ms, 0.3, (t) => t % 250 < 150); // ~4 syllables/s with gaps
const music = (ms: number) => mulaw(ms, 0.1, () => true); // sustained
const isSilence = (frame: Buffer) => frame.every((byte) => byte === 0xff);

function feed(gate: ReturnType<typeof createHoldGate>, audio: Buffer, chunk = 160): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < audio.length; offset += chunk) {
    out.push(gate.accept(audio.subarray(offset, offset + chunk)));
  }
  return out;
}

function setup() {
  const events: HoldGateEvent[] = [];
  const gate = createHoldGate((event) => events.push(event));
  return { events, gate };
}

describe("classifyWindow", () => {
  it("tells speech, music and silence apart", () => {
    const opts = { lowEnergyRatio: 0.25, silenceRms: 0.0056 };
    const bursty = Array.from({ length: 75 }, (_, i) => (i % 12 < 7 ? 0.2 : 0.01));
    const steady = Array.from({ length: 75 }, (_, i) => 0.05 + 0.01 * Math.sin(i));
    expect(classifyWindow(bursty, opts)).toBe("speech");
    expect(classifyWindow(steady, opts)).toBe("music");
    expect(
      classifyWindow(
        Array.from({ length: 75 }, () => 0.001),
        opts,
      ),
    ).toBe("silence");
  });
});

describe("createHoldGate", () => {
  it("leaves conversation audio alone", () => {
    const { events, gate } = setup();
    const audio = speech(20_000);
    expect(Buffer.concat(feed(gate, audio)).equals(audio)).toBe(true);
    expect(events).toEqual([]);
  });

  it("holds after 10 s of music and wakes on speech with a 3 s replay", () => {
    const { events, gate } = setup();
    const heard = feed(gate, music(20_000));
    expect(events).toEqual(["hold"]);
    expect(gate.mode).toBe("hold");
    expect(heard.slice(0, 400).some(isSilence)).toBe(false); // the first 8 s still reach the model
    expect(heard.slice(-100).every(isSilence)).toBe(true);

    const woke = feed(gate, speech(3_000));
    expect(events).toEqual(["hold", "speech"]);
    expect(woke.find((frame) => frame.length > 160)?.length).toBe(3 * RATE);
    expect(gate.mode).toBe("probe");
    const live = speech(20);
    expect(gate.accept(live)).toBe(live);
  });

  it("returns to hold after a recorded announcement nobody answered", () => {
    const { events, gate } = setup();
    feed(gate, music(12_000));
    feed(gate, speech(4_000));
    feed(gate, music(11_000));
    expect(events).toEqual(["hold", "speech", "rehold"]);
    expect(gate.mode).toBe("hold");
  });

  it("stays live once the assistant answers, and while it keeps talking", () => {
    const { events, gate } = setup();
    feed(gate, music(12_000));
    feed(gate, speech(3_000));
    gate.noteAssistantSpeech();
    for (let second = 0; second < 15; second += 1) {
      feed(gate, music(1_000));
      gate.noteAssistantSpeech();
    }
    expect(events).toEqual(["hold", "speech", "release"]);
    expect(gate.mode).toBe("live");
  });

  it("release forgets a hold, and odd frame sizes still classify", () => {
    const { events, gate } = setup();
    feed(gate, music(12_000), 97);
    expect(gate.mode).toBe("hold");
    gate.release();
    expect(gate.mode).toBe("live");
    expect(events).toEqual(["hold", "release"]);
  });
});
