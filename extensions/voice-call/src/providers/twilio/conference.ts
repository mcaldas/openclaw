import { generateRoomTwiml } from "../../manager/twiml.js";
import type { CallRoomApi } from "../base.js";

type TwilioRequest = <T = unknown>(
  endpoint: string,
  body: Record<string, string | string[]>,
  options?: { allowNotFound?: boolean },
) => Promise<T>;

type ParticipantResponse = { call_sid?: string; conference_sid?: string };

/**
 * Every leg joins quietly (no beeps, no hold music) with the small jitter buffer: the default
 * "large" buffer adds 300-1000 ms per leg. No leg ends the room on exit: the service leg steps
 * out briefly to press keys, and Jarvis leaves on hand-over. The plugin ends the room itself.
 */
const ROOM_LEG = {
  Beep: "false",
  WaitUrl: "",
  StartConferenceOnEnter: "true",
  EndConferenceOnExit: "false",
  JitterBufferSize: "small",
  // The room should not hear a joining leg ring.
  EarlyMedia: "false",
};

/** Human or voicemail, decided within 5 s of the answer; "unknown" counts as a person. */
function voicemailCheck(statusCallback: string): Record<string, string> {
  const url = new URL(statusCallback);
  url.searchParams.set("check", "voicemail");
  return {
    MachineDetection: "Enable",
    MachineDetectionTimeout: "5",
    AmdStatusCallback: url.toString(),
    AmdStatusCallbackMethod: "POST",
  };
}

/**
 * Who speaks when, per leg: Twilio's conference speaker events go to the room webhook. Only the
 * first leg's settings count (the callee's, which creates the room); later legs repeat them.
 */
function speakerEvents(statusCallback: unknown): Record<string, string> {
  // Speaker events are a nicety: a leg without a usable status URL still joins.
  if (typeof statusCallback !== "string" || !URL.canParse(statusCallback)) {
    return {};
  }
  const url = new URL(statusCallback);
  url.searchParams.set("type", "room"); // ROOM_STATUS_TYPE in room.ts
  url.searchParams.set("leg", "conference");
  url.searchParams.delete("check");
  return {
    ConferenceStatusCallback: url.toString(),
    ConferenceStatusCallbackMethod: "POST",
    ConferenceStatusCallbackEvent: "speaker",
  };
}

/** Twilio's <Play digits> knows digits, * # and w (0.5 s pause). */
export function toTwilioKeys(digits: string): string {
  return digits.replace(/[pP,]/g, "w").replace(/W/g, "ww");
}

/** Twilio conference rooms, addressed by friendly name so no lookup is needed to join one. */
export function createTwilioRoomApi(params: {
  request: TwilioRequest;
  updateTwiml: (callSid: string, twiml: string) => Promise<void>;
}) {
  const join = async (room: string, leg: Record<string, string | string[]>) => {
    const result = await params.request<ParticipantResponse>(
      `/Conferences/${encodeURIComponent(room)}/Participants.json`,
      { ...ROOM_LEG, ...speakerEvents(leg.StatusCallback), ...leg },
    );
    if (!result?.call_sid) {
      throw new Error("Twilio did not return a call SID for the room participant");
    }
    return { callSid: result.call_sid, conferenceSid: result.conference_sid };
  };
  const api: CallRoomApi & { join: typeof join } = {
    join,
    addParticipant: (room, input) =>
      join(room, {
        To: input.to,
        From: input.from,
        StatusCallback: input.statusCallback,
        StatusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        Timeout: String(input.timeoutSeconds ?? 30),
        ...(input.timeLimitSeconds ? { TimeLimit: String(input.timeLimitSeconds) } : {}),
        ...(input.record ? { Record: "true", RecordingChannels: "dual" } : {}),
        ...(input.detectVoicemail ? voicemailCheck(input.statusCallback) : {}),
      }),
    pressKeys: (callSid, room, digits) =>
      params.updateTwiml(callSid, generateRoomTwiml(room, toTwilioKeys(digits))),
    async hangupLeg(callSid) {
      await params.request(
        `/Calls/${callSid}.json`,
        { Status: "completed" },
        { allowNotFound: true },
      );
    },
  };
  return api;
}
