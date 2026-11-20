import { pcmToMulaw } from "openclaw/plugin-sdk/realtime-voice-provider";

const SAMPLE_RATE = 8_000;
const TONE_MS = 160;
const GAP_MS = 80;
// Twilio's <Play digits> treats "w" as a half-second wait; the other accepted pause marks match it.
const PAUSE_MS = 500;
// Bounds one request well inside the pacer's 120 s queue and the CLI's 30 s gateway wait.
const MAX_PLAYOUT_MS = 20_000;
// 16-bit peak of a 0 dBm0 sine in G.711 mu-law (full scale is +3.17 dBm0).
const DBM0_PEAK = 22_656;
// Low group at -7 dBm0, high group 2 dB hotter: inside common receiver level and twist windows.
const LOW_PEAK = DBM0_PEAK * 10 ** (-7 / 20);
const HIGH_PEAK = DBM0_PEAK * 10 ** (-5 / 20);

const ROW_HZ = [697, 770, 852, 941] as const;
const COLUMN_HZ = [1209, 1336, 1477, 1633] as const;
const KEYPAD = ["123A", "456B", "789C", "*0#D"] as const;

/** Keys and pause marks the in-band generator can play. */
export const IN_BAND_DTMF_PATTERN = /^[0-9*#A-Da-dwWpP,]+$/;

function samples(ms: number): number {
  return (SAMPLE_RATE * ms) / 1000;
}

function findKey(key: string): { lowHz: number; highHz: number } | undefined {
  for (const [row, keys] of KEYPAD.entries()) {
    const column = keys.indexOf(key);
    if (column >= 0) {
      return { lowHz: ROW_HZ[row] ?? 0, highHz: COLUMN_HZ[column] ?? 0 };
    }
  }
  return undefined;
}

/**
 * Render keypad digits as 8 kHz G.711 mu-law audio: 160 ms dual tone and 80 ms silence per key,
 * 500 ms silence per pause mark (w, W, p, P or comma).
 */
export function encodeDtmfMulaw(digits: string): Buffer {
  if (!IN_BAND_DTMF_PATTERN.test(digits)) {
    throw new Error("digits may only contain 0-9, *, #, A-D, and the pause marks w, p, comma");
  }
  const keys = digits.toUpperCase().split("");
  const playoutMs = keys.reduce(
    (ms, char) => ms + (findKey(char) ? TONE_MS + GAP_MS : PAUSE_MS),
    0,
  );
  if (playoutMs > MAX_PLAYOUT_MS) {
    throw new Error(
      `digits would play for ${playoutMs} ms; send at most ${MAX_PLAYOUT_MS} ms at a time`,
    );
  }
  const parts: Buffer[] = [];
  for (const char of keys) {
    const key = findKey(char);
    if (!key) {
      parts.push(Buffer.alloc(samples(PAUSE_MS) * 2));
      continue;
    }
    const tone = Buffer.alloc((samples(TONE_MS) + samples(GAP_MS)) * 2);
    for (let i = 0; i < samples(TONE_MS); i += 1) {
      const t = i / SAMPLE_RATE;
      const value =
        LOW_PEAK * Math.sin(2 * Math.PI * key.lowHz * t) +
        HIGH_PEAK * Math.sin(2 * Math.PI * key.highHz * t);
      tone.writeInt16LE(Math.round(value), i * 2);
    }
    parts.push(tone);
  }
  return pcmToMulaw(Buffer.concat(parts));
}
