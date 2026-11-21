import { describe, expect, it, vi } from "vitest";
import {
  isMulawSilence,
  isPcm16Silence,
  parsePcmSampleRate,
  sendGoogleLiveContext,
} from "./realtime-voice-session-io.js";

describe("sendGoogleLiveContext", () => {
  it("sends client content that does not complete the turn, only on a ready session", () => {
    const session = { sendClientContent: vi.fn() };
    expect(sendGoogleLiveContext(session, " [Mathias is speaking now.] ", true)).toBe(true);
    expect(session.sendClientContent).toHaveBeenCalledWith({
      turns: [{ role: "user", parts: [{ text: "[Mathias is speaking now.]" }] }],
      turnComplete: false,
    });
    expect(sendGoogleLiveContext(session, "  ", true)).toBe(false);
    expect(sendGoogleLiveContext(session, "[note]", false)).toBe(false);
    expect(sendGoogleLiveContext(null, "[note]", true)).toBe(false);
    expect(session.sendClientContent).toHaveBeenCalledTimes(1);
  });
});

describe("Google Live audio helpers", () => {
  it("reads PCM rates and detects silence in both encodings", () => {
    expect(parsePcmSampleRate("audio/pcm;rate=16000")).toBe(16_000);
    expect(parsePcmSampleRate(undefined)).toBe(24_000);
    expect(isMulawSilence(Buffer.alloc(4, 0xff))).toBe(true);
    expect(isMulawSilence(Buffer.from([0xff, 0x7f]))).toBe(false);
    expect(isPcm16Silence(Buffer.alloc(4))).toBe(true);
    expect(isPcm16Silence(Buffer.from([0, 1]))).toBe(false);
  });
});
