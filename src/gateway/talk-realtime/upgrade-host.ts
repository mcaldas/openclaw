import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { RealtimeVoiceBridge } from "../../realtime-voice/provider-types.js";
import { TALK_REALTIME_CLOSE, TALK_REALTIME_WS_PATH } from "./protocol.js";
import {
  createTalkRealtimeSession,
  type TalkRealtimeSession,
  type TalkRealtimeSessionDeps,
} from "./session.js";
import type { TalkRealtimeTicket, TalkRealtimeTicketRegistry } from "./ticket-registry.js";
import type {
  VoiceRunHandle,
  VoiceRunRegistry,
  VoiceRunEvictReason,
} from "./voice-run-registry.js";

export type TalkRealtimeBridgeSessionHandlers = {
  onAudio: (audio: Buffer) => void;
  onClearAudio: () => void;
  onTranscript: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
  onError: (err: Error) => void;
  onClose: (reason: "completed" | "error") => void;
  /**
   * Fires when a realtime tool call begins executing. Routed to the
   * client as `response.tool_call.started` so the iOS UI can render a
   * progress indicator.
   */
  onToolCallStarted?: (event: { callId: string; name: string }) => void;
  /**
   * Fires when a realtime tool call finishes. Routed to the client as
   * `response.tool_call.finished` with the measured duration.
   */
  onToolCallFinished?: (event: {
    callId: string;
    name: string;
    durationMs: number;
    ok: boolean;
  }) => void;
};

/**
 * Factory the caller provides to build a provider bridge + wire it to a
 * session. Called exactly once per successful upgrade, after the ticket
 * has been redeemed.
 */
export type TalkRealtimeBridgeFactory = (context: {
  ticket: TalkRealtimeTicket;
  /**
   * The session is provided as a deferred handle because the bridge
   * needs its callbacks wired BEFORE the session is created: the bridge
   * pushes audio/transcripts/tool-calls to the session, and those
   * handlers are owned by the session itself. The factory returns a
   * bridge whose callbacks were composed against
   * `sessionHandlersForBridge`.
   */
  sessionHandlersForBridge: TalkRealtimeBridgeSessionHandlers;
}) => Promise<RealtimeVoiceBridge> | RealtimeVoiceBridge;

export type TalkRealtimeHostDeps = {
  ticketRegistry: TalkRealtimeTicketRegistry;
  voiceRunRegistry: VoiceRunRegistry;
  bridgeFactory: TalkRealtimeBridgeFactory;
  /** Injected for tests. */
  webSocketServerClass?: typeof WebSocketServer;
  /** Optional logging hook. Keep dependency-free for testability. */
  log?: (level: "info" | "warn" | "error", message: string, meta?: unknown) => void;
};

export type TalkRealtimeHost = {
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  close: () => Promise<void>;
};

export function createTalkRealtimeHost(deps: TalkRealtimeHostDeps): TalkRealtimeHost {
  const WS = deps.webSocketServerClass ?? WebSocketServer;
  const wss = new WS({ noServer: true });
  const log = deps.log ?? (() => {});

  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== TALK_REALTIME_WS_PATH) {
      return false;
    }
    const ticketParam = url.searchParams.get("ticket") ?? "";
    if (!ticketParam) {
      writeUpgradeRejection(socket, 401, "missing ticket");
      return true;
    }

    const redemption = deps.ticketRegistry.redeem(ticketParam);
    if (!redemption.ok) {
      writeUpgradeRejection(socket, 401, `ticket ${redemption.reason}`);
      return true;
    }
    const ticket = redemption.ticket;

    // Accept the upgrade and hand off to the WS handler. From here on,
    // any failure closes the WS with an application-range code rather
    // than an HTTP 4xx.
    wss.handleUpgrade(req, socket as import("node:net").Socket, head, (clientWs) => {
      void attachClientWs(clientWs, ticket, deps, log);
    });
    return true;
  };

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
  };

  return { handleUpgrade, close };
}

