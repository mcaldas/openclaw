import type http from "node:http";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { VoiceCallConfig } from "./config.js";
import type { CallRoomApi } from "./providers/base.js";
import { isProviderStatusTerminal } from "./providers/shared/call-status.js";
import {
  TerminalStates,
  type CallId,
  type CallRecord,
  type EndReason,
  type WebhookContext,
} from "./types.js";
import type { WebhookResponsePayload } from "./webhook.types.js";

/** Kept in `metadata.room`, so a report or a restart can still find every leg. */
export type RoomState = {
  /** Conference friendly name. */
  name: string;
  /** False turns the hold-music gate off for this call. */
  muteHold?: boolean;
  /** "energy" keeps the original hold gate for this call (default Silero). */
  holdDetector?: "silero" | "energy";
  /** Jarvis's leg: a TwiML App participant whose Voice URL opens the realtime stream. */
  agentCallSid?: string;
  agentGone?: boolean;
  /** The owner's current leg. "answering" waits for the human-or-voicemail check. */
  ownerCallSid?: string;
  owner?: "ringing" | "answering" | "in-room" | "no-answer" | "left";
  /** Every owner leg that answered, so each recording is collected. */
  ownerLegs?: { callSid: string; answeredAt: number }[];
};

/** Hooks the call manager uses for calls that run in a room. */
export type CallRoomHooks = {
  /** The callee answered: bring Jarvis into the room. */
  onAnswered(call: CallRecord): void;
  /** Keys by a short hop of the callee's leg; undefined when the call has no room. */
  pressKeys(call: CallRecord, digits: string): Promise<"sent" | "duplicate"> | undefined;
  /** True when ending must only drop Jarvis, because the owner is talking with the callee. */
  handOver(call: CallRecord): Promise<boolean>;
};

type RoomManager = {
  getCall(callId: CallId): CallRecord | undefined;
  updateCallMetadata(
    call: CallRecord,
    update: (metadata: CallRecord["metadata"]) => CallRecord["metadata"],
    options?: { persist?: boolean },
  ): Promise<void>;
  endCall(callId: CallId, options?: { reason?: EndReason }): Promise<{ success: boolean }>;
};

/** Answers webhook requests for room legs; undefined lets normal routing handle the request. */
export type RoomWebhookRouter = (
  ctx: WebhookContext,
  req: http.IncomingMessage,
) => Promise<WebhookResponsePayload | undefined>;

export const ROOM_STATUS_TYPE = "room";
const twiml = (body: string): WebhookResponsePayload => ({
  statusCode: 200,
  headers: { "Content-Type": "application/xml" },
  body: `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`,
});
const ENDED_STATUSES = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);
// After Twilio accepts the hop, the leg still plays the keys and rejoins.
const HOP_SETTLE_MS = 800;
const HOP_MS_PER_KEY = 300;
const DUPLICATE_KEYS_MS = 1_000;
/** The owner counts as joined if the voicemail check never reports (it gives up after 5 s). */
const OWNER_CHECK_FALLBACK_MS = 8_000;
/** Legs outlive a crashed gateway only this long past the call's limit. */
const LEG_LIMIT_MARGIN_SECONDS = 120;
const CLOSED_RETENTION_MS = 10 * 60_000;

function isRoomState(value: unknown): value is RoomState {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "name") === "string"
  );
}

export function roomOf(call: Pick<CallRecord, "metadata"> | undefined): RoomState | undefined {
  const room = call?.metadata?.room;
  return isRoomState(room) ? room : undefined;
}

/** Room mode needs Twilio, the realtime voice and a TwiML App for Jarvis's leg. */
export function shouldUseRoom(
  config: Pick<VoiceCallConfig, "room" | "realtime">,
  call: { mode: string; dtmfSequence?: string; providerHasRooms: boolean },
): boolean {
  return Boolean(
    config.room?.enabled &&
    config.room.twimlAppSid &&
    config.realtime.enabled &&
    call.providerHasRooms &&
    call.mode === "conversation" &&
    !call.dtmfSequence,
  );
}

