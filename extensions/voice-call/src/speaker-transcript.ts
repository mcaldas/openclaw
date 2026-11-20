import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { classifyWindow } from "./hold-gate.js";

/** One recorded leg: channel 0 carries this person alone (the far end of a Twilio call leg). */
export type SpeakerLeg = { label: string; file: string; startedAt: number };

export type SpeechSegment = { start: number; end: number; music: boolean };

type Line = { at: number; label: string; text: string };

const FRAME_SECONDS = 0.02;
/** About -42 dBFS: phone speech sits at -15 to -40 dBFS, line noise near -60. */
const VOICED_RMS = 0.008;
const JOIN_GAP_SECONDS = 0.7;
const MIN_SEGMENT_SECONDS = 0.3;
const MAX_SEGMENT_SECONDS = 30;
const PAD_SECONDS = 0.2;
const NO_SPEECH = "[no speech]";

export const SPEAKER_TRANSCRIPT_PROMPT = `Transcribe the speech in this phone-call audio exactly as spoken, in its original language (often Hebrew or English). Output only the words. If the speech is not in English, add one more line that starts with "EN: " and gives an English translation. If there is no speech (music, tones, noise or silence), output exactly: ${NO_SPEECH}`;

/** Read one channel of a 16-bit PCM WAV, as Twilio serves two-channel call recordings. */
export function readWavChannel(
  wav: Buffer,
  channel: number,
): { samples: Int16Array; rate: number } {
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a WAV file");
  }
  let format: { channels: number; rate: number; bits: number } | undefined;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = {
        channels: wav.readUInt16LE(body + 2),
        rate: wav.readUInt32LE(body + 4),
        bits: wav.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!format || format.bits !== 16 || channel >= format.channels) {
        throw new Error("unsupported WAV layout");
      }
      const end = Math.min(wav.length, body + size);
      const frameBytes = format.channels * 2;
      const samples = new Int16Array(Math.floor((end - body) / frameBytes));
      for (let i = 0; i < samples.length; i += 1) {
        samples[i] = wav.readInt16LE(body + i * frameBytes + channel * 2);
      }
      return { samples, rate: format.rate };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

export function encodeWavMono(samples: Int16Array, rate: number): Buffer {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + samples.length * 2, 4);
  out.write("WAVEfmt ", 8, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i += 1) {
    out.writeInt16LE(samples[i] ?? 0, 44 + i * 2);
  }
  return out;
}

/**
 * Where someone speaks on a channel, by loudness, with sustained music marked so it is not sent
 * to the model. Timing comes from here, not from the model: model timestamps drifted by up to
 * 40 s over hold music in the lab.
 */
export function findSpeechSegments(samples: Int16Array, rate: number): SpeechSegment[] {
  const frame = Math.max(1, Math.round(rate * FRAME_SECONDS));
  const levels: number[] = [];
  for (let start = 0; start + frame <= samples.length; start += frame) {
    let sum = 0;
    for (let i = start; i < start + frame; i += 1) {
      const value = (samples[i] ?? 0) / 32_768;
      sum += value * value;
    }
    levels.push(Math.sqrt(sum / frame));
  }
  const runs: { from: number; to: number }[] = [];
  for (const [index, level] of levels.entries()) {
    if (level < VOICED_RMS) {
      continue;
    }
    const last = runs.at(-1);
    if (last && (index - last.to) * FRAME_SECONDS <= JOIN_GAP_SECONDS) {
      last.to = index + 1;
    } else {
      runs.push({ from: index, to: index + 1 });
    }
  }
  const total = levels.length * FRAME_SECONDS;
  const maxFrames = Math.round(MAX_SEGMENT_SECONDS / FRAME_SECONDS);
  const segments: SpeechSegment[] = [];
  for (const run of runs) {
    if ((run.to - run.from) * FRAME_SECONDS < MIN_SEGMENT_SECONDS) {
      continue;
    }
    for (const piece of splitByKind(levels, run.from, run.to)) {
      for (let from = piece.from; from < piece.to; from += maxFrames) {
        const to = Math.min(piece.to, from + maxFrames);
        segments.push({
          start: Math.max(0, from * FRAME_SECONDS - PAD_SECONDS),
          end: Math.min(total, to * FRAME_SECONDS + PAD_SECONDS),
          music: piece.music,
        });
      }
    }
  }
  return segments;
}

const BLOCK_FRAMES = 25;
const WINDOW_FRAMES = 75;
const MIN_PIECE_BLOCKS = 3;

/**
 * Hold music often runs straight into a person's voice with no pause. Label each half-second
 * by the 1.5 s window around it and cut where music turns to speech, so the speech keeps its own
 * start time. Pieces under 1.5 s join their neighbour; runs under 3 s are speech.
 */
