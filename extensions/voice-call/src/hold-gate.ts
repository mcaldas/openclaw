import { calculateMulawRms } from "openclaw/plugin-sdk/realtime-voice";

/** 20 ms of 8 kHz G.711 mu-law, the frame size Twilio media streams use. */
const FRAME_BYTES = 160;
const MULAW_SILENCE = 0xff;

export type HoldGateMode = "live" | "hold" | "probe";

/** Speech probabilities for the inbound line, one per 32 ms chunk (Silero VAD). */
export type SpeechProbSource = {
  push(frame: Buffer): void;
  /** The newest `count` probabilities, oldest first (fewer at the start of a call). */
  recent(count: number): number[];
};

/** Decides whether a wake candidate is a person or a recording heard earlier on this hold. */
export type WakeCheck = (audio: Buffer) => Promise<"wake" | "repeat">;

export type HoldGateOptions = {
  /** Frames per classification window (default 75 = 1.5 s). */
  windowFrames?: number;
  /** Frames between classifications (default 25 = 0.5 s). */
  hopFrames?: number;
  /** Consecutive music windows, with the assistant silent, that start a hold (default 20 = 10 s). */
  holdHops?: number;
  /** Consecutive speech-like windows that end a hold (default 3, or 1 with Silero). */
  speechHops?: number;
  /** Consecutive non-speech windows that return an unanswered probe to hold (default 16 = 8 s). */
  reholdHops?: number;
  /** Share of quiet frames that marks speech: syllable gaps; music is sustained (default 0.25). */
  lowEnergyRatio?: number;
  /** Mean RMS below this is silence (default 0.0056, about -45 dBFS). */
  silenceRms?: number;
  /** Audio replayed to the model when speech ends a hold (default 150 frames = 3 s). */
  prerollFrames?: number;
  /** Silero probabilities: when set, they decide speech instead of the energy pattern. */
  speechProbs?: SpeechProbSource;
  /** Silero chunks (32 ms) judged together (default 62 = 2 s). */
  speechWindowChunks?: number;
  /** Chunks in that window Silero must call speech (default 16 = 0.5 s). */
  minSpeechChunks?: number;
  /** While holding the model hears silence frames ("silence") or, after a short tail, nothing. */
  holdFeed?: "silence" | "none";
  /** Silence frames sent before the feed stops, so the model's turn detection settles (50 = 1 s). */
  silenceTailFrames?: number;
  /** A silent line counts toward a hold like music does (default false). */
  holdOnSilence?: boolean;
  /** Asked before a wake reaches the model; it hears nothing until the answer. */
  checkWake?: WakeCheck;
  /** Frames to wait for that answer before waking anyway (default 125 = 2.5 s). */
  wakeCheckTimeoutFrames?: number;
};

export type HoldGateEvent = "hold" | "speech" | "rehold" | "release" | "repeat";

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
 * Silero's view of the last 2 s: speech once half a second of it scores as speech. Instrumental
 * hold music scores near 0; sung vocals can score high, which costs a short probe, while a quiet
 * monotone agent still wakes the model within about 2 s (hold-audio lab set, 2026-11-20). The
 * energy level still separates a silent line from music, which Silero scores alike.
 */
export function classifySpeechWindow(
  probs: readonly number[],
  rms: readonly number[],
  options: { minSpeechChunks: number; silenceRms: number },
): WindowClass {
  if (probs.filter((prob) => prob >= 0.5).length >= options.minSpeechChunks) {
    return "speech";
  }
  const mean = rms.length === 0 ? 0 : rms.reduce((sum, value) => sum + value, 0) / rms.length;
  return mean < options.silenceRms ? "silence" : "music";
}

/**
 * Keeps hold music away from the realtime model, which re-bills the whole conversation each
 * time music makes it take a turn. After sustained music with the assistant silent, inbound
 * frames are replaced by silence (or, with holdFeed "none", not sent at all) and classified
 * locally. Sustained speech ends the hold and the last few seconds are replayed, so the model
 * hears a person from their first word. A probe (speech during a hold) goes back to holding
 * when the line returns to music or silence and the assistant never spoke, which covers
 * recorded "please hold" announcements; checkWake can keep a known announcement from waking
 * the model at all.
 */
