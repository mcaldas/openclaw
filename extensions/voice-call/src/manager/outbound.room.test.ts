import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { describe, expect, it, vi } from "vitest";
import { CallRecordSchema, type CallRecord, type InitiateCallInput } from "../types.js";

const { persist } = vi.hoisted(() => ({ persist: vi.fn() }));
// mock-isolation: Observe outbound persistence without opening the call database.
vi.mock("./store.js", () => ({ persistCallRecord: persist }));

import { endCall, initiateCall, sendDtmf } from "./outbound.js";

const APP = `AP${"b".repeat(32)}`;

function baseContext(call?: CallRecord) {
  return {
    mutationQueue: new KeyedAsyncQueue(),
    isStopping: () => false,
    trackCallWork: vi.fn(),
    notifyHangupTimers: new Map(),
    pendingCallAdmissions: new Set<string>(),
    activeCalls: new Map<string, CallRecord>(call ? [[call.callId, call]] : []),
    providerCallIdMap: new Map<string, string>(),
    transcriptWaiters: new Map(),
    maxDurationTimers: new Map(),
    endCallOperations: new Map(),
    initialMessageInFlight: new Set<string>(),
    activeTurnCalls: new Set<string>(),
    storePath: "/tmp/voice-call.json",
  };
}

function roomCall(room: Record<string, unknown> | undefined = { name: "oc-call-1" }) {
  return CallRecordSchema.parse({
    callId: "call-1",
    providerCallId: "CA-callee",
    provider: "twilio",
    direction: "outbound",
    state: "active",
    from: "+972500000002",
    to: "+972500000003",
    startedAt: Date.now(),
    transcript: [],
    processedEventIds: [],
    metadata: room ? { room } : {},
  });
}

function roomHooks(overrides: Record<string, unknown> = {}) {
  return {
    onAnswered: vi.fn(),
    pressKeys: vi.fn(async () => "sent" as const),
    handOver: vi.fn(async () => false),
    ...overrides,
  };
}

describe("room calls in the outbound flow", () => {
  function dial(room: Record<string, unknown>, roomApi: unknown = {}) {
    const initiateProviderCall = vi.fn(async (_input: InitiateCallInput) => ({
      providerCallId: "CA-callee",
    }));
    const ctx = {
      ...baseContext(),
      config: {
        maxConcurrentCalls: 3,
        outbound: { defaultMode: "conversation" },
        fromNumber: "+972500000002",
        realtime: { enabled: true },
        room,
      },
      webhookUrl: "https://example.com/webhook",
      provider: { name: "twilio", initiateCall: initiateProviderCall, room: roomApi },
    };
    return { ctx, initiateProviderCall };
  }

  it("dials the callee into a room named after the call", async () => {
    const { ctx, initiateProviderCall } = dial({ enabled: true, twimlAppSid: APP });
    const result = await initiateCall(ctx as never, "+972500000003");
    expect(result.success).toBe(true);
    const input = initiateProviderCall.mock.calls[0]?.[0];
    expect(input?.room).toBe(`oc-${result.callId}`);
    expect(ctx.activeCalls.get(result.callId)?.metadata?.room).toEqual({
      name: `oc-${result.callId}`,
    });
  });

  it("keeps notify calls, pre-dial keys and muted-off rooms apart", async () => {
    const notify = dial({ enabled: true, twimlAppSid: APP });
    await initiateCall(notify.ctx as never, "+972500000003", undefined, {
      mode: "notify",
      message: "hi",
    });
    expect(notify.initiateProviderCall.mock.calls[0]?.[0].room).toBeUndefined();

    const keys = dial({ enabled: true, twimlAppSid: APP });
    await initiateCall(keys.ctx as never, "+972500000003", undefined, { dtmfSequence: "1" });
    expect(keys.initiateProviderCall.mock.calls[0]?.[0].room).toBeUndefined();

    const unmuted = dial({ enabled: true, twimlAppSid: APP, muteHoldMusic: false });
    const placed = await initiateCall(unmuted.ctx as never, "+972500000003");
    expect(unmuted.ctx.activeCalls.get(placed.callId)?.metadata?.room).toMatchObject({
      muteHold: false,
    });
  });

  it("does not use a room when the provider has none", async () => {
    const { ctx, initiateProviderCall } = dial({ enabled: true, twimlAppSid: APP }, null);
    await initiateCall(ctx as never, "+972500000003");
    expect(initiateProviderCall.mock.calls[0]?.[0].room).toBeUndefined();
  });

  it("presses keys through the room and logs them once", async () => {
    const call = roomCall();
    const room = roomHooks();
    const playRealtimeKeypadTones = vi.fn();
    const ctx = {
      ...baseContext(call),
      provider: { name: "twilio" },
      config: {},
      room,
      playRealtimeKeypadTones,
    };
    await expect(sendDtmf(ctx as never, "call-1", "1", { inBandOnly: true })).resolves.toEqual({
      success: true,
    });
    expect(room.pressKeys).toHaveBeenCalledWith(call, "1");
    expect(playRealtimeKeypadTones).not.toHaveBeenCalled();
    expect(call.transcript.map((entry) => entry.text)).toEqual(["[pressed 1]"]);

    room.pressKeys.mockResolvedValueOnce("duplicate" as never);
    await sendDtmf(ctx as never, "call-1", "1", { inBandOnly: true });
    expect(call.transcript).toHaveLength(1);

    room.pressKeys.mockRejectedValueOnce(new Error("Still pressing the previous keys"));
    await expect(sendDtmf(ctx as never, "call-1", "2")).resolves.toEqual({
      success: false,
      error: "Still pressing the previous keys",
    });
    await expect(sendDtmf(ctx as never, "call-1", "x")).resolves.toMatchObject({ success: false });
  });

  it("only drops Jarvis when the room hands over, and ends normally otherwise", async () => {
    const call = roomCall({ name: "oc-call-1", owner: "in-room" });
    const hangupCall = vi.fn(async () => {});
    const room = roomHooks({ handOver: vi.fn(async () => true) });
    const ctx = { ...baseContext(call), provider: { name: "twilio", hangupCall }, room };
    await expect(endCall(ctx as never, "call-1")).resolves.toEqual({ success: true });
    expect(hangupCall).not.toHaveBeenCalled();
    expect(ctx.activeCalls.has("call-1")).toBe(true);

    room.handOver = vi.fn(async () => false);
    await expect(endCall(ctx as never, "call-1")).resolves.toEqual({ success: true });
    expect(hangupCall).toHaveBeenCalledWith({
      callId: "call-1",
      providerCallId: "CA-callee",
      reason: "hangup-bot",
    });
  });
});
