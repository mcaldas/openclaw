import { describe, expect, it, vi } from "vitest";
import { createCallRooms, roomOf, shouldUseRoom, type RoomState } from "./room.js";
import { CallRecordSchema, type CallRecord } from "./types.js";

const APP = `AP${"a".repeat(32)}`;

function makeCall(room: Partial<RoomState> | undefined, overrides: Partial<CallRecord> = {}) {
  return CallRecordSchema.parse({
    callId: "call-1",
    providerCallId: "CA-callee",
    provider: "twilio",
    direction: "outbound",
    state: "active",
    from: "+972500000002",
    to: "+972500000003",
    startedAt: 1_000,
    transcript: [],
    processedEventIds: [],
    metadata: room ? { room: { name: "oc-call-1", ...room } } : {},
    ...overrides,
  });
}

function setup(call: CallRecord, config: Record<string, unknown> = {}) {
  let clock = 10_000;
  const manager = {
    getCall: vi.fn((callId: string) => (callId === call.callId ? call : undefined)),
    updateCallMetadata: vi.fn(
      async (target: CallRecord, update: (m: CallRecord["metadata"]) => CallRecord["metadata"]) => {
        target.metadata = update(target.metadata);
      },
    ),
    endCall: vi.fn(async () => ({ success: true })),
  };
  let legs = 0;
  const carrier = {
    addParticipant: vi.fn(async () => ({ callSid: `CA-leg-${++legs}` })),
    pressKeys: vi.fn(async () => {}),
    hangupLeg: vi.fn(async () => {}),
  };
  const note = vi.fn();
  const releaseHold = vi.fn();
  const rooms = createCallRooms({
    config: {
      fromNumber: "+972500000002",
      toNumber: "+972500000009",
      realtime: { enabled: true },
      room: { enabled: true, twimlAppSid: APP, ownerName: "Mathias", ownerRingSeconds: 25 },
      ...config,
    } as never,
    manager,
    carrier,
    webhookUrl: () => "https://gw.example/voice/webhook",
    note,
    releaseHold,
    recordOwner: () => true,
    now: () => clock,
    log: () => {},
  });
  const status = (leg: "agent" | "owner", CallStatus: string) =>
    rooms.routeWebhook(
      { callId: "call-1", type: "room", leg },
      new URLSearchParams({ CallStatus }),
      () => ({ statusCode: 500, body: "" }),
    );
  return {
    rooms,
    manager,
    carrier,
    note,
    releaseHold,
    status,
    tick: (ms: number) => (clock += ms),
  };
}

const flush = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe("shouldUseRoom", () => {
  const config = {
    room: { enabled: true, twimlAppSid: APP },
    realtime: { enabled: true },
  } as never;
  it("is on for realtime conversation calls only", () => {
    expect(shouldUseRoom(config, { mode: "conversation", providerHasRooms: true })).toBe(true);
    expect(shouldUseRoom(config, { mode: "notify", providerHasRooms: true })).toBe(false);
    expect(
      shouldUseRoom(config, { mode: "conversation", dtmfSequence: "1", providerHasRooms: true }),
    ).toBe(false);
    expect(shouldUseRoom(config, { mode: "conversation", providerHasRooms: false })).toBe(false);
  });
});

