import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { RealtimeVoiceBridge } from "../../realtime-voice/provider-types.js";
import { TALK_REALTIME_AUDIO, TALK_REALTIME_CLOSE } from "./protocol.js";
import { createTalkRealtimeSession } from "./session.js";
import type { TalkRealtimeTicket } from "./ticket-registry.js";

type Sent = string | Buffer;

function makeFakeWs(): {
  ws: WebSocket;
  sent: Sent[];
  closed: Array<{ code: number; reason: string }>;
  setReadyState: (state: number) => void;
} {
  const sent: Sent[] = [];
  const closed: Array<{ code: number; reason: string }> = [];
  let readyState = 1; // OPEN
  const ws = {
    get readyState() {
      return readyState;
    },
    send: (data: string | Buffer) => {
      sent.push(data);
    },
    close: (code: number, reason: string) => {
      closed.push({ code, reason });
      readyState = 3; // CLOSED
    },
  } as unknown as WebSocket;
  return {
    ws,
    sent,
    closed,
    setReadyState: (state: number) => {
      readyState = state;
    },
  };
}

function makeFakeBridge(): RealtimeVoiceBridge & { _sent: Buffer[] } {
  const _sent: Buffer[] = [];
  const bridge: RealtimeVoiceBridge & { _sent: Buffer[] } = {
    _sent,
    connect: vi.fn(async () => {}),
    sendAudio: (audio: Buffer) => {
      _sent.push(audio);
    },
    setMediaTimestamp: vi.fn(),
    submitToolResult: vi.fn(),
    acknowledgeMark: vi.fn(),
    close: vi.fn(),
    isConnected: () => true,
  };
  return bridge;
}

function makeTicket(overrides: Partial<TalkRealtimeTicket> = {}): TalkRealtimeTicket {
  const now = 1_000_000;
  return {
    ticket: "t-1",
    voiceRunId: "run-1",
    agentId: "main",
    operatorConnId: "conn-1",
    sessionKey: "agent:main:default",
    issuedAtMs: now,
    expiresAtMs: now + 60_000,
    ...overrides,
  };
}

function decodeSent(sent: Sent[]): unknown[] {
  return sent.map((s) => JSON.parse(typeof s === "string" ? s : s.toString("utf8")));
}

