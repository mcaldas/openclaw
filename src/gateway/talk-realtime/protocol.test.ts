import { describe, expect, it } from "vitest";
import {
  decodeClientFrame,
  encodeServerEvent,
  TALK_REALTIME_AUDIO,
  TALK_REALTIME_CLOSE,
  TALK_REALTIME_WS_PATH,
} from "./protocol.js";

describe("TALK_REALTIME_* constants", () => {
  it("advertises pcm16 24 kHz mono audio", () => {
    expect(TALK_REALTIME_AUDIO).toEqual({
      sampleRateHz: 24_000,
      format: "pcm16",
      channels: 1,
    });
  });

  it("pins the WS path clients and the HTTP upgrade handler agree on", () => {
    expect(TALK_REALTIME_WS_PATH).toBe("/talk/realtime");
  });

  it("uses 4xxx application close codes so they do not collide with protocol codes", () => {
    for (const value of Object.values(TALK_REALTIME_CLOSE)) {
      expect(value).toBeGreaterThanOrEqual(4000);
      expect(value).toBeLessThan(5000);
    }
  });
});

describe("decodeClientFrame", () => {
  it("accepts a well-formed input_audio_buffer.append", () => {
    const decoded = decodeClientFrame(
      JSON.stringify({ type: "input_audio_buffer.append", audio: "AAAA" }),
    );
    expect(decoded).toEqual({ type: "input_audio_buffer.append", audio: "AAAA" });
  });

  it("flags a missing audio field on append", () => {
    const decoded = decodeClientFrame(JSON.stringify({ type: "input_audio_buffer.append" }));
    expect(decoded).toEqual({ error: "append missing audio" });
  });

  it("accepts session.end with a known reason", () => {
    const decoded = decodeClientFrame(
      JSON.stringify({ type: "session.end", reason: "app_background" }),
    );
    expect(decoded).toEqual({ type: "session.end", reason: "app_background" });
  });

  it("defaults unknown session.end reasons to user_cancel", () => {
    const decoded = decodeClientFrame(
      JSON.stringify({ type: "session.end", reason: "weird_value" }),
    );
    expect(decoded).toEqual({ type: "session.end", reason: "user_cancel" });
  });

  it("rejects non-string input", () => {
    expect(decodeClientFrame(42)).toEqual({ error: "frame not a string" });
  });

  it("rejects empty string", () => {
    expect(decodeClientFrame("")).toEqual({ error: "frame not a string" });
  });

  it("rejects non-JSON", () => {
    expect(decodeClientFrame("not json at all")).toEqual({ error: "frame not json" });
  });

  it("rejects JSON that is not an object", () => {
    expect(decodeClientFrame("[]")).toBeNull();
    expect(decodeClientFrame("42")).toBeNull();
  });

  it("rejects unknown event types with a descriptive error", () => {
    const decoded = decodeClientFrame(JSON.stringify({ type: "session.pause" }));
    expect(decoded).toEqual({ error: "unknown client event: session.pause" });
  });

  it("rejects frames larger than 2MB to protect the bridge from misuse", () => {
    const big = "x".repeat(2_000_001);
    expect(decodeClientFrame(big)).toEqual({ error: "frame too large" });
  });
});

describe("encodeServerEvent", () => {
  it("round-trips through JSON.parse", () => {
    const ev = {
      type: "session.ready",
      voiceRunId: "abc",
      sessionKey: "agent:main:default",
      audio: TALK_REALTIME_AUDIO,
    } as const;
    const text = encodeServerEvent(ev);
    expect(JSON.parse(text)).toEqual(ev);
  });

  it("encodes close events with the right close code shape", () => {
    const text = encodeServerEvent({
      type: "closed",
      reason: "replaced_by_newer",
      code: TALK_REALTIME_CLOSE.REPLACED_BY_NEWER,
    });
    expect(JSON.parse(text)).toEqual({
      type: "closed",
      reason: "replaced_by_newer",
      code: 4010,
    });
  });
});
