import { calculateMulawRms } from "openclaw/plugin-sdk/realtime-voice";

/** 20 ms of 8 kHz G.711 mu-law, the frame size Twilio media streams use. */
const FRAME_BYTES = 160;
const MULAW_SILENCE = 0xff;

export type HoldGateMode = "live" | "hold" | "probe";

export type HoldGateOptions = {
  /** Frames per classification window (default 75 = 1.5 s). */
  windowFrames?: number;
  /** Frames between classifications (default 25 = 0.5 s). */
  hopFrames?: number;
  /** Consecutive music windows, with the assistant silent, that start a hold (default 20 = 10 s). */
  holdHops?: number;
  /** Consecutive speech-like windows that end a hold (default 3). */
  speechHops?: number;
  /** Consecutive non-speech windows that return an unanswered probe to hold (default 16 = 8 s). */
  reholdHops?: number;
  /** Share of quiet frames that marks speech: syllable gaps; music is sustained (default 0.25). */
  lowEnergyRatio?: number;
  /** Mean RMS below this is silence (default 0.0056, about -45 dBFS). */
  silenceRms?: number;
  /** Audio replayed to the model when speech ends a hold (default 150 frames = 3 s). */
  prerollFrames?: number;
};

export type HoldGateEvent = "hold" | "speech" | "rehold" | "release";

export type WindowClass = "silence" | "speech" | "music";

/**
 * Classic speech/music cue (Scheirer & Slaney): speech has frequent quiet frames between
 * syllables, music keeps its energy up. On a Twilio lab recording, speech windows scored
 * 0.27-0.9 and classical hold music 0-0.21, with single-window spikes at song transitions.
 */
export function classifyWindow(
  rms: readonly number[],
  options: { lowEnergyRatio: number; silenceRms: number },
): WindowClass {
  if (rms.length === 0) {
    return "silence";
  }
  const mean = rms.reduce((sum, value) => sum + value, 0) / rms.length;
  if (mean < options.silenceRms) {
    return "silence";
  }
  const quiet = rms.filter((value) => value < 0.5 * mean).length / rms.length;
  return quiet >= options.lowEnergyRatio ? "speech" : "music";
}

/**
 * Keeps hold music away from the realtime model, which re-bills the whole conversation each
 * time music makes it take a turn. After sustained music with the assistant silent, inbound
 * frames are replaced by silence and classified locally. Sustained speech ends the hold and the
 * last few seconds are replayed, so the model hears a person from their first word. A probe
 * (speech during a hold) goes back to holding when the line returns to music or silence and the
 * assistant never spoke, which covers recorded "please hold" announcements.
 */
export function createHoldGate(
  onEvent: (event: HoldGateEvent) => void = () => {},
  options: HoldGateOptions = {},
) {
  const windowFrames = options.windowFrames ?? 75;
  const hopFrames = options.hopFrames ?? 25;
  const holdHops = options.holdHops ?? 20;
  const speechHops = options.speechHops ?? 3;
  const reholdHops = options.reholdHops ?? 16;
  const prerollFrames = Math.max(options.prerollFrames ?? 150, windowFrames);
  const thresholds = {
    lowEnergyRatio: options.lowEnergyRatio ?? 0.25,
    silenceRms: options.silenceRms ?? 0.0056,
  };
  let mode: HoldGateMode = "live";
  let frames: Buffer[] = [];
  let levels: number[] = [];
  let pending = Buffer.alloc(0);
  let sinceHop = 0;
  let speechRun = 0;
  let musicRun = 0;
  let quietRun = 0;
  let wokeWith: Buffer | undefined;

  const resetRuns = () => {
    sinceHop = 0;
    speechRun = 0;
    musicRun = 0;
    quietRun = 0;
  };
  const enter = (next: HoldGateMode, event: HoldGateEvent) => {
    mode = next;
    resetRuns();
    onEvent(event);
  };

  const classifyFrame = (frame: Buffer) => {
    frames.push(frame);
    levels.push(calculateMulawRms(frame));
    if (frames.length > prerollFrames) {
      frames.shift();
      levels.shift();
    }
    sinceHop += 1;
    if (sinceHop < hopFrames || levels.length < windowFrames) {
      return;
    }
    sinceHop = 0;
    const kind = classifyWindow(levels.slice(-windowFrames), thresholds);
    speechRun = kind === "speech" ? speechRun + 1 : 0;
    musicRun = kind === "music" ? musicRun + 1 : 0;
    quietRun = kind === "speech" ? 0 : quietRun + 1;
    if (mode === "live" && musicRun >= holdHops) {
      enter("hold", "hold");
    } else if (mode === "hold" && speechRun >= speechHops) {
      wokeWith = Buffer.concat(frames);
      enter("probe", "speech");
    } else if (mode === "probe" && quietRun >= reholdHops) {
      enter("hold", "rehold");
    }
  };

  return {
    get mode(): HoldGateMode {
      return mode;
    },
    /** Back to normal and forget the history: a person joined or the call ended. */
    release(): void {
      const was = mode;
      mode = "live";
      frames = [];
      levels = [];
      pending = Buffer.alloc(0);
      resetRuns();
      if (was !== "live") {
        onEvent("release");
      }
    },
    /** The assistant is speaking: a conversation is on, so neither hold nor probe applies. */
    noteAssistantSpeech(): void {
      if (mode === "probe") {
        enter("live", "release");
      } else if (mode === "live") {
        musicRun = 0;
      }
    },
    /**
     * Returns what the model should hear for this frame: the frame itself, silence of the same
     * length while holding, or, on the frame that ends a hold, the last seconds of the line.
     */
    accept(audio: Buffer): Buffer {
      const holding = mode === "hold";
      let data = pending.length > 0 ? Buffer.concat([pending, audio]) : audio;
      while (data.length >= FRAME_BYTES) {
        classifyFrame(data.subarray(0, FRAME_BYTES));
        data = data.subarray(FRAME_BYTES);
      }
      pending = Buffer.from(data);
      if (wokeWith) {
        const preroll = wokeWith;
        wokeWith = undefined;
        return preroll;
      }
      return holding ? Buffer.alloc(audio.length, MULAW_SILENCE) : audio;
    },
  };
}

export type HoldGate = ReturnType<typeof createHoldGate>;
