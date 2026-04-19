import { describe, expect, it } from "vitest";
import { TalkRealtimeTicketRegistry } from "./ticket-registry.js";

function makeRegistry(
  opts: {
    nowSeed?: number;
    ttlMs?: number;
    fixedBytes?: Buffer[];
  } = {},
) {
  let clock = opts.nowSeed ?? 1_000_000;
  const bytesQueue = [...(opts.fixedBytes ?? [])];
  const registry = new TalkRealtimeTicketRegistry({
    ttlMs: opts.ttlMs,
    now: () => clock,
    randomBytesFn: (n) => {
      if (bytesQueue.length > 0) {
        const next = bytesQueue.shift();
        if (next) {
          return next.subarray(0, n);
        }
      }
      return Buffer.alloc(n, 7);
    },
  });
  return {
    registry,
    advance(ms: number) {
      clock += ms;
    },
    setNow(ms: number) {
      clock = ms;
    },
  };
}

describe("TalkRealtimeTicketRegistry", () => {
  it("issues a ticket with a base64url string and expected expiry", () => {
    const { registry } = makeRegistry({ ttlMs: 60_000, nowSeed: 1_000 });
    const ticket = registry.issue({
      voiceRunId: "run-1",
      agentId: "main",
      operatorConnId: "conn-1",
      sessionKey: "agent:main:default",
    });
    expect(ticket.ticket).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(ticket.expiresAtMs).toBe(ticket.issuedAtMs + 60_000);
    expect(ticket.issuedAtMs).toBe(1_000);
  });

  it("redeems exactly once", () => {
    const { registry } = makeRegistry();
    const issued = registry.issue({
      voiceRunId: "run-1",
      agentId: "main",
      operatorConnId: "conn-1",
      sessionKey: "agent:main:default",
    });
    const first = registry.redeem(issued.ticket);
    expect(first.ok).toBe(true);
    const second = registry.redeem(issued.ticket);
    expect(second).toEqual({ ok: false, reason: "unknown" });
  });

  it("rejects a ticket redeemed after its TTL expires", () => {
    const ctx = makeRegistry({ ttlMs: 5_000 });
    const issued = ctx.registry.issue({
      voiceRunId: "run-1",
      agentId: "main",
      operatorConnId: "conn-1",
      sessionKey: "agent:main:default",
    });
    ctx.advance(5_001);
    const result = ctx.registry.redeem(issued.ticket);
    expect(result).toEqual({ ok: false, reason: "expired" });
    // Subsequent redemptions observe unknown because expired entries are
    // pruned lazily.
    expect(ctx.registry.redeem(issued.ticket)).toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  it("sweep() evicts expired tickets", () => {
    const ctx = makeRegistry({
      ttlMs: 1_000,
      fixedBytes: [Buffer.alloc(32, 1), Buffer.alloc(32, 2)],
    });
    ctx.registry.issue({
      voiceRunId: "r1",
      agentId: "a",
      operatorConnId: "c",
      sessionKey: "s1",
    });
    ctx.registry.issue({
      voiceRunId: "r2",
      agentId: "a",
      operatorConnId: "c",
      sessionKey: "s2",
    });
    expect(ctx.registry._size()).toBe(2);
    ctx.advance(1_500);
    ctx.registry.sweep();
    expect(ctx.registry._size()).toBe(0);
  });

  it("peek does not consume a ticket", () => {
    const { registry } = makeRegistry();
    const issued = registry.issue({
      voiceRunId: "run-1",
      agentId: "main",
      operatorConnId: "conn-1",
      sessionKey: "agent:main:default",
    });
    expect(registry.peek(issued.ticket)).toBeDefined();
    expect(registry.peek(issued.ticket)).toBeDefined();
    const redeemed = registry.redeem(issued.ticket);
    expect(redeemed.ok).toBe(true);
  });
});
