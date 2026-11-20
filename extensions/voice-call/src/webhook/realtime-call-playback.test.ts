import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeDtmfMulaw } from "../dtmf-tones.js";
import { createRealtimeCallPlayback } from "./realtime-call-playback.js";

type PlaybackParams = Parameters<typeof createRealtimeCallPlayback>[0];

function createPlayback() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
  const sent: string[] = [];
  const ws = {
    readyState: WebSocket.OPEN as number,
    bufferedAmount: 0,
    send: (message: string) => sent.push(message),
    close: vi.fn(),
  };
  const harness = {
    talk: { outputAudioActive: false, activeTurnId: undefined, cancelTurn: vi.fn() },
    finishOutputAudio: vi.fn(),
    recordOutputAudio: vi.fn(),
    flushOutput: (flush: () => void) => flush(),
  };
  const playback = createRealtimeCallPlayback({
    ws: ws as unknown as PlaybackParams["ws"],
    callRecord: { callId: "call-1" } as PlaybackParams["callRecord"],
    callSid: "CA-1",
    adapter: {
      serializeMedia: (payload: string) => `media:${payload}`,
      serializeClear: () => "clear",
      serializeMark: (name: string) => `mark:${name}`,
    } as unknown as PlaybackParams["adapter"],
    harness: harness as unknown as PlaybackParams["harness"],
    hostOwnsOpening: false,
    getSession: () => undefined,
    isClosed: () => false,
    closeForInactivity: vi.fn(),
  });
  return { playback, sent, ws };
}

function mediaAudio(messages: string[]): Buffer {
  return Buffer.concat(
    messages
      .filter((message) => message.startsWith("media:"))
      .map((message) => Buffer.from(message.slice("media:".length), "base64")),
  );
}

afterEach(() => vi.useRealTimers());

describe("realtime call keypad tones", () => {
  it("keeps the tones whole through barge-in while dropping model speech around them", async () => {
    const { playback, sent } = createPlayback();
    const { audioSink, cancelOutputAudioForBargeIn, playKeypadTones } = playback.audioController;
    // 400 ms of speech: the first 160 ms goes out at once as the carrier lead, the rest queues.
    audioSink.sendAudio(Buffer.alloc(20 * 160, 0x55), { itemId: "model-1" });
    const played = playKeypadTones("1#");
    audioSink.sendAudio(Buffer.alloc(160, 0x66), { itemId: "model-2" });

    cancelOutputAudioForBargeIn("local");
    expect(playback.audioPacer.clearAudio()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sent).not.toContain("clear");
    const markIndex = sent.findIndex((message) => message.startsWith("mark:openclaw-keypad-"));
    expect(mediaAudio(sent.slice(0, markIndex))).toEqual(
      Buffer.concat([Buffer.alloc(8 * 160, 0x55), encodeDtmfMulaw("1#")]),
    );
    expect(mediaAudio(sent.slice(markIndex))).toHaveLength(0);

    playback.pendingMarkAcks.get(sent[markIndex]?.slice("mark:".length) ?? "")?.();
    await expect(played).resolves.toEqual({ durationMs: 480, confirmed: true });
    playback.audioPacer.clearAudio();
    expect(sent.at(-1)).toBe("clear");
  });

  it("plays model speech that arrives during the tones after them", async () => {
    const { playback, sent } = createPlayback();
    void playback.audioController.playKeypadTones("5");
    playback.audioController.audioSink.sendAudio(Buffer.alloc(160, 0x66), { itemId: "model-1" });
    await vi.advanceTimersByTimeAsync(1_000);

    const markIndex = sent.findIndex((message) => message.startsWith("mark:openclaw-keypad-"));
    expect(mediaAudio(sent.slice(0, markIndex))).toEqual(encodeDtmfMulaw("5"));
    expect(mediaAudio(sent.slice(markIndex))).toEqual(Buffer.alloc(160, 0x66));
  });

  it("fails at once when the stream closes under the tones", async () => {
    const { playback } = createPlayback();
    const played = playback.audioController.playKeypadTones("1234#");
    await vi.advanceTimersByTimeAsync(100);
    playback.audioPacer.close();

    await expect(played).rejects.toThrow("closed before the keypad tones finished");
  });

  it("waits for queued speech before the unconfirmed-playout grace starts", async () => {
    const { playback, sent } = createPlayback();
    playback.audioController.audioSink.sendAudio(Buffer.alloc(8_000 * 20, 0x55), { itemId: "m" });
    let settled = false;
    const played = playback.audioController.playKeypadTones("5").finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(20_000 + 240 + 4_000);
    expect(settled).toBe(false);
    playback.audioPacer.clearAudio();
    expect(sent).not.toContain("clear");
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(played).resolves.toEqual({ durationMs: 240, confirmed: false });
  });

  it("refuses tones on a closed stream, with invalid keys, or past 20 seconds", async () => {
    const { playback, ws } = createPlayback();
    const { playKeypadTones } = playback.audioController;
    expect(() => playKeypadTones("1x")).toThrow(/digits may only contain/);
    expect(() => playKeypadTones("1".repeat(84))).toThrow(/send at most 20000 ms/);
    ws.readyState = WebSocket.CLOSED;
    await expect(playKeypadTones("1")).rejects.toThrow("Realtime call stream is closed");
  });
});
