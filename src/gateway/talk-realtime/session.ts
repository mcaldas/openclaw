import type { WebSocket } from "ws";
import type { RealtimeVoiceBridge } from "../../realtime-voice/provider-types.js";
import {
  decodeClientFrame,
  encodeServerEvent,
  TALK_REALTIME_AUDIO,
  TALK_REALTIME_CLOSE,
  type TalkRealtimeCloseCode,
  type TalkRealtimeServerEvent,
} from "./protocol.js";
import type { TalkRealtimeTicket } from "./ticket-registry.js";
import type { VoiceRunEvictReason } from "./voice-run-registry.js";

/**
 * Owns a single realtime voice run: the authenticated iOS WS on one side,
 * the realtime provider bridge on the other, and the event plumbing in
 * between. Intentionally provider-agnostic: the bridge is supplied by the
 * caller so we can unit-test with a fake bridge and swap providers without
 * touching this module.
 *
 * Commit 2 scope: pipe audio and transcripts. Tool-call dispatch, system
 * prompt composition, and memory injection land in commits 3 and 4.
 */

export type TalkRealtimeSessionDeps = {
  /**
   * The authenticated iOS WebSocket. The session sends server events on
   * this socket and consumes client events from it.
   */
  clientWs: WebSocket;
  /**
   * The provider bridge. Already constructed by the caller with the right
   * provider config, instructions, tools, and callbacks. The caller wires
   * the bridge callbacks to the corresponding session hooks (forward audio
   * to client, forward transcripts, etc.) BEFORE `createTalkRealtimeSession`.
   *
   * Note: because the provider SDK requires callbacks at construct time,
   * this module exposes a factory helper (`connectSessionToBridge`) that
   * the caller uses to wire bridge -> session events once both are built.
   */
  bridge: RealtimeVoiceBridge;
  /** The redeemed ticket this run was authorized from. */
  ticket: TalkRealtimeTicket;
  /** Injected clock for deterministic tests. */
  now?: () => number;
  /** Optional: called when the session is fully torn down. */
  onClosed?: (reason: VoiceRunEvictReason) => void;
};

export type TalkRealtimeSession = {
  readonly voiceRunId: string;
  readonly sessionKey: string;
  /**
   * Send a server-originated event to the client. No-op when the WS is
   * not OPEN.
   */
  sendServerEvent(event: TalkRealtimeServerEvent): void;
  /**
   * Close the session with the given reason and close code. Idempotent;
   * safe to call from both the eviction path and the bridge-error path.
   */
  close(reason: VoiceRunEvictReason, code?: TalkRealtimeCloseCode): void;
  /**
   * Feed a raw client frame (usually from `clientWs.on("message")`) into
   * the session. The session decodes it and either forwards to the bridge
   * or handles it locally. Unknown frames are dropped with an `error`
   * event sent back to the client.
   */
  handleClientFrame(raw: string | Buffer): void;
  /**
   * Feed an assistant-audio chunk from the bridge into the session.
   */
  handleAssistantAudio(audio: Buffer): void;
  /**
   * Feed a transcript event from the bridge into the session.
   */
  handleTranscript(role: "user" | "assistant", text: string, isFinal: boolean): void;
  /**
   * Emit a clear-audio directive (barge-in) to the client.
   */
  handleClearAudio(): void;
};