function splitByKind(
  levels: readonly number[],
  from: number,
  to: number,
): { from: number; to: number; music: boolean }[] {
  if (to - from < 150) {
    return [{ from, to, music: false }];
  }
  const pieces: { from: number; to: number; music: boolean }[] = [];
  for (let block = from; block < to; block += BLOCK_FRAMES) {
    const windowFrom = Math.max(from, Math.min(block - BLOCK_FRAMES, to - WINDOW_FRAMES));
    const music =
      classifyWindow(levels.slice(windowFrom, windowFrom + WINDOW_FRAMES), {
        lowEnergyRatio: 0.25,
        silenceRms: 0.0056,
      }) === "music";
    const end = Math.min(to, block + BLOCK_FRAMES);
    const last = pieces.at(-1);
    if (last && last.music === music) {
      last.to = end;
    } else {
      pieces.push({ from: block, to: end, music });
    }
  }
  // A short piece is a misread (a song transition, a breath): it takes its neighbour's kind.
  const merged: typeof pieces = [];
  for (const piece of pieces) {
    const last = merged.at(-1);
    if (
      last &&
      (piece.to - piece.from < MIN_PIECE_BLOCKS * BLOCK_FRAMES || last.music === piece.music)
    ) {
      last.to = piece.to;
    } else {
      merged.push({ ...piece });
    }
  }
  const first = merged[0];
  const second = merged[1];
  if (first && second && first.to - first.from < MIN_PIECE_BLOCKS * BLOCK_FRAMES) {
    second.from = first.from;
    merged.shift();
  }
  return merged;
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

function parseModelText(raw: string | undefined): string | undefined {
  const text = raw?.trim();
  if (!text || text.includes(NO_SPEECH)) {
    return undefined;
  }
  const lines = text.split("\n").map((line) => line.trim());
  const english = lines
    .find((line) => line.startsWith("EN:"))
    ?.slice(3)
    .trim();
  const spoken = lines.filter((line) => line && !line.startsWith("EN:")).join(" ");
  if (!spoken) {
    return undefined;
  }
  return english ? `${spoken} _(${english})_` : spoken;
}

/**
 * A transcript with one line per utterance and who said it: each person from their own
 * recording channel, the assistant from its own text, merged by time.
 */
export async function buildSpeakerTranscript(params: {
  legs: SpeakerLeg[];
  assistant: { at: number; text: string }[];
  assistantLabel: string;
  transcribe: (file: string) => Promise<string | undefined>;
  workDir: string;
  maxSegments?: number;
  concurrency?: number;
  warn?: (message: string) => void;
}): Promise<string> {
  const maxSegments = params.maxSegments ?? 120;
  const origin = Math.min(...params.legs.map((leg) => leg.startedAt), Date.now());
  const lines: Line[] = params.assistant.map((entry) => ({
    at: entry.at,
    label: params.assistantLabel,
    text: entry.text,
  }));
  const jobs: { leg: SpeakerLeg; samples: Int16Array; rate: number; segment: SpeechSegment }[] = [];
  for (const leg of params.legs) {
    try {
      const { samples, rate } = readWavChannel(await fs.readFile(leg.file), 0);
      let inMusic = false;
      for (const segment of findSpeechSegments(samples, rate)) {
        if (segment.music) {
          if (!inMusic) {
            lines.push({
              at: leg.startedAt + segment.start * 1000,
              label: leg.label,
              text: "[hold music]",
            });
          }
        } else {
          jobs.push({ leg, samples, rate, segment });
        }
        inMusic = segment.music;
      }
    } catch (error) {
      params.warn?.(`speaker transcript skipped ${leg.label}: ${formatErrorMessage(error)}`);
    }
  }
  // In call order, so a long queue on one leg cannot crowd out the other leg's words.
  const at = (job: (typeof jobs)[number]) => job.leg.startedAt + job.segment.start * 1000;
  const todo = jobs.toSorted((a, b) => at(a) - at(b)).slice(0, maxSegments);
  if (jobs.length > maxSegments) {
    params.warn?.(
      `speaker transcript: ${jobs.length - maxSegments} late utterances not transcribed`,
    );
  }
  let heard = 0;
  let failed = 0;
  await fs.mkdir(params.workDir, { recursive: true, mode: 0o700 });
  try {
    let next = 0;
    const worker = async () => {
      for (let index = next++; index < todo.length; index = next++) {
        const job = todo[index];
        if (!job) {
          continue;
        }
        const { leg, samples, rate, segment } = job;
        const file = path.join(params.workDir, `segment-${index}.wav`);
        const slice = samples.subarray(
          Math.floor(segment.start * rate),
          Math.ceil(segment.end * rate),
        );
        await fs.writeFile(file, encodeWavMono(slice, rate), { mode: 0o600 });
        const text = parseModelText(
          await params.transcribe(file).catch((error: unknown) => {
            failed += 1;
            params.warn?.(`speaker transcript segment failed: ${formatErrorMessage(error)}`);
            return undefined;
          }),
        );
        heard += text ? 1 : 0;
        await fs.rm(file, { force: true });
        if (text) {
          lines.push({ at: leg.startedAt + segment.start * 1000, label: leg.label, text });
        }
      }
    };
    await Promise.all(Array.from({ length: params.concurrency ?? 3 }, worker));
  } finally {
    await fs.rm(params.workDir, { recursive: true, force: true });
  }
  // Nothing heard although people spoke (no audio model, or every request failed): an empty
  // result keeps the live transcript in the report instead of one with only the assistant.
  if (todo.length > 0 && heard === 0) {
    return "";
  }
  const body = lines
    .toSorted((a, b) => a.at - b.at)
    .map((line) => `[${clock((line.at - origin) / 1000)}] **${line.label}:** ${line.text}`);
  const missing = failed + jobs.length - todo.length;
  if (missing > 0) {
    body.push(`_${missing} utterance(s) could not be transcribed._`);
  }
  return body.join("\n");
}
