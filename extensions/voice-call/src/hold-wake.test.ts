import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAnnouncementMemory,
  createRoomHoldGate,
  holdWakeServices,
  resetTranscribeTimingForTest,
} from "./hold-wake.js";
import { phoneMenuResult } from "./phone-menu.js";
import type { SileroVad } from "./silero-vad.js";
import type { CallRecord } from "./types.js";

const ANNOUNCEMENT = "Your call is important to us. Please stay on the line and";
const AGENT = "Hi, thanks for holding, this is Dana from billing.";

function memory(texts: string[], ms: number) {
  let clock = 0;
  const transcribe = vi.fn(async () => {
    clock += ms;
    return texts.shift();
  });
  return {
    transcribe,
    memory: createAnnouncementMemory(
      transcribe,
      () => {},
      () => clock,
    ),
  };
}

afterEach(() => {
  resetTranscribeTimingForTest();
  delete holdWakeServices.vad;
  delete holdWakeServices.transcribe;
});

describe("createAnnouncementMemory", () => {
  it("wakes at once the first time, learns the announcement, then keeps its repeats on hold", async () => {
    const { memory: m } = memory([ANNOUNCEMENT, ANNOUNCEMENT, AGENT], 500);
    await expect(m.check(Buffer.alloc(8))).resolves.toBe("wake");
    await m.noteRecording();
    await expect(m.check(Buffer.alloc(8))).resolves.toBe("repeat");
    await expect(m.check(Buffer.alloc(8))).resolves.toBe("wake");
  });

  it("never makes a person wait on a slow transcription", async () => {
    const { memory: m, transcribe } = memory([ANNOUNCEMENT, ANNOUNCEMENT], 6_000);
    await m.check(Buffer.alloc(8));
    await m.noteRecording();
    await expect(m.check(Buffer.alloc(8))).resolves.toBe("wake");
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it("does not learn what the assistant answered", async () => {
    const { memory: m } = memory([AGENT, AGENT], 500);
    await m.check(Buffer.alloc(8));
    m.noteConversation();
    await m.noteRecording();
    await expect(m.check(Buffer.alloc(8))).resolves.toBe("wake");
  });
});

describe("createRoomHoldGate", () => {
  const call = (holdDetector?: "energy") =>
    ({
      callId: "c1",
      metadata: { room: { name: "oc-c1", ...(holdDetector && { holdDetector }) } },
    }) as unknown as CallRecord;
  const vad: SileroVad = { open: () => ({ push() {}, close() {} }) };

  it("uses Silero when it loaded, and the original gate otherwise or when configured", () => {
    expect(
      createRoomHoldGate(
        call(),
        () => {},
        () => {},
      ).detector,
    ).toBe("energy");
    holdWakeServices.vad = vad;
    expect(
      createRoomHoldGate(
        call(),
        () => {},
        () => {},
      ).detector,
    ).toBe("silero");
    expect(
      createRoomHoldGate(
        call("energy"),
        () => {},
        () => {},
      ).detector,
    ).toBe("energy");
  });

  it("turns the gate off when Silero fails mid-call, so the model hears the line", () => {
    let fail: ((error: unknown) => void) | undefined;
    holdWakeServices.vad = {
      open: (_onProb, onError) => {
        fail = onError;
        return { push() {}, close() {} };
      },
    };
    const room = createRoomHoldGate(
      call(),
      () => {},
      () => {},
    );
    room.gate.holdNow();
    expect(room.gate.mode).toBe("hold");
    fail?.(new Error("onnx"));
    expect(room.gate.mode).toBe("live");
    // The room turns holding back on when the owner leaves; a dead detector stays off.
    room.gate.setEnabled(true);
    room.gate.holdNow();
    expect(room.gate.mode).toBe("live");
    const audio = Buffer.alloc(160, 0x10);
    expect(room.gate.accept(audio)).toBe(audio);
  });
});

describe("phoneMenuResult", () => {
  it("holds on request and keeps every reply quiet", () => {
    const holdNow = vi.fn(() => true);
    expect(phoneMenuResult("hold", holdNow)).toMatchObject({
      ok: true,
      note: expect.stringMatching(/^On hold/u),
    });
    expect(holdNow).toHaveBeenCalledOnce();
    expect(phoneMenuResult("hold", undefined)).toMatchObject({
      note: "Say nothing and keep listening.",
    });
    expect(phoneMenuResult("stuck", holdNow)).toMatchObject({
      ok: true,
      note: expect.stringContaining("operator"),
    });
    expect(phoneMenuResult("done", holdNow)).toHaveProperty("error");
  });
});
