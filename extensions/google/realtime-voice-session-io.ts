import type { Session } from "@google/genai";

/** Audio and content helpers for a Google Live session, kept apart from the bridge class. */

export function parsePcmSampleRate(mimeType: string | undefined): number {
  const match = mimeType?.match(/(?:^|[;,\s])rate=(\d+)/i);
  const parsed = match ? Number.parseInt(match[1] ?? "", 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24_000;
}

export function isMulawSilence(audio: Buffer): boolean {
  return audio.length > 0 && audio.every((sample) => sample === 0xff);
}

export function isPcm16Silence(audio: Buffer): boolean {
  const samples = Math.floor(audio.length / 2);
  if (samples === 0) {
    return false;
  }
  for (let i = 0; i < samples; i += 1) {
    if (audio.readInt16LE(i * 2) !== 0) {
      return false;
    }
  }
  return true;
}

/** Client content with turnComplete false: the model reads it with its next turn, never answers it. */
export function sendGoogleLiveContext(
  session: Pick<Session, "sendClientContent"> | null,
  text: string,
  ready: boolean,
): boolean {
  const normalized = text.trim();
  if (!normalized || !session || !ready) {
    return false;
  }
  session.sendClientContent({
    turns: [{ role: "user", parts: [{ text: normalized }] }],
    turnComplete: false,
  });
  return true;
}
