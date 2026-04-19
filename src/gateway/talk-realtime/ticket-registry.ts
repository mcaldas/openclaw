import { randomBytes } from "node:crypto";

/**
 * In-memory ticket registry for `/talk/realtime` upgrades.
 *
 * Tickets are opaque strings issued by `talk.realtime.start` and redeemed
 * by the `/talk/realtime` upgrade handler. Properties we care about:
 *
 * - Single-use: redeeming a ticket consumes it.
 * - Short-lived: tickets expire after `ttlMs` (default 60 s) and expired
 *   tickets are pruned lazily on reads and on `sweep()`.
 * - Bound to an agent + voice-run id: the registry is the source of truth
 *   for what agent the upgrade is for, so the WS handler does not trust
 *   untrusted query params beyond the ticket string.
 *
 * The ticket string itself is 32 bytes of base64url randomness. The
 * originating operator connect id is stored on the ticket for logging
 * and diagnostics, but it is NOT checked at redeem time: the gateway
 * does not expose its internal `connId` to clients, so iOS cannot
 * supply it on the WS upgrade. Security rests on ticket secrecy + TTL
 * + single-use semantics, which is sufficient for this threat model
 * (operator is already authenticated at `talk.realtime.start`-issue
 * time, and leaked tickets expire in 60 s).
 */
export type TalkRealtimeTicket = {
  ticket: string;
  voiceRunId: string;
  agentId: string;
  operatorConnId: string;
  sessionKey: string;
  issuedAtMs: number;
  expiresAtMs: number;
};

export type TalkRealtimeTicketInput = Omit<
  TalkRealtimeTicket,
  "ticket" | "issuedAtMs" | "expiresAtMs"
>;

export type RedeemResult =
  | { ok: true; ticket: TalkRealtimeTicket }
  | {
      ok: false;
      reason: "unknown" | "expired" | "consumed";
    };

export type TalkRealtimeTicketRegistryOptions = {
  /** Ticket TTL in milliseconds. Defaults to 60_000. */
  ttlMs?: number;
  /** Injected clock for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Injected random-bytes factory. Defaults to node:crypto `randomBytes`. */
  randomBytesFn?: (n: number) => Buffer;
};

export class TalkRealtimeTicketRegistry {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly randomBytesFn: (n: number) => Buffer;
  private readonly entries = new Map<string, TalkRealtimeTicket>();

  constructor(opts: TalkRealtimeTicketRegistryOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    this.randomBytesFn = opts.randomBytesFn ?? randomBytes;
  }

  /**
   * Mint a new single-use ticket bound to the given voice-run context.
   */
  issue(input: TalkRealtimeTicketInput): TalkRealtimeTicket {
    const issuedAtMs = this.now();
    const expiresAtMs = issuedAtMs + this.ttlMs;
    const ticketBytes = this.randomBytesFn(32);
    const ticket = ticketBytes.toString("base64url");
    const entry: TalkRealtimeTicket = {
      ...input,
      ticket,
      issuedAtMs,
      expiresAtMs,
    };
    this.entries.set(ticket, entry);
    return entry;
  }

  /**
   * Redeem a ticket. Consumes the ticket on success; expired tickets
   * are dropped from the registry so a retry cannot succeed. Unknown
   * tickets leave the registry untouched.
   */
  redeem(ticket: string): RedeemResult {
    const entry = this.entries.get(ticket);
    if (!entry) {
      return { ok: false, reason: "unknown" };
    }
    const now = this.now();
    if (now >= entry.expiresAtMs) {
      this.entries.delete(ticket);
      return { ok: false, reason: "expired" };
    }
    this.entries.delete(ticket);
    return { ok: true, ticket: entry };
  }

  /** Best-effort peek for diagnostics (no side effects). */
  peek(ticket: string): TalkRealtimeTicket | undefined {
    const entry = this.entries.get(ticket);
    if (!entry) {
      return undefined;
    }
    if (this.now() >= entry.expiresAtMs) {
      return undefined;
    }
    return entry;
  }

  /** Evict expired tickets. Safe to call on a timer or opportunistically. */
  sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAtMs) {
        this.entries.delete(key);
      }
    }
  }

  /** Testing helper. Not part of the external surface. */
  _size(): number {
    return this.entries.size;
  }
}
