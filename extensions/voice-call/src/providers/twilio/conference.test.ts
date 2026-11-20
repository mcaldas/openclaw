import { describe, expect, it, vi } from "vitest";
import { TwilioProvider } from "../twilio.js";
import { createTwilioRoomApi, toTwilioKeys } from "./conference.js";

type Request = (
  endpoint: string,
  body: Record<string, string | string[]>,
  options?: { allowNotFound?: boolean },
) => Promise<unknown>;

function setup(response: unknown = { call_sid: "CA-leg", conference_sid: "CF-1" }) {
  const request = vi.fn<Request>(async () => response);
  const updateTwiml = vi.fn(async (_callSid: string, _twiml: string) => {});
  const api = createTwilioRoomApi({
    request: (endpoint, body, options) => request(endpoint, body, options) as never,
    updateTwiml,
  });
  return { api, request, updateTwiml };
}

describe("createTwilioRoomApi", () => {
  it("adds a quiet, small-buffer leg that never ends the room", async () => {
    const { api, request } = setup();
    await expect(
      api.addParticipant("oc-call-1", {
        to: "+972500000001",
        from: "+972500000002",
        statusCallback: "https://gw/voice/webhook?callId=call-1&type=room&leg=owner",
        timeoutSeconds: 25,
        record: true,
      }),
    ).resolves.toEqual({ callSid: "CA-leg", conferenceSid: "CF-1" });
    expect(request).toHaveBeenCalledWith(
      "/Conferences/oc-call-1/Participants.json",
      {
        Beep: "false",
        WaitUrl: "",
        StartConferenceOnEnter: "true",
        EndConferenceOnExit: "false",
        JitterBufferSize: "small",
        EarlyMedia: "false",
        // Speaker events per leg, at the room webhook; Twilio keeps the first leg's settings.
        ConferenceStatusCallback: "https://gw/voice/webhook?callId=call-1&type=room&leg=conference",
        ConferenceStatusCallbackMethod: "POST",
        ConferenceStatusCallbackEvent: "speaker",
        To: "+972500000001",
        From: "+972500000002",
        StatusCallback: "https://gw/voice/webhook?callId=call-1&type=room&leg=owner",
        StatusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        Timeout: "25",
        Record: "true",
        RecordingChannels: "dual",
      },
      undefined,
    );
  });

  it("fails loudly when Twilio returns no call SID", async () => {
    const { api } = setup({});
    await expect(
      api.addParticipant("oc-call-1", { to: "app:AP1", from: "+1", statusCallback: "u" }),
    ).rejects.toThrow(/no call SID|did not return/);
  });

  it("presses keys by hopping the leg out of the room and back", async () => {
    const { api, updateTwiml } = setup();
    await api.pressKeys("CA-callee", "oc-call-1", "1p#");
    const [callSid, twiml] = updateTwiml.mock.calls[0] ?? [];
    expect(callSid).toBe("CA-callee");
    expect(twiml).toContain('<Play digits="1w#" />');
    expect(twiml).toContain('endConferenceOnExit="false"');
    expect(twiml).toContain(">oc-call-1</Conference>");
    expect(twiml?.indexOf("<Play")).toBeLessThan(twiml?.indexOf("<Dial>") ?? 0);
  });

  it("hangs up one leg, tolerating one already gone", async () => {
    const { api, request } = setup();
    await api.hangupLeg("CA-agent");
    expect(request).toHaveBeenCalledWith(
      "/Calls/CA-agent.json",
      { Status: "completed" },
      { allowNotFound: true },
    );
  });

  it("maps pauses to Twilio's w", () => {
    expect(toTwilioKeys("12,3p4P5W#")).toBe("12w3w4w5ww#");
  });
});

describe("TwilioProvider room calls", () => {
  it("joins the callee to the room with the normal status callback and no TwiML URL", async () => {
    const provider = new TwilioProvider(
      { accountSid: "AC123", authToken: "secret" },
      { publicUrl: "https://example.ngrok.app" },
    );
    const apiRequest = vi.fn<Request>(async () => ({
      call_sid: "CA-callee",
      conference_sid: "CF-9",
    }));
    // SAFETY: tests replace the private REST seam, as twilio.test.ts does.
    (provider as unknown as { apiRequest: Request }).apiRequest = apiRequest;
    const result = await provider.initiateCall({
      callId: "call-1",
      from: "+972500000002",
      to: "+972500000003",
      webhookUrl: "https://example.ngrok.app/voice/webhook",
      room: "oc-call-1",
      voicemail: {
        detection: "twilio",
        onMachine: "hang-up",
        machineDetectionSpeechThresholdMs: 2400,
        machineDetectionSpeechEndThresholdMs: 1200,
        machineDetectionSilenceTimeoutMs: 5000,
        machineDetectionTimeoutMs: 30000,
      },
    });
    expect(result).toMatchObject({ providerCallId: "CA-callee", conferenceSid: "CF-9" });
    const [endpoint, params] = apiRequest.mock.calls[0] ?? [];
    expect(endpoint).toBe("/Conferences/oc-call-1/Participants.json");
    expect(params).toMatchObject({
      To: "+972500000003",
      From: "+972500000002",
      StatusCallback: "https://example.ngrok.app/voice/webhook?callId=call-1&type=status",
      EndConferenceOnExit: "false",
      MachineDetection: "Enable",
      AmdStatusCallback: "https://example.ngrok.app/voice/webhook?callId=call-1&type=amd",
    });
    expect(params).not.toHaveProperty("Url");
    expect(params).not.toHaveProperty("AsyncAmd");
    expect(params).not.toHaveProperty("AsyncAmdStatusCallback");
  });
});
