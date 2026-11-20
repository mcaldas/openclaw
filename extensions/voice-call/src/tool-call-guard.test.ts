import { describe, expect, it, vi } from "vitest";
import { createToolCallGuard } from "./tool-call-guard.js";

describe("createToolCallGuard", () => {
  it("lets normal use through and stops a loop once, per call", () => {
    let clock = 0;
    const onLoop = vi.fn();
    const guard = createToolCallGuard({ maxPerMinute: 3, now: () => clock, onLoop });
    expect([1, 2, 3].map(() => guard.note("a"))).toEqual([true, true, true]);
    expect(guard.note("b")).toBe(true); // another call has its own count
    expect(guard.note("a")).toBe(false);
    expect(guard.note("a")).toBe(false);
    expect(onLoop).toHaveBeenCalledTimes(1);
    expect(onLoop).toHaveBeenCalledWith("a", 4);
    clock += 61_000; // a quiet minute later the count is fresh
    expect(guard.note("a")).toBe(true);
  });
});