export function createHoldGate(
  onEvent: (event: HoldGateEvent) => void = () => {},
  options: HoldGateOptions = {},
) {
  const windowFrames = options.windowFrames ?? 75;
  const hopFrames = options.hopFrames ?? 25;
  const holdHops = options.holdHops ?? 20;
  const speechProbs = options.speechProbs;
  const speechHops = options.speechHops ?? (speechProbs ? 1 : 3);
  const speechWindowChunks = options.speechWindowChunks ?? 62;
  const reholdHops = options.reholdHops ?? 16;
  const prerollFrames = Math.max(options.prerollFrames ?? 150, windowFrames);
  const silenceTailFrames = options.silenceTailFrames ?? 50;
  const wakeCheckTimeoutFrames = options.wakeCheckTimeoutFrames ?? 125;
  const feedNothing = options.holdFeed === "none";
  const thresholds = {
    lowEnergyRatio: options.lowEnergyRatio ?? 0.25,
    silenceRms: options.silenceRms ?? 0.0056,
    minSpeechChunks: options.minSpeechChunks ?? 16,
  };
  let mode: HoldGateMode = "live";
  let enabled = true;
  let frames: Buffer[] = [];
  let levels: number[] = [];
  let pending = Buffer.alloc(0);
  let sinceHop = 0;
  let speechRun = 0;
  let musicRun = 0;
  let quietRun = 0;
  let wokeWith: Buffer | undefined;
  let heldFrames = 0;
  let graceFrames = 0;
  /** A wake waiting for checkWake: frames heard since, and how long it has waited. */
  let checking: { audio: Buffer[]; waited: number; verdict?: "wake" | "repeat" } | undefined;
  /** After a repeat, the rest of that announcement must not start another check... */
  let ignoreSpeech = false;
  /** ...for at most 6 s, about one announcement: longer speech gets a fresh check (a person?). */
  let ignoredHops = 0;
  let checkGeneration = 0;
  /** Callers waiting for this hold to end (the model's own "hold" tool call waits here). */
  let holdWaiters: ((how: "speech" | "release") => void)[] = [];
  /** Callers waiting for the person who woke the line to pause, with frames left to wait. */
  let pauseWaiters: { resolve: () => void; framesLeft: number }[] = [];
  const settlePauseWaiters = (all: boolean) => {
    const keep = all ? [] : pauseWaiters.filter((w) => w.framesLeft > 0);
    for (const waiter of pauseWaiters) {
      if (all || waiter.framesLeft <= 0) {
        waiter.resolve();
      }
    }
    pauseWaiters = keep;
  };
  const settleWaiters = (how: "speech" | "release") => {
    const waiting = holdWaiters;
    holdWaiters = [];
    for (const resolve of waiting) {
      resolve(how);
    }
  };

  const resetRuns = () => {
    sinceHop = 0;
    speechRun = 0;
    musicRun = 0;
    quietRun = 0;
  };
  const enter = (next: HoldGateMode, event: HoldGateEvent) => {
    if (mode === "hold" && next !== "hold") {
      settleWaiters(next === "probe" ? "speech" : "release");
    }
    mode = next;
    heldFrames = 0;
    checking = undefined;
    checkGeneration += 1;
    resetRuns();
    onEvent(event);
  };
  const wake = (audio: Buffer) => {
    wokeWith = audio;
    ignoreSpeech = false;
    graceFrames = 0;
    enter("probe", "speech");
  };
  const startCheck = (check: WakeCheck, preroll: Buffer) => {
    const generation = checkGeneration;
    const state: NonNullable<typeof checking> = { audio: [preroll], waited: 0 };
    checking = state;
    const answer = (verdict: "wake" | "repeat") => {
      if (generation === checkGeneration && checking === state) {
        state.verdict = verdict;
      }
    };
    check(preroll).then(answer, () => answer("wake"));
  };
  /** Applies a check answer on the audio path, so mode changes stay in frame order. */
  const settleCheck = () => {
    if (!checking) {
      return;
    }
    checking.waited += 1;
    if (!checking.verdict && checking.waited < wakeCheckTimeoutFrames) {
      return;
    }
    const { audio, verdict } = checking;
    checking = undefined;
    if (verdict === "repeat") {
      ignoreSpeech = true;
      ignoredHops = 0;
      speechRun = 0;
      onEvent("repeat");
      return;
    }
    wake(Buffer.concat(audio));
  };

  const classify = (): WindowClass => {
    const window = levels.slice(-windowFrames);
    if (!speechProbs) {
      return classifyWindow(window, thresholds);
    }
    return classifySpeechWindow(speechProbs.recent(speechWindowChunks), window, thresholds);
  };

  const classifyFrame = (frame: Buffer) => {
    frames.push(frame);
    levels.push(calculateMulawRms(frame));
    speechProbs?.push(frame);
    if (frames.length > prerollFrames) {
      frames.shift();
      levels.shift();
    }
    if (mode === "hold") {
      heldFrames += 1;
      checking?.audio.push(frame);
      settleCheck();
    }
    if (graceFrames > 0) {
      graceFrames -= 1;
    }
    if (pauseWaiters.length > 0) {
      for (const waiter of pauseWaiters) {
        waiter.framesLeft -= 1;
      }
      settlePauseWaiters(false);
    }
    sinceHop += 1;
    if (sinceHop < hopFrames || levels.length < windowFrames) {
      return;
    }
    sinceHop = 0;
    const kind = classify();
    const holdsLine = kind === "music" || (kind === "silence" && options.holdOnSilence === true);
    speechRun = kind === "speech" ? speechRun + 1 : 0;
    musicRun = holdsLine ? musicRun + 1 : 0;
    quietRun = kind === "speech" ? 0 : quietRun + 1;
    if (quietRun >= 1 && pauseWaiters.length > 0) {
      settlePauseWaiters(true);
    }
    if (ignoreSpeech && (quietRun >= 2 || ++ignoredHops >= 12)) {
      ignoreSpeech = false;
    }
    if (mode === "live" && musicRun >= holdHops) {
      enter("hold", "hold");
    } else if (mode === "hold" && speechRun >= speechHops && !checking && !ignoreSpeech) {
      // Only what the model did not hear: a hold the model asked for began moments ago.
      const preroll = Buffer.concat(frames.slice(-heldFrames));
      if (options.checkWake) {
        startCheck(options.checkWake, preroll);
      } else {
        wake(preroll);
      }
    } else if (mode === "probe" && quietRun >= reholdHops) {
      enter("hold", "rehold");
    }
  };

  const release = () => {
    const was = mode;
    if (was === "hold") {
      settleWaiters("release");
    }
    settlePauseWaiters(true);
    mode = "live";
    frames = [];
    levels = [];
    pending = Buffer.alloc(0);
    checking = undefined;
    checkGeneration += 1;
    ignoreSpeech = false;
    resetRuns();
    if (was !== "live") {
      onEvent("release");
    }
  };

  return {
    get mode(): HoldGateMode {
      return mode;
    },
    /**
     * Off: a person who cannot be missed is on the line (the owner joined), so the model hears
     * everything, music included. On again once they leave.
     */
    setEnabled(on: boolean): void {
      enabled = on;
      if (!on) {
        release();
      }
    },
    /** The assistant is speaking: a conversation is on, so neither hold nor probe applies. */
    noteAssistantSpeech(): void {
      if (graceFrames > 0) {
        return;
      }
      if (mode !== "live") {
        enter("live", "release");
      } else {
        musicRun = 0;
      }
    },
    /**
     * The model says it is on hold. Holding starts at once; its spoken acknowledgement, if any,
     * does not end the hold for `graceMs`.
     */
    holdNow(graceMs = 5_000): void {
      if (!enabled) {
        return;
      }
      graceFrames = Math.round(graceMs / 20);
      if (mode !== "hold") {
        enter("hold", "hold");
      }
      // The recording that prompted this is still playing: it must not wake the gate again.
      ignoreSpeech = true;
      ignoredHops = 0;
    },
    /**
     * After a wake: resolves once the speaker pauses (one quiet window) or after `maxMs`, so the
     * model hears a whole first sentence before it must judge person or recording.
     */
    whenSpeechPauses(maxMs = 6_000): Promise<void> {
      if (!enabled || mode !== "probe") {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        pauseWaiters.push({ resolve, framesLeft: Math.round(maxMs / 20) });
      });
    },
    /** Resolves when this hold ends: "speech" when someone speaks, "release" otherwise. */
    whenHoldEnds(): Promise<"speech" | "release"> {
      if (mode !== "hold") {
        return Promise.resolve("release");
      }
      return new Promise((resolve) => {
        holdWaiters.push(resolve);
      });
    },
    /**
     * Returns what the model should hear for this frame: the frame itself, silence of the same
     * length (or nothing) while holding, or, on the frame that ends a hold, the held-back audio.
     */
    accept(audio: Buffer): Buffer {
      if (!enabled) {
        return audio;
      }
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
      if (!holding) {
        return audio;
      }
      if (feedNothing && heldFrames > silenceTailFrames) {
        return Buffer.alloc(0);
      }
      return Buffer.alloc(audio.length, MULAW_SILENCE);
    },
  };
}

export type HoldGate = ReturnType<typeof createHoldGate>;