describe("createCallRooms", () => {
  it("brings Jarvis in once, as the TwiML App, when the callee answers", async () => {
    const call = makeCall({});
    const { rooms, carrier } = setup(call);
    rooms.hooks.onAnswered(call);
    rooms.hooks.onAnswered(call);
    await flush();
    expect(carrier.addParticipant).toHaveBeenCalledTimes(1);
    expect(carrier.addParticipant).toHaveBeenCalledWith("oc-call-1", {
      to: `app:${APP}?callId=call-1&leg=agent`,
      from: "+972500000002",
      statusCallback: "https://gw.example/voice/webhook?callId=call-1&type=room&leg=agent",
    });
    expect(roomOf(call)?.agentCallSid).toBe("CA-leg-1");
    rooms.hooks.onAnswered(call);
    await flush();
    expect(carrier.addParticipant).toHaveBeenCalledTimes(1);
  });

  it("ends the call when Jarvis cannot join, so nobody waits in a silent room", async () => {
    const call = makeCall({});
    const { rooms, carrier, manager } = setup(call);
    carrier.addParticipant.mockRejectedValueOnce(new Error("21217"));
    rooms.hooks.onAnswered(call);
    await flush();
    expect(manager.endCall).toHaveBeenCalledWith("call-1", { reason: "error" });
  });

  it("presses keys on the callee's leg, drops a quick duplicate and refuses overlap", async () => {
    const call = makeCall({});
    const { rooms, carrier, tick } = setup(call);
    await expect(rooms.hooks.pressKeys(call, "1")).resolves.toBe("sent");
    expect(carrier.pressKeys).toHaveBeenCalledWith("CA-callee", "oc-call-1", "1");
    await expect(rooms.hooks.pressKeys(call, "1")).resolves.toBe("duplicate");
    await expect(rooms.hooks.pressKeys(call, "2")).rejects.toThrow(/previous keys/);
    tick(1_200);
    await expect(rooms.hooks.pressKeys(call, "2")).resolves.toBe("sent");
    expect(carrier.pressKeys).toHaveBeenCalledTimes(2);
    expect(rooms.hooks.pressKeys(makeCall(undefined), "1")).toBeUndefined();
  });

  it("rings the owner, then wakes Jarvis with a note when the owner joins", async () => {
    const call = makeCall({ agentCallSid: "CA-agent" });
    const { rooms, carrier, note, releaseHold, status } = setup(call);
    const result = await rooms.addOwner("call-1");
    expect(result).toMatchObject({ calling: "Mathias" });
    expect(carrier.addParticipant).toHaveBeenCalledWith("oc-call-1", {
      to: "+972500000009",
      from: "+972500000002",
      statusCallback: "https://gw.example/voice/webhook?callId=call-1&type=room&leg=owner",
      timeoutSeconds: 25,
      record: true,
    });
    await expect(rooms.addOwner("call-1")).resolves.toMatchObject({ error: expect.any(String) });
    await status("owner", "ringing");
    await status("owner", "in-progress");
    expect(roomOf(call)).toMatchObject({ owner: "in-room", ownerCallSid: "CA-leg-1" });
    expect(releaseHold).toHaveBeenCalledWith("call-1");
    expect(note).toHaveBeenCalledWith("call-1", expect.stringContaining("Mathias has just joined"));
  });

  it("tells Jarvis when the owner does not answer", async () => {
    const call = makeCall({});
    const { rooms, note, status, manager } = setup(call);
    await rooms.addOwner("call-1");
    await status("owner", "no-answer");
    expect(roomOf(call)?.owner).toBe("no-answer");
    expect(note).toHaveBeenCalledWith("call-1", expect.stringContaining("did not answer"));
    expect(manager.endCall).not.toHaveBeenCalled();
  });

  it("hands over: only Jarvis leaves, and the owner's hang-up then ends the call", async () => {
    const call = makeCall({ agentCallSid: "CA-agent", owner: "in-room", ownerCallSid: "CA-owner" });
    const { rooms, carrier, manager, status } = setup(call);
    await expect(rooms.hooks.handOver(call)).resolves.toBe(true);
    expect(carrier.hangupLeg).toHaveBeenCalledWith("CA-agent");
    expect(roomOf(call)?.agentGone).toBe(true);
    // The stream's own disconnect asks again; nothing more happens.
    await expect(rooms.hooks.handOver(call)).resolves.toBe(true);
    expect(carrier.hangupLeg).toHaveBeenCalledTimes(1);
    await status("agent", "completed");
    expect(manager.endCall).not.toHaveBeenCalled();
    await status("owner", "completed");
    expect(manager.endCall).toHaveBeenCalledWith("call-1", { reason: "hangup-user" });
  });

  it("does not hand over without the owner in the room", async () => {
    const call = makeCall({ agentCallSid: "CA-agent", owner: "no-answer" });
    const { rooms, carrier } = setup(call);
    await expect(rooms.hooks.handOver(call)).resolves.toBe(false);
    expect(carrier.hangupLeg).not.toHaveBeenCalled();
  });

  it("ends the call when Jarvis's leg drops with only the callee left", async () => {
    const call = makeCall({ agentCallSid: "CA-agent" });
    const { manager, status } = setup(call);
    await status("agent", "failed");
    expect(manager.endCall).toHaveBeenCalledWith("call-1", { reason: "error" });
  });

  it("answers Jarvis's App leg with the stream for the callee's call", async () => {
    const call = makeCall({});
    const { rooms } = setup(call);
    const agentStream = vi.fn(() => ({ statusCode: 200, body: "<Connect/>" }));
    const form = new URLSearchParams({ callId: "call-1", leg: "agent", CallSid: "CA-app" });
    await expect(rooms.routeWebhook({ leg: "agent" }, form, agentStream)).resolves.toEqual({
      statusCode: 200,
      body: "<Connect/>",
    });
    expect(agentStream).toHaveBeenCalledWith({ callId: "call-1", providerCallId: "CA-callee" });
    await expect(
      rooms.routeWebhook({ callId: "call-1" }, new URLSearchParams(), agentStream),
    ).resolves.toBeUndefined();
  });

  it("hangs up an App leg for a call that has ended", async () => {
    const call = makeCall({}, { state: "completed" });
    const { rooms } = setup(call);
    const agentStream = vi.fn();
    const response = await rooms.routeWebhook(
      { leg: "agent" },
      new URLSearchParams({ callId: "call-1" }),
      agentStream,
    );
    expect(response?.body).toContain("<Hangup/>");
    expect(agentStream).not.toHaveBeenCalled();
  });

  it("hangs up the legs it added once the call ends", async () => {
    const call = makeCall({ agentCallSid: "CA-agent", ownerCallSid: "CA-owner" });
    const { rooms, carrier, releaseHold } = setup(call);
    rooms.observe(call);
    expect(carrier.hangupLeg).not.toHaveBeenCalled();
    call.state = "completed";
    rooms.observe(call);
    rooms.observe(call);
    expect(carrier.hangupLeg.mock.calls).toEqual([["CA-agent"], ["CA-owner"]]);
    expect(releaseHold).toHaveBeenCalledWith("call-1");
  });
});