export function createCallRooms(deps: {
  config: VoiceCallConfig;
  manager: RoomManager;
  carrier: CallRoomApi;
  webhookUrl: () => string | null;
  /** A note to Jarvis: it starts a model turn with these instructions. */
  note: (callId: CallId, instructions: string) => void;
  /** Off while the owner is on the line: Jarvis must hear everything then, music or not. */
  allowHold: (callId: CallId, allowed: boolean) => void;
  recordOwner: (call: CallRecord) => boolean;
  now?: () => number;
  log?: (message: string) => void;
}) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.log(`[voice-call] ${message}`));
  const ownerName = deps.config.room?.ownerName ?? "the owner";
  const timeLimitSeconds = (deps.config.maxDurationSeconds ?? 3600) + LEG_LIMIT_MARGIN_SECONDS;
  const keys = new Map<CallId, { busyUntil: number; last?: { digits: string; at: number } }>();
  const joining = new Set<CallId>();
  const closed = new Set<CallId>();

  const legUrl = (callId: CallId, leg: "agent" | "owner") => {
    const base = deps.webhookUrl();
    if (!base) {
      throw new Error("Webhook URL not configured");
    }
    const url = new URL(base);
    url.searchParams.set("callId", callId);
    url.searchParams.set("type", ROOM_STATUS_TYPE);
    url.searchParams.set("leg", leg);
    return url.toString();
  };

  const isLive = (call: CallRecord) =>
    deps.manager.getCall(call.callId) === call && !TerminalStates.has(call.state);

  const patch = (call: CallRecord, change: Partial<RoomState>) =>
    deps.manager
      .updateCallMetadata(
        call,
        (metadata) => {
          const room = roomOf({ metadata });
          return room ? { ...metadata, room: { ...room, ...change } } : metadata;
        },
        { persist: true },
      )
      .catch((err: unknown) => {
        log(`room state not saved callId=${call.callId}: ${formatErrorMessage(err)}`);
      });

  const end = (callId: CallId, why: string, reason?: EndReason) => {
    log(`room ending call callId=${callId}: ${why}`);
    void deps.manager.endCall(callId, reason ? { reason } : undefined).catch((err: unknown) => {
      log(`room could not end call ${callId}: ${formatErrorMessage(err)}`);
    });
  };

  const notes = {
    joined: `${ownerName} has just joined this call and can hear everyone. In one short sentence, tell the other person that ${ownerName} is on the line. Then let them talk, and speak only when one of them addresses you.`,
    noAnswer: `${ownerName} did not answer. Tell the other person briefly, then carry on with the task yourself, or ask for a direct number or a good time for ${ownerName} to call back.`,
    left: `${ownerName} has left the call. Carry on with the task yourself; if it is done, say goodbye and end the call.`,
  };

  const ownerJoined = async (call: CallRecord, callSid: string) => {
    const room = roomOf(call);
    if (!isLive(call) || room?.owner !== "answering" || room.ownerCallSid !== callSid) {
      return;
    }
    await patch(call, { owner: "in-room" });
    deps.note(call.callId, notes.joined);
  };

  const ownerMissed = async (call: CallRecord) => {
    await patch(call, { owner: "no-answer" });
    deps.allowHold(call.callId, true);
    deps.note(call.callId, notes.noAnswer);
  };

  const hooks: CallRoomHooks = {
    onAnswered(call) {
      const room = roomOf(call);
      const appSid = deps.config.room?.twimlAppSid;
      if (!room || room.agentCallSid || joining.has(call.callId) || !appSid) {
        return;
      }
      joining.add(call.callId);
      const from = deps.config.fromNumber ?? "";
      void Promise.resolve()
        .then(() =>
          deps.carrier.addParticipant(room.name, {
            to: `app:${appSid}?callId=${encodeURIComponent(call.callId)}&leg=agent`,
            from,
            statusCallback: legUrl(call.callId, "agent"),
            timeLimitSeconds,
          }),
        )
        .then(async ({ callSid }) => {
          log(`room ${room.name}: Jarvis joining as ${callSid}`);
          await patch(call, { agentCallSid: callSid });
        })
        .catch((err: unknown) => {
          // The callee would sit in a silent room: end the call instead.
          end(call.callId, `Jarvis could not join: ${formatErrorMessage(err)}`, "error");
        })
        .finally(() => joining.delete(call.callId));
    },

    pressKeys(call, digits) {
      const room = roomOf(call);
      if (!room || !call.providerCallId) {
        return undefined;
      }
      const at = now();
      const state = keys.get(call.callId) ?? { busyUntil: 0 };
      keys.set(call.callId, state);
      // Realtime models sometimes call the tool twice for one press.
      if (state.last?.digits === digits && at - state.last.at < DUPLICATE_KEYS_MS) {
        return Promise.resolve("duplicate" as const);
      }
      if (at < state.busyUntil) {
        return Promise.reject(new Error("Still pressing the previous keys; wait for the menu"));
      }
      state.last = { digits, at };
      state.busyUntil = Number.POSITIVE_INFINITY;
      return deps.carrier.pressKeys(call.providerCallId, room.name, digits).then(
        () => {
          state.busyUntil = now() + HOP_SETTLE_MS + HOP_MS_PER_KEY * digits.length;
          return "sent" as const;
        },
        (err: unknown) => {
          state.busyUntil = 0;
          throw err;
        },
      );
    },

    async handOver(call) {
      const room = roomOf(call);
      if (room?.owner !== "in-room") {
        return false;
      }
      if (!room.agentGone && room.agentCallSid) {
        log(`room ${room.name}: hand-over, Jarvis leaves; ${ownerName} stays with the callee`);
        await deps.carrier.hangupLeg(room.agentCallSid);
      }
      await patch(call, { agentGone: true });
      // The owner may have hung up meanwhile; then nobody is with the callee and the call must end.
      return roomOf(call)?.owner === "in-room";
    },
  };

  /** Owner and Jarvis legs report here, never to the call's own state machine. */
  const onLegStatus = async (
    callId: CallId,
    leg: "agent" | "owner",
    form: URLSearchParams,
    voicemailCheck: boolean,
  ) => {
    const call = deps.manager.getCall(callId);
    const room = roomOf(call);
    if (!call || !room || TerminalStates.has(call.state)) {
      return;
    }
    const status = form.get("CallStatus") ?? "";
    const callSid = form.get("CallSid") ?? "";
    const ended = ENDED_STATUSES.has(status);
    log(
      `room ${room.name}: ${leg} leg ${voicemailCheck ? `check ${form.get("AnsweredBy")}` : status}`,
    );
    if (leg === "agent") {
      if (ended && !room.agentGone && (!room.agentCallSid || callSid === room.agentCallSid)) {
        await patch(call, { agentGone: true });
        if (roomOf(call)?.owner !== "in-room") {
          end(callId, "Jarvis's leg ended and nobody else is with the callee", "error");
        }
      }
      return;
    }
    // A callback from an earlier owner leg must not change the current one.
    if (room.ownerCallSid && callSid && callSid !== room.ownerCallSid) {
      return;
    }
    if (voicemailCheck) {
      const answeredBy = form.get("AnsweredBy") ?? "unknown";
      if (room.owner !== "answering") {
        return;
      }
      if (/^machine|^fax/.test(answeredBy)) {
        log(`room ${room.name}: ${ownerName}'s voicemail answered; hanging up that leg`);
        await deps.carrier.hangupLeg(callSid).catch(() => undefined);
        await ownerMissed(call);
      } else {
        await ownerJoined(call, callSid);
      }
      return;
    }
    if (status === "in-progress" && room.owner === "ringing") {
      const answeredAt = now();
      await patch(call, {
        owner: "answering",
        ownerCallSid: callSid || room.ownerCallSid,
        ownerLegs: [...(room.ownerLegs ?? []), { callSid, answeredAt }],
      });
      deps.allowHold(callId, false);
      setTimeout(() => void ownerJoined(call, callSid), OWNER_CHECK_FALLBACK_MS).unref?.();
      return;
    }
    if (!ended) {
      return;
    }
    if (room.owner === "in-room") {
      await patch(call, { owner: "left" });
      deps.allowHold(callId, true);
      if (roomOf(call)?.agentGone) {
        end(callId, `${ownerName} hung up after the hand-over`, "hangup-user");
      } else {
        deps.note(callId, notes.left);
      }
    } else if (room.owner === "ringing" || room.owner === "answering") {
      await ownerMissed(call);
    }
  };

  return {
    hooks,

    async addOwner(callId: CallId): Promise<Record<string, unknown>> {
      const call = deps.manager.getCall(callId);
      const room = roomOf(call);
      if (!call || !room || TerminalStates.has(call.state)) {
        return { error: "This call has no room, so nobody can be added to it" };
      }
      if (room.owner === "ringing" || room.owner === "answering" || room.owner === "in-room") {
        return {
          error: `${ownerName} is already ${room.owner === "in-room" ? "on the call" : "being called"}`,
        };
      }
      const to = deps.config.room?.ownerNumber ?? deps.config.toNumber;
      const from = deps.config.room?.ownerCallerId ?? deps.config.fromNumber;
      if (!to || !from) {
        return { error: `No phone number is configured for ${ownerName}` };
      }
      const ringSeconds = deps.config.room?.ownerRingSeconds ?? 25;
      // Marked before dialling, so even an instant failure callback finds the ring it belongs to.
      await patch(call, { owner: "ringing", ownerCallSid: undefined });
      let legSid: string;
      try {
        legSid = (
          await deps.carrier.addParticipant(room.name, {
            to,
            from,
            statusCallback: legUrl(callId, "owner"),
            timeoutSeconds: ringSeconds,
            record: deps.recordOwner(call),
            detectVoicemail: true,
            timeLimitSeconds,
          })
        ).callSid;
      } catch (err) {
        await patch(call, { owner: room.owner });
        return { error: `Could not call ${ownerName}: ${formatErrorMessage(err)}` };
      }
      if (!isLive(call)) {
        await deps.carrier.hangupLeg(legSid).catch(() => undefined);
        return { error: "The call ended while ringing" };
      }
      if (!roomOf(call)?.ownerCallSid) {
        await patch(call, { ownerCallSid: legSid });
      }
      return {
        calling: ownerName,
        note: `${ownerName}'s phone is ringing, for up to ${ringSeconds} seconds. Tell the other person you are bringing ${ownerName} in and ask them to hold a moment, then stay quiet. You will get a note when ${ownerName} joins or does not answer.`,
      };
    },

    /** Webhook requests for the room's own legs; undefined means "not a room request". */
    async routeWebhook(
      query: WebhookContext["query"],
      form: URLSearchParams,
      agentStream: (target: { callId: CallId; providerCallId: string }) => WebhookResponsePayload,
    ): Promise<WebhookResponsePayload | undefined> {
      // Jarvis's App leg carries leg=agent in its Voice URL; the custom params arrive in the body.
      const param = (name: string) => {
        const value = query?.[name];
        return typeof value === "string" ? value : (form.get(name) ?? undefined);
      };
      const leg = param("leg");
      if (leg !== "agent" && leg !== "owner") {
        return undefined;
      }
      const callId = param("callId") ?? "";
      if (query?.type === ROOM_STATUS_TYPE) {
        await onLegStatus(callId, leg, form, query?.check === "voicemail");
        return twiml("");
      }
      const call = deps.manager.getCall(callId);
      const room = roomOf(call);
      const status = form.get("CallStatus");
      if (
        leg !== "agent" ||
        !call?.providerCallId ||
        !room ||
        room.agentGone ||
        TerminalStates.has(call.state) ||
        (status && isProviderStatusTerminal(status))
      ) {
        log(`room refused a ${leg} leg request callId=${callId || "missing"}`);
        return twiml(status && isProviderStatusTerminal(status) ? "" : "<Hangup/>");
      }
      log(`room ${room.name}: Jarvis's stream opening`);
      return agentStream({ callId, providerCallId: call.providerCallId });
    },

    /** On the call's end, hang up the legs it brought in; the room then closes by itself. */
    observe(call: CallRecord): void {
      const room = roomOf(call);
      if (!room || !TerminalStates.has(call.state) || closed.has(call.callId)) {
        return;
      }
      closed.add(call.callId);
      setTimeout(() => closed.delete(call.callId), CLOSED_RETENTION_MS).unref?.();
      keys.delete(call.callId);
      for (const sid of [room.agentGone ? undefined : room.agentCallSid, room.ownerCallSid]) {
        if (sid) {
          void deps.carrier.hangupLeg(sid).catch((err: unknown) => {
            log(`room ${room.name}: leg ${sid} not hung up: ${formatErrorMessage(err)}`);
          });
        }
      }
    },
  };
}

export type CallRooms = ReturnType<typeof createCallRooms>;
