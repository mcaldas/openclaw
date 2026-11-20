import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  calculateMulawRms,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceSessionHarness,
} from "openclaw/plugin-sdk/realtime-voice";
import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { encodeDtmfMulaw } from "../dtmf-tones.js";
import type { HoldGate } from "../hold-gate.js";
import { createRoomHoldGate } from "../hold-wake.js";
import type { CallRecord } from "../types.js";
import { RealtimeAudioPacer } from "./realtime-audio-pacer.js";
import {
  createOutboundGreetingController,
  createRealtimeCallAudioController,
  createRealtimeCallActivityController,
  REALTIME_MEDIA_INACTIVITY_TIMEOUT_MS,
  REALTIME_DISCONNECT_HANGUP_GRACE_MS,
} from "./realtime-call-session-control.js";
import type { StreamFrameAdapter } from "./stream-frame-adapter.js";

const MAX_REALTIME_WS_BUFFERED_BYTES = 1024 * 1024;
// Time for the carrier to acknowledge the mark after the last tone has played.
const KEYPAD_ACK_GRACE_MS = 5_000;

/** Hold gates of live room calls, so the room can wake Jarvis when the owner joins. */
export const roomHoldGates = new Map<string, HoldGate>();

/**
 * Per live call: drop the model's audio for a while. Gemini answers every tool result aloud,
 * and after a key press or a hold it says "No speech." or "No spoken response." to the line
 * (hold lab call 2026-11-20), which a speech-enabled menu or a person picking up would hear.
 */
export const modelQuietWindows = new Map<string, (ms: number) => void>();
/** Long enough for those replies (0.5-1.5 s, starting within 1 s of the result). */
export const SILENT_TOOL_QUIET_MS = 3_000;

/** Per live call: add text to the model's context without asking it to reply. */
export const modelContextNotes = new Map<string, (text: string) => boolean>();

/**
 * The bridge API only sends user turns, which Gemini answers aloud. Google Live itself takes
 * client content with turnComplete false: context the model reads with the next turn, no reply.
 * That lives on the Google bridge's session; any other provider skips the note (false).
 */
export function addSilentContext(session: RealtimeVoiceBridgeSession | undefined, text: string) {
  try {
    // SAFETY: optional shape check on the provider bridge; every member is tested before use.
    const bridge = session?.bridge as { session?: { sendClientContent?: unknown } } | undefined;
    const live = bridge?.session;
    if (!live || typeof live.sendClientContent !== "function") {
      return false;
    }
    live.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: false });
    return true;
  } catch {
    return false;
  }
}

function wantsHoldGate(call: CallRecord): boolean {
  const room = call.metadata?.room;
  return Boolean(
    room && typeof room === "object" && !("muteHold" in room && room.muteHold === false),
  );
}

