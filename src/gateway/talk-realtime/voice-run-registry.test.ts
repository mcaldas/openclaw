import { describe, expect, it, vi } from "vitest";
import { VoiceRunRegistry, type VoiceRunHandle } from "./voice-run-registry.js";

function makeHandle(overrides: Partial<VoiceRunHandle> = {}): VoiceRunHandle {
  return {
    voiceRunId: "run-1",
    agentId: "main",
    operatorConnId: "conn-1",
    startedAtMs: Date.now(),
    evict: vi.fn(),
    ...overrides,
  };
}

describe("VoiceRunRegistry", () => {
  it("register stores a new handle", () => {
    const registry = new VoiceRunRegistry();
    const handle = makeHandle();
    const result = registry.register(handle);
    expect(result.previous).toBeNull();
    expect(registry.getByAgent("main")).toBe(handle);
    expect(registry.getByRunId("run-1")).toBe(handle);
  });

  it("register evicts the prior run for the same agent with replaced_by_newer", () => {
    const registry = new VoiceRunRegistry();
    const first = makeHandle({ voiceRunId: "run-1" });
    const second = makeHandle({ voiceRunId: "run-2" });
    registry.register(first);
    const result = registry.register(second);
    expect(result.previous).toBe(first);
    expect(first.evict).toHaveBeenCalledWith("replaced_by_newer");
    expect(registry.getByAgent("main")).toBe(second);
    expect(registry.getByRunId("run-1")).toBeUndefined();
    expect(registry.getByRunId("run-2")).toBe(second);
  });

  it("register does not evict a run for a different agent", () => {
    const registry = new VoiceRunRegistry();
    const a = makeHandle({ voiceRunId: "run-a", agentId: "agent-a" });
    const b = makeHandle({ voiceRunId: "run-b", agentId: "agent-b" });
    registry.register(a);
    registry.register(b);
    expect(a.evict).not.toHaveBeenCalled();
    expect(registry.getByAgent("agent-a")).toBe(a);
    expect(registry.getByAgent("agent-b")).toBe(b);
  });

  it("unregister removes a run without invoking evict", () => {
    const registry = new VoiceRunRegistry();
    const handle = makeHandle();
    registry.register(handle);
    registry.unregister(handle.voiceRunId);
    expect(handle.evict).not.toHaveBeenCalled();
    expect(registry.getByAgent("main")).toBeUndefined();
    expect(registry.getByRunId("run-1")).toBeUndefined();
  });

  it("unregister is a no-op on unknown runs", () => {
    const registry = new VoiceRunRegistry();
    expect(() => registry.unregister("unknown")).not.toThrow();
  });

  it("unregister does not evict a newer run that replaced the old one", () => {
    const registry = new VoiceRunRegistry();
    const first = makeHandle({ voiceRunId: "run-1" });
    const second = makeHandle({ voiceRunId: "run-2" });
    registry.register(first);
    registry.register(second);
    // First is already evicted by the newer registration; calling
    // unregister("run-1") must not also strip the newer handle.
    registry.unregister(first.voiceRunId);
    expect(registry.getByAgent("main")).toBe(second);
    expect(registry.getByRunId("run-2")).toBe(second);
  });

  it("swallows throws from eviction handlers", () => {
    const registry = new VoiceRunRegistry();
    const throwing = makeHandle({
      voiceRunId: "run-1",
      evict: vi.fn(() => {
        throw new Error("boom");
      }),
    });
    const newer = makeHandle({ voiceRunId: "run-2" });
    registry.register(throwing);
    expect(() => registry.register(newer)).not.toThrow();
    expect(registry.getByAgent("main")).toBe(newer);
  });
});
