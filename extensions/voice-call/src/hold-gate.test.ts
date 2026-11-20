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

  it("can be switched off while the owner is on the line, and odd frame sizes still classify", () => {
    const { events, gate } = setup();
    feed(gate, music(12_000), 97);
    expect(gate.mode).toBe("hold");
    gate.setEnabled(false);
    expect(gate.mode).toBe("live");
    const audio = music(20_000);
    expect(Buffer.concat(feed(gate, audio)).equals(audio)).toBe(true);
    expect(events).toEqual(["hold", "release"]);
    gate.setEnabled(true);
    feed(gate, music(12_000));
    expect(events).toEqual(["hold", "release", "hold"]);
  });

  it("wakes from a hold when the assistant speaks", () => {
    const { events, gate } = setup();
    feed(gate, music(12_000));
    gate.noteAssistantSpeech();
    expect(gate.mode).toBe("live");
    expect(events).toEqual(["hold", "release"]);
  });
});

describe("createHoldGate with Silero probabilities", () => {
  /** Silero stand-in: speech probability 0.9 while `speaking` is true, else 0. */
  function sileroGate(options: Parameters<typeof createHoldGate>[1] = {}) {
    const events: HoldGateEvent[] = [];
    const state = { speaking: false, probs: [] as number[], frames: 0 };
    const speechProbs = {
      push() {
        state.frames += 1;
        while (state.probs.length < Math.floor((state.frames * 160) / 256)) {
          state.probs.push(state.speaking ? 0.9 : 0);
        }
      },
      recent: (count: number) => state.probs.slice(-count),
    };
    const gate = createHoldGate((event) => events.push(event), {
      speechProbs,
      holdFeed: "none",
      ...options,
    });
    const say = (ms: number, audio = speech(ms)) => {
      state.speaking = true;
      const out = feed(gate, audio);
      state.speaking = false;
      return out;
    };
    /** Frame by frame with a macrotask between, as a live stream lets a check answer arrive. */
    const sayLive = async (ms: number) => {
      const audio = speech(ms);
      const out: Buffer[] = [];
      state.speaking = true;
      for (let offset = 0; offset < audio.length; offset += 160) {
        out.push(gate.accept(audio.subarray(offset, offset + 160)));
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
      }
      state.speaking = false;
      return out;
    };
    return { events, gate, say, sayLive };
  }

  it("holds on music that the energy rule calls speech, then sends the model nothing", () => {
    const { events, gate } = sileroGate();
    // Bursty audio that Silero scores as non-speech (sung or drum-heavy hold music).
    const audio = speech(13_020);
    feed(gate, audio.subarray(0, 550 * 160)); // the hold starts on the 550th frame (11 s)
    expect(events).toEqual(["hold"]);
    // The first second of the hold is silence, so the model's turn detection settles.
    const tail = feed(gate, audio.subarray(550 * 160, 600 * 160));
    expect(tail.every((frame) => frame.length === 160 && isSilence(frame))).toBe(true);
    const after = feed(gate, audio.subarray(600 * 160));
    expect(after.every((frame) => frame.length === 0)).toBe(true);
  });

  it("wakes within a second of speech and replays the held-back audio", () => {
    const { events, gate, say } = sileroGate();
    feed(gate, music(15_000));
    const woke = say(1_000);
    expect(events).toEqual(["hold", "speech"]);
    expect(gate.mode).toBe("probe");
    expect(woke.find((frame) => frame.length > 160)?.length).toBe(3 * RATE);
  });

  it("keeps a repeated announcement on hold and ignores the rest of it", async () => {
    const checks: Buffer[] = [];
    const { events, gate, sayLive } = sileroGate({
      checkWake: async (audio) => {
        checks.push(audio);
        return "repeat";
      },
    });
    feed(gate, music(12_000));
    const during = await sayLive(4_000);
    expect(checks).toHaveLength(1);
    expect(events).toEqual(["hold", "repeat"]);
    expect(gate.mode).toBe("hold");
    expect(during.slice(-50).every((frame) => frame.length === 0)).toBe(true);
    // After a pause, new speech is checked again.
    feed(gate, music(2_000));
    await sayLive(1_000);
    expect(checks).toHaveLength(2);
  });

  it("wakes with everything heard while the check ran, or when it takes too long", async () => {
    let answer: ((verdict: "wake" | "repeat") => void) | undefined;
    const { events, gate, say } = sileroGate({
      checkWake: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    feed(gate, music(15_000));
    say(1_000);
    expect(events).toEqual(["hold"]);
    answer?.("wake");
    await Promise.resolve();
    const woke = say(100);
    expect(events).toEqual(["hold", "speech"]);
    expect(woke.find((frame) => frame.length > 160)?.length).toBeGreaterThan(3 * RATE);

    const slow = sileroGate({ checkWake: () => new Promise(() => {}) });
    feed(slow.gate, music(12_000));
    slow.say(4_000);
    expect(slow.events).toEqual(["hold", "speech"]);
  });

  it("re-checks speech that runs on after a repeat, so a person cannot be ignored", async () => {
    const checks: string[] = [];
    const { events, gate, sayLive } = sileroGate({
      checkWake: async () => {
        checks.push("check");
        return checks.length === 1 ? "repeat" : "wake";
      },
    });
    feed(gate, music(15_000));
    await sayLive(9_000);
    expect(checks).toHaveLength(2);
    expect(events).toEqual(["hold", "repeat", "speech"]);
  });

  it("replays only what the model missed after a hold it asked for", () => {
    const { events, gate, say } = sileroGate();
    feed(gate, music(3_000));
    gate.holdNow();
    const woke = say(1_000);
    expect(events).toEqual(["hold", "speech"]);
    const replay = woke.find((frame) => frame.length > 160);
    expect(replay?.length).toBeLessThan(RATE);
    // The grace for the tool's reply ends with the wake: the assistant's speech now counts.
    gate.noteAssistantSpeech();
    expect(gate.mode).toBe("live");
  });

  it("holds at once when the model says so, and its reply does not end the hold", () => {
    const { events, gate } = sileroGate();
    feed(gate, speech(2_000));
    gate.holdNow(1_000);
    gate.noteAssistantSpeech();
    expect(gate.mode).toBe("hold");
    feed(gate, music(1_500));
    gate.noteAssistantSpeech();
    expect(events).toEqual(["hold", "release"]);
  });
});