export function createRealtimeCallPlayback(params: {
  ws: WebSocket;
  callRecord: CallRecord;
  callSid: string;
  adapter: StreamFrameAdapter;
  harness: RealtimeVoiceSessionHarness;
  initialGreetingInstructions?: string;
  /** True when the host, not the bridge's ready trigger, decides when the opening is spoken. */
  hostOwnsOpening: boolean;
  holdOpeningMaxMs?: number;
  idleHangupMs?: number;
  getSession: () => RealtimeVoiceBridgeSession | undefined;
  isClosed: () => boolean;
  closeForInactivity: () => void;
}) {
  const { ws, callRecord, callSid, adapter, harness, initialGreetingInstructions } = params;
  const callId = callRecord.callId;
  const checkBackpressure = (phase: "before" | "after"): boolean => {
    if (ws.bufferedAmount > MAX_REALTIME_WS_BUFFERED_BYTES) {
      console.warn(
        `[voice-call] realtime outbound websocket backpressure ${phase} send callId=${callId} providerCallId=${callSid} bufferedBytes=${ws.bufferedAmount}`,
      );
      ws.close(1013, "Backpressure: send buffer exceeded");
      return false;
    }
    return true;
  };
  const sendString = (message: string): boolean => {
    if (ws.readyState !== WebSocket.OPEN || !checkBackpressure("before")) {
      return false;
    }
    ws.send(message);
    return checkBackpressure("after");
  };
  const pendingMarkAcks = new Map<string, () => void>();
  const keypadAborts = new Set<(error: Error) => void>();
  const audioPacer = new RealtimeAudioPacer({
    // Every pacer reset discards queued marks, so their stored provider
    // acknowledgements can never fire and must be retired with them.
    onPlaybackReset: () => {
      pendingMarkAcks.clear();
      // Clears are held during tones, so a reset here means the stream closed under them.
      for (const abort of keypadAborts) {
        abort(new Error("Realtime call stream closed before the keypad tones finished"));
      }
    },
    // Model audio can arrive long before the callee hears it; host speech and the
    // speech-idle timer follow what is actually played out on the call.
    onAudioSent: (audio) => {
      if (calculateMulawRms(audio) >= 0.035) {
        holdGate?.noteAssistantSpeech();
        hostSpeech.noteAudibleOutput();
        activity.noteSpeech();
      }
    },
    // A barge-in clear mid-tone would cut a key press short or drop it, so it spares the tones.
    canClear: () => {
      if (keypadAborts.size > 0) {
        console.log(
          `[voice-call] realtime audio clear kept keypad tones callId=${callId} providerCallId=${callSid}`,
        );
      }
      return keypadAborts.size === 0;
    },
    send: sendString,
    serializer: adapter,
    onBackpressure: () => {
      console.warn(
        `[voice-call] realtime paced audio backpressure callId=${callId} providerCallId=${callSid}`,
      );
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1013, "Backpressure: paced audio queue exceeded");
      }
    },
  });
  const outboundGreeting = createOutboundGreetingController({
    enabled: params.hostOwnsOpening,
    instructions: initialGreetingInstructions,
    call: callRecord,
    holdOpeningMaxMs: params.holdOpeningMaxMs,
    acknowledge: (instructions) => {
      void hostSpeech.speak(instructions).catch((error: unknown) => {
        console.warn("[voice-call] AMD acknowledgement failed:", formatErrorMessage(error));
      });
    },
  });
  // One host-requested utterance, completed by audible output rather than model receipts.
  const hostSpeech = (() => {
    let closed = false;
    let pending: { resolve: () => void; reject: (error: Error) => void } | undefined;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      const current = pending;
      pending = undefined;
      clearTimeout(quietTimer);
      clearTimeout(deadline);
      if (error) {
        current?.reject(error);
      } else {
        current?.resolve();
      }
    };
    return {
      isActive: () => Boolean(pending),
      speak(instructions: string): Promise<void> {
        if (closed) {
          return Promise.reject(new Error("Realtime bridge is closed"));
        }
        finish(new Error("Host speech replaced"));
        return new Promise<void>((resolve, reject) => {
          try {
            params.getSession()?.handleBargeIn({ audioPlaybackActive: true, force: true });
            audioController.cancelOutputAudioForBargeIn("local");
            if (closed) {
              throw new Error("Realtime bridge is closed");
            }
            pending = { resolve, reject };
            deadline = setTimeout(
              () => finish(new Error("Realtime speech did not finish within 45 seconds")),
              45_000,
            );
            deadline.unref();
            const session = params.getSession();
            if (!session) {
              throw new Error("No active realtime bridge for call");
            }
            session.triggerGreeting(instructions);
          } catch (error) {
            const rejection = error instanceof Error ? error : new Error(String(error));
            finish(rejection);
            reject(rejection);
          }
        });
      },
      noteAudibleOutput() {
        if (!pending) {
          return;
        }
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => finish(), 1_500).unref();
      },
      close() {
        closed = true;
        finish(new Error("Realtime bridge closed during host speech"));
      },
    };
  })();
  // Tones join the paced queue behind speech already queued, and model speech that arrives
  // later waits behind them; the carrier mark after the last tone confirms the keys played.
  const playKeypadTones = (digits: string): Promise<{ durationMs: number; confirmed: boolean }> => {
    if (params.isClosed() || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Realtime call stream is closed"));
    }
    const audio = encodeDtmfMulaw(digits);
    const durationMs = audio.length / 8;
    const markName = `openclaw-keypad-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const finish = (confirmed: boolean, error?: Error) => {
        if (!keypadAborts.delete(abort)) {
          return;
        }
        clearTimeout(timer);
        pendingMarkAcks.delete(markName);
        if (error) {
          reject(error);
        } else {
          resolve({ durationMs, confirmed });
        }
      };
      const abort = (error: Error) => finish(false, error);
      const playoutMs = audioPacer.queuedAudioMs() + durationMs;
      const timer = setTimeout(() => finish(false), playoutMs + KEYPAD_ACK_GRACE_MS);
      timer.unref?.();
      // Registered before queueing: a backpressure close can reset the pacer synchronously.
      keypadAborts.add(abort);
      pendingMarkAcks.set(markName, () => finish(true));
      console.log(
        `[voice-call] realtime keypad tones queued callId=${callId} providerCallId=${callSid} keys=${digits.length} durationMs=${durationMs} playoutMs=${playoutMs}`,
      );
      audioPacer.sendAudio(audio, { keep: true });
      audioPacer.sendMark(markName);
    });
  };
  // Room calls only: hold music never reaches the model, so it cannot re-bill the call on each turn.
  let holdPaused = false;
  const tag = `callId=${callId} providerCallId=${callSid}`;
  const room = wantsHoldGate(callRecord)
    ? createRoomHoldGate(
        callRecord,
        (event) => {
          console.log(`[voice-call] hold gate ${event} ${tag}`);
          // The idle timer counts speech, and a hold has none: pause it while holding.
          const holding = event === "hold" || event === "rehold" || event === "repeat";
          if (holding !== holdPaused) {
            holdPaused = holding;
            (holding ? activity.beginConsult : activity.endConsult)();
          }
        },
        (message) => console.log(`[voice-call] ${message} ${tag}`),
      )
    : undefined;
  const holdGate = room?.gate;
  let quietUntil = 0;
  const quiet = (ms: number) => {
    quietUntil = Date.now() + ms;
  };
  modelQuietWindows.set(callId, quiet);
  const addContext = (text: string) => addSilentContext(params.getSession(), text);
  modelContextNotes.set(callId, addContext);
  if (room) {
    console.log(`[voice-call] hold gate detector=${room.detector} ${tag}`);
    roomHoldGates.set(callId, room.gate);
  }
  const audioController = {
    playKeypadTones,
    filterInput: (audio: Buffer): Buffer => holdGate?.accept(audio) ?? audio,
    ...createRealtimeCallAudioController({
      audioPacer,
      callId,
      harness,
      isOpen: () => !params.isClosed() && ws.readyState === WebSocket.OPEN,
      isBlocked: () =>
        Date.now() < quietUntil || (outboundGreeting.isBlocked() && !hostSpeech.isActive()),
      onAudibleOutput: () => {
        outboundGreeting.claim();
      },
      pendingMarkAcks,
      providerCallId: callSid,
    }),
  };
  const activity = createRealtimeCallActivityController({
    idleHangupMs: params.idleHangupMs,
    isPaused: () => outboundGreeting.isBlocked() || hostSpeech.isActive(),
    onIdle: () => {
      console.warn(
        `[voice-call] Realtime speech idle timeout callId=${callId} providerCallId=${callSid} timeoutMs=${params.idleHangupMs}`,
      );
      params.closeForInactivity();
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, "Speech inactivity");
      }
    },
    onMediaWarning: () => {
      console.warn(
        `[voice-call] Realtime media inactive callId=${callId} providerCallId=${callSid} timeoutMs=${REALTIME_MEDIA_INACTIVITY_TIMEOUT_MS} graceMs=${REALTIME_DISCONNECT_HANGUP_GRACE_MS}`,
      );
    },
    onMediaTimeout: () => {
      params.closeForInactivity();
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, "Media inactivity");
      }
    },
  });
  const closeActivity = activity.close.bind(activity);
  activity.close = () => {
    if (roomHoldGates.get(callId) === holdGate) {
      roomHoldGates.delete(callId);
    }
    room?.close();
    if (modelQuietWindows.get(callId) === quiet) {
      modelQuietWindows.delete(callId);
    }
    if (modelContextNotes.get(callId) === addContext) {
      modelContextNotes.delete(callId);
    }
    closeActivity();
  };
  return {
    audioPacer,
    pendingMarkAcks,
    outboundGreeting,
    audioController,
    activity,
    hostSpeech,
  };
}