export function createTalkRealtimeSession(deps: TalkRealtimeSessionDeps): TalkRealtimeSession {
  const { clientWs, bridge, ticket, onClosed } = deps;
  let closed = false;

  const send = (event: TalkRealtimeServerEvent): void => {
    // ws.OPEN is 1; avoid the runtime import in hot path.
    if (clientWs.readyState !== 1) {
      return;
    }
    try {
      clientWs.send(encodeServerEvent(event));
    } catch {
      // Network errors race with close; dropping the frame is correct. The
      // subsequent `close` event on the socket will drive teardown.
    }
  };

  const close = (reason: VoiceRunEvictReason, code?: TalkRealtimeCloseCode): void => {
    if (closed) {
      return;
    }
    closed = true;
    const closeCode = code ?? closeCodeForReason(reason);
    send({ type: "closed", reason, code: closeCode });
    try {
      bridge.close();
    } catch {
      // bridge.close is best-effort.
    }
    try {
      if (clientWs.readyState === 1 /* OPEN */ || clientWs.readyState === 0 /* CONNECTING */) {
        clientWs.close(closeCode, reason);
      }
    } catch {
      // Ignore socket already-closed races.
    }
    try {
      onClosed?.(reason);
    } catch {
      // User hook must not break teardown.
    }
  };

  const handleClientFrame = (raw: string | Buffer): void => {
    if (closed) {
      return;
    }
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    const decoded = decodeClientFrame(text);
    if (decoded === null) {
      return;
    }
    if ("error" in decoded) {
      send({
        type: "error",
        code: "invalid_frame",
        message: decoded.error,
        recoverable: true,
      });
      return;
    }
    switch (decoded.type) {
      case "input_audio_buffer.append":
        try {
          const audio = Buffer.from(decoded.audio, "base64");
          bridge.sendAudio(audio);
        } catch (err) {
          send({
            type: "error",
            code: "audio_decode_failed",
            message: err instanceof Error ? err.message : "audio decode failed",
            recoverable: true,
          });
        }
        return;
      case "input_audio_buffer.commit":
        // Bridges with server_vad auto-commit; for explicit commits we
        // surface a no-op today. commit 3 may forward this to the bridge
        // if the provider needs it for PTT flows.
        return;
      case "response.cancel":
        // Realtime cancel maps to bridge barge-in; the bridge exposes
        // this through its bridge-private cancel path. For commit 2 we
        // trigger the clear-audio callback; commit 3 wires a real cancel
        // through `submitToolResult`/`response.cancel` on the upstream WS.
        handleClearAudio();
        return;
      case "session.end":
        close("session_ended", TALK_REALTIME_CLOSE.SESSION_ENDED);
        return;
      case "ping":
        send({ type: "ping", ts: decoded.ts });
        return;
    }
  };

  const handleAssistantAudio = (audio: Buffer): void => {
    if (closed || audio.length === 0) {
      return;
    }
    send({ type: "response.audio.delta", audio: audio.toString("base64") });
  };

  const handleTranscript = (role: "user" | "assistant", text: string, isFinal: boolean): void => {
    if (closed || text.length === 0) {
      return;
    }
    if (role === "user") {
      send({
        type: isFinal
          ? "conversation.item.input_audio_transcription.final"
          : "conversation.item.input_audio_transcription.partial",
        text,
      });
      return;
    }
    send({
      type: isFinal ? "response.output_text.done" : "response.output_text.delta",
      text,
    });
  };

  const handleClearAudio = (): void => {
    if (closed) {
      return;
    }
    send({ type: "response.audio.done" });
  };

  // Announce readiness. The upstream bridge has not yet emitted
  // `onReady`; the session is "ready" from the client's perspective once
  // the WS upgrade succeeds and the ticket is redeemed.
  send({
    type: "session.ready",
    voiceRunId: ticket.voiceRunId,
    sessionKey: ticket.sessionKey,
    audio: TALK_REALTIME_AUDIO,
  });

  return {
    voiceRunId: ticket.voiceRunId,
    sessionKey: ticket.sessionKey,
    sendServerEvent: send,
    close,
    handleClientFrame,
    handleAssistantAudio,
    handleTranscript,
    handleClearAudio,
  };
}

const CLOSE_CODE_BY_REASON = {
  replaced_by_newer: TALK_REALTIME_CLOSE.REPLACED_BY_NEWER,
  bridge_error: TALK_REALTIME_CLOSE.BRIDGE_ERROR,
  session_ended: TALK_REALTIME_CLOSE.SESSION_ENDED,
} as const satisfies Record<VoiceRunEvictReason, TalkRealtimeCloseCode>;

function closeCodeForReason(reason: VoiceRunEvictReason): TalkRealtimeCloseCode {
  return CLOSE_CODE_BY_REASON[reason];
}