describe("createTalkRealtimeSession", () => {
  it("announces session.ready on creation", () => {
    const fakeWs = makeFakeWs();
    const bridge = makeFakeBridge();
    const ticket = makeTicket();
    createTalkRealtimeSession({ clientWs: fakeWs.ws, bridge, ticket });
    const decoded = decodeSent(fakeWs.sent);
    expect(decoded).toEqual([
      {
        type: "session.ready",
        voiceRunId: ticket.voiceRunId,
        sessionKey: ticket.sessionKey,
        audio: TALK_REALTIME_AUDIO,
      },
    ]);
  });

  it("forwards base64-decoded audio appends to the bridge", () => {
    const fakeWs = makeFakeWs();
    const bridge = makeFakeBridge();
    const session = createTalkRealtimeSession({
      clientWs: fakeWs.ws,
      bridge,
      ticket: makeTicket(),
    });
    session.handleClientFrame(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: Buffer.from([1, 2, 3, 4]).toString("base64"),
      }),
    );
    expect(bridge._sent).toHaveLength(1);
    expect(Array.from(bridge._sent[0].values())).toEqual([1, 2, 3, 4]);
  });

  it("echoes ping with the supplied timestamp", () => {
    const fakeWs = makeFakeWs();
    const bridge = makeFakeBridge();
    const session = createTalkRealtimeSession({
      clientWs: fakeWs.ws,
      bridge,
      ticket: makeTicket(),
    });
    session.handleClientFrame(JSON.stringify({ type: "ping", ts: 123 }));
    const decoded = decodeSent(fakeWs.sent);
    expect(decoded[decoded.length - 1]).toEqual({ type: "ping", ts: 123 });
  });

  it("emits invalid_frame errors but does not tear down", () => {
    const fakeWs = makeFakeWs();
    const bridge = makeFakeBridge();
    const session = createTalkRealtimeSession({
      clientWs: fakeWs.ws,
      bridge,
      ticket: makeTicket(),
    });
    session.handleClientFrame("not json at all");
    const decoded = decodeSent(fakeWs.sent);
    expect(decoded[decoded.length - 1]).toMatchObject({
      type: "error",
      code: "invalid_frame",
      recoverable: true,
    });
    expect(bridge.close).not.toHaveBeenCalled();
  });

  it("handleAssistantAudio encodes as base64 response.audio.delta", () => {
    const fakeWs = makeFakeWs();
    const bridge = makeFakeBridge();
    const session = createTalkRealtimeSession({
      clientWs: fakeWs.ws,
      bridge,
      ticket: makeTicket(),
    });
    session.handleAssistantAudio(Buffer.from([0x10, 0x20, 0x30]));
    const decoded = decodeSent(fakeWs.sent);
    expect(decoded[decoded.length - 1]).toEqual({
      type: "response.audio.delta",
      audio: Buffer.from([0x10, 0x20, 0x30]).toString("base64"),
    });
  });

  it("handleTranscript splits user partial vs final and assistant delta vs done", () => {
    const fakeWs = makeFakeWs();
    const bridge = makeFakeBridge();
    const session = createTalkRealtimeSession({
      clientWs: fakeWs.ws,
      bridge,
      ticket: makeTicket(),
    });
    session.handleTranscript("user", "hel", false);
    session.handleTranscript("user", "hello", true);
    session.handleTranscript("assistant", "hi", false);
    session.handleTranscript("assistant", "hi there", true);
    const decoded = decodeSent(fakeWs.sent).slice(1); // drop session.ready
    expect(decoded).toEqual([
      {
        type: "conversation.item.input_audio_transcription.partial",
        text: "hel",
      },
      {
        type: "conversation.item.input_audio_transcription.final",
        text: "hello",
      },
      { type: "response.output_text.delta", text: "hi" },
      { type: "response.output_text.done", text: "hi there" },
    ]);
  });

  it("session.end closes the WS with SESSION_ENDED code and tears down the bridge", () => {
    const fakeWs = makeFakeWs();
    const bridge = makeFakeBridge();
    const onClosed = vi.fn();
    const session = createTalkRealtimeSession({
      clientWs: fakeWs.ws,
      bridge,
      ticket: makeTicket(),
      onClosed,
    });
    session.handleClientFrame(JSON.stringify({ type: "session.end", reason: "user_cancel" }));
    expect(bridge.close).toHaveBeenCalledTimes(1);
    expect(fakeWs.closed).toEqual([
      { code: TALK_REALTIME_CLOSE.SESSION_ENDED, reason: "session_ended" },
    ]);
    expect(onClosed).toHaveBeenCalledWith("session_ended");
  });

  it("close is idempotent", () => {
    const fakeWs = makeFakeWs();
    const bridge = makeFakeBridge();
    const onClosed = vi.fn();
    const session = createTalkRealtimeSession({
      clientWs: fakeWs.ws,
      bridge,
      ticket: makeTicket(),
      onClosed,
    });
    session.close("session_ended");
    session.close("session_ended");
    expect(bridge.close).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it("replaced_by_newer close emits the REPLACED_BY_NEWER code", () => {
    const fakeWs = makeFakeWs();
    const bridge = makeFakeBridge();
    const session = createTalkRealtimeSession({
      clientWs: fakeWs.ws,
      bridge,
      ticket: makeTicket(),
    });
    session.close("replaced_by_newer");
    expect(fakeWs.closed[0]?.code).toBe(TALK_REALTIME_CLOSE.REPLACED_BY_NEWER);
  });

  it("drops outbound frames when the WS is not OPEN", () => {
    const fakeWs = makeFakeWs();
    fakeWs.setReadyState(3); // CLOSED before anything is constructed
    const bridge = makeFakeBridge();
    createTalkRealtimeSession({ clientWs: fakeWs.ws, bridge, ticket: makeTicket() });
    expect(fakeWs.sent).toHaveLength(0);
  });
});
