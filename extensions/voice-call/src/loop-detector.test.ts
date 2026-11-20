import { describe, expect, it } from "vitest";
import { createLoopDetector } from "./loop-detector.js";

const ANNOUNCEMENT = "Your call is important to us. Please stay on the line and";

describe("createLoopDetector", () => {
  it("scores a repeated announcement as a repeat and a live agent as new", () => {
    const detector = createLoopDetector();
    detector.addChunk(ANNOUNCEMENT);
    expect(
      detector.similarity("Your call is important to us. Please stay on the line"),
    ).toBeGreaterThan(0.85);
    expect(detector.isRepeat("Hi, thanks for holding, this is Dana from billing.")).toBe(false);
  });

  it("tokenises Hebrew", () => {
    const detector = createLoopDetector();
    detector.addChunk("שיחתך חשובה לנו, אנא המתן על הקו, הנ");
    expect(detector.isRepeat("שיחתך חשובה לנו, אנא המתן על הקו, ה")).toBe(true);
    expect(detector.isRepeat("שלום, תודה שהמתנת, מדברת דנה ממחלק")).toBe(false);
  });

  it("flags a loop after three similar chunks in a row, like LiveKit", () => {
    const detector = createLoopDetector();
    const results = [ANNOUNCEMENT, ANNOUNCEMENT, ANNOUNCEMENT, ANNOUNCEMENT].map((chunk) => {
      detector.addChunk(chunk);
      return detector.checkLoopDetection();
    });
    expect(results).toEqual([false, false, false, true]);
    detector.addChunk("press one for billing");
    expect(detector.checkLoopDetection()).toBe(false);
    detector.reset();
    expect(detector.similarity(ANNOUNCEMENT)).toBe(0);
  });

  it("ignores chunks without words", () => {
    const detector = createLoopDetector();
    detector.addChunk("...");
    detector.addChunk("!");
    expect(detector.checkLoopDetection()).toBe(false);
    expect(() => createLoopDetector({ windowSize: 0 })).toThrow();
  });
});
