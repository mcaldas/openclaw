/**
 * Thin client<->gateway event protocol for the realtime voice WS at
 * `/talk/realtime`. Intentionally a subset of the OpenAI realtime event
 * shapes so an iOS adapter can map between them with a small lookup while
 * the gateway keeps tool dispatch, memory injection, and history hydration
 * invisible to the client.
 *
 * See docs/voice/gateway-realtime-bridge.md.
 */

export const TALK_REALTIME_WS_PATH = "/talk/realtime";

/**
 * Close codes used by the gateway when it terminates a realtime WS. We
 * deliberately pick codes in the 4000-4999 application-private range so
 * they do not collide with WebSocket protocol-level close codes.
 *
 * 4001 `ticket_invalid`     - ticket missing, wrong shape, or unknown.
 * 4002 `ticket_expired`     - ticket was issued but its TTL elapsed.
 * 4003 `ticket_consumed`    - single-use ticket was already redeemed.
 * 4010 `replaced_by_newer`  - a newer `talk.realtime.start` evicted this run.
 * 4011 `bridge_error`       - provider bridge raised an infrastructure error.
 * 4020 `session_ended`      - normal client-initiated end.
 * 4030 `provider_closed`    - upstream provider closed the realtime WS.
 */
export const TALK_REALTIME_CLOSE = {
  TICKET_INVALID: 4001,
  TICKET_EXPIRED: 4002,
  TICKET_CONSUMED: 4003,
  REPLACED_BY_NEWER: 4010,
  BRIDGE_ERROR: 4011,
  SESSION_ENDED: 4020,
  PROVIDER_CLOSED: 4030,
} as const;

export type TalkRealtimeCloseCode = (typeof TALK_REALTIME_CLOSE)[keyof typeof TALK_REALTIME_CLOSE];

/**
 * Audio wire format the gateway advertises to iOS. Kept as a const so
 * iOS-side tests and the Swift adapter can assert against a single source
 * of truth.
 */
export const TALK_REALTIME_AUDIO = {
  sampleRateHz: 24_000,
  format: "pcm16" as const,
  channels: 1 as const,
} satisfies TalkRealtimeAudio;

export type TalkRealtimeAudio = {
  sampleRateHz: number;
  format: "pcm16";
  channels: number;
};

/** Events iOS -> gateway. */
export type TalkRealtimeClientEvent =
  | { type: "input_audio_buffer.append"; audio: string }
  | { type: "input_audio_buffer.commit" }
  | { type: "response.cancel" }
  | { type: "session.end"; reason: "user_cancel" | "app_background" }
  | { type: "ping"; ts: number };

/** Events gateway -> iOS. */
export type TalkRealtimeServerEvent =
  | {
      type: "session.ready";
      voiceRunId: string;
      sessionKey: string;
      audio: TalkRealtimeAudio;
    }
  | { type: "response.audio.delta"; audio: string }
  | { type: "response.audio.done"; itemId?: string }
  | {
      type: "conversation.item.input_audio_transcription.partial";
      text: string;
    }
  | {
      type: "conversation.item.input_audio_transcription.final";
      text: string;
    }
  | { type: "response.output_text.delta"; text: string }
  | { type: "response.output_text.done"; text: string }
  | { type: "response.tool_call.started"; callId: string; name: string }
  | {
      type: "response.tool_call.finished";
      callId: string;
      name: string;
      durationMs: number;
      ok: boolean;
    }
  | { type: "fallback.activated"; from: string; to: string; reason: string }
  | { type: "error"; code: string; message: string; recoverable: boolean }
  | { type: "closed"; reason: string; code: TalkRealtimeCloseCode }
  | { type: "ping"; ts: number };

/**
 * Decode an incoming client frame. Returns the event on success; returns
 * `null` for non-object JSON; returns `{ error: ... }` for structurally
 * invalid frames so the caller can close the WS cleanly.
 */
export function decodeClientFrame(
  raw: unknown,
): TalkRealtimeClientEvent | { error: string } | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return { error: "frame not a string" };
  }
  if (raw.length > 2_000_000) {
    // Single frames are pcm16 audio chunks capped well below this; anything
    // larger is almost certainly a misuse of the transport.
    return { error: "frame too large" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "frame not json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const ev = parsed as Record<string, unknown>;
  const type = typeof ev.type === "string" ? ev.type : null;
  switch (type) {
    case "input_audio_buffer.append":
      if (typeof ev.audio === "string") {
        return { type, audio: ev.audio };
      }
      return { error: "append missing audio" };
    case "input_audio_buffer.commit":
      return { type };
    case "response.cancel":
      return { type };
    case "session.end": {
      const reason =
        ev.reason === "user_cancel" || ev.reason === "app_background" ? ev.reason : "user_cancel";
      return { type, reason };
    }
    case "ping":
      return { type, ts: typeof ev.ts === "number" ? ev.ts : Date.now() };
    default:
      return { error: `unknown client event: ${type ?? "null"}` };
  }
}

/** Encode a server event to the WS wire format. */
export function encodeServerEvent(event: TalkRealtimeServerEvent): string {
  return JSON.stringify(event);
}