async function attachClientWs(
  clientWs: WebSocket,
  ticket: TalkRealtimeTicket,
  deps: TalkRealtimeHostDeps,
  log: NonNullable<TalkRealtimeHostDeps["log"]>,
): Promise<void> {
  let session: TalkRealtimeSession | null = null;
  let bridge: RealtimeVoiceBridge | null = null;
  let runHandle: VoiceRunHandle | null = null;

  const teardown = (reason: VoiceRunEvictReason): void => {
    if (session) {
      session.close(reason);
      session = null;
    } else {
      try {
        clientWs.close(closeCodeFor(reason), reason);
      } catch {
        // Already closed.
      }
    }
    if (runHandle) {
      deps.voiceRunRegistry.unregister(runHandle.voiceRunId);
      runHandle = null;
    }
    bridge = null;
  };

  try {
    // Build the bridge with deferred session-handlers. The bridge will
    // invoke these handlers during `connect` and for every subsequent
    // upstream event, so we need a stable closure over a `session`
    // reference that becomes non-null immediately after.
    const sessionHandlersForBridge: TalkRealtimeBridgeSessionHandlers = {
      onAudio: (audio: Buffer) => {
        session?.handleAssistantAudio(audio);
      },
      onClearAudio: () => {
        session?.handleClearAudio();
      },
      onTranscript: (role, text, isFinal) => {
        session?.handleTranscript(role, text, isFinal);
      },
      onError: (err) => {
        log("error", "talk-realtime bridge error", { err: err.message });
        teardown("bridge_error");
      },
      onClose: (reason) => {
        teardown(reason === "error" ? "bridge_error" : "session_ended");
      },
      onToolCallStarted: (event) => {
        session?.sendServerEvent({
          type: "response.tool_call.started",
          callId: event.callId,
          name: event.name,
        });
      },
      onToolCallFinished: (event) => {
        session?.sendServerEvent({
          type: "response.tool_call.finished",
          callId: event.callId,
          name: event.name,
          durationMs: event.durationMs,
          ok: event.ok,
        });
      },
    };
    bridge = await deps.bridgeFactory({ ticket, sessionHandlersForBridge });

    // Pre-register the voice run so a racing `talk.realtime.start`
    // evicts the right handle. We do this BEFORE `connect` so the
    // eviction callback is observable.
    runHandle = {
      voiceRunId: ticket.voiceRunId,
      agentId: ticket.agentId,
      operatorConnId: ticket.operatorConnId,
      startedAtMs: Date.now(),
      evict: (reason) => teardown(reason),
    };
    deps.voiceRunRegistry.register(runHandle);

    const sessionDeps: TalkRealtimeSessionDeps = {
      clientWs,
      bridge,
      ticket,
    };
    session = createTalkRealtimeSession(sessionDeps);

    clientWs.on("message", (data) => {
      const text =
        typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : data instanceof ArrayBuffer
              ? Buffer.from(data).toString("utf8")
              : "";
      session?.handleClientFrame(text);
    });
    clientWs.on("close", () => {
      teardown("session_ended");
    });
    clientWs.on("error", (err) => {
      log("error", "talk-realtime client ws error", {
        err: err instanceof Error ? err.message : String(err),
      });
      teardown("bridge_error");
    });

    // Kick off the provider connection. If this throws synchronously we
    // tear down below; if it rejects asynchronously, the `onError`
    // callback we wired into the bridge triggers teardown.
    await bridge.connect();
  } catch (err) {
    log("error", "talk-realtime attach failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    teardown("bridge_error");
  }
}

function writeUpgradeRejection(socket: Duplex, status: number, message: string): void {
  const body = message;
  const statusText =
    status === 401
      ? "Unauthorized"
      : status === 403
        ? "Forbidden"
        : status === 404
          ? "Not Found"
          : "Bad Request";
  try {
    socket.write(
      `HTTP/1.1 ${status} ${statusText}\r\n` +
        "Connection: close\r\n" +
        "Content-Type: text/plain; charset=utf-8\r\n" +
        `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n` +
        "\r\n" +
        body,
    );
  } catch {
    // Socket already gone; fall through.
  }
  try {
    socket.destroy();
  } catch {
    // Ignore.
  }
}

const UPGRADE_CLOSE_CODE_BY_REASON: Record<VoiceRunEvictReason, number> = {
  replaced_by_newer: TALK_REALTIME_CLOSE.REPLACED_BY_NEWER,
  bridge_error: TALK_REALTIME_CLOSE.BRIDGE_ERROR,
  session_ended: TALK_REALTIME_CLOSE.SESSION_ENDED,
};

function closeCodeFor(reason: VoiceRunEvictReason): number {
  return UPGRADE_CLOSE_CODE_BY_REASON[reason];
}
