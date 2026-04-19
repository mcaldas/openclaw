/**
 * End-to-end integration test for the realtime voice bridge.
 *
 * Stands up a fake provider bridge (stands in for the Azure realtime
 * WS) plus a fake iOS WS and drives a full tool-call round-trip
 * through the real `createTalkRealtimeSession` + `createToolDispatcher`
 * + `createDefaultTalkRealtimeBridgeFactory` composition. Asserts the
 * iOS WS observes `response.tool_call.started` then
 * `response.tool_call.finished`, and that the provider bridge observes
 * a `submitToolResult` with the tool's text output.
 */

import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RealtimeVoiceProviderPlugin } from "../../plugins/types.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCallbacks,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceTool,
  RealtimeVoiceToolCallEvent,
} from "../../realtime-voice/provider-types.js";
import { createDefaultTalkRealtimeBridgeFactory } from "./bridge-factory.js";
import { createTalkRealtimeSession } from "./session.js";
import type { TalkRealtimeTicket } from "./ticket-registry.js";

type ProviderFake = {
  bridge: RealtimeVoiceBridge;
  capturedCreateReq: RealtimeVoiceBridgeCreateRequest;
  /** Simulate an Azure-side tool call arriving. */
  fireToolCall: (event: RealtimeVoiceToolCallEvent) => void;
  /** Records of calls the bridge forwarded to the fake Azure WS. */
  submitted: Array<{ callId: string; result: unknown }>;
};

function makeProviderPlugin(onCreate?: (req: RealtimeVoiceBridgeCreateRequest) => void): {
  plugin: RealtimeVoiceProviderPlugin;
  getFake: () => ProviderFake | null;
} {
  let fake: ProviderFake | null = null;
  const plugin: RealtimeVoiceProviderPlugin = {
    id: "openai",
    label: "Fake OpenAI Realtime",
    createBridge: (req: RealtimeVoiceBridgeCreateRequest) => {
      onCreate?.(req);
      let callbacks: RealtimeVoiceBridgeCallbacks = req;
      const submitted: Array<{ callId: string; result: unknown }> = [];
      const bridge: RealtimeVoiceBridge = {
        connect: async () => {
          // Emit onReady asynchronously to match the real bridge's
          // timing: `session.update` goes out first, then upstream is
          // ready for conversation items.
          queueMicrotask(() => callbacks.onReady?.());
        },
        sendAudio: vi.fn(),
        setMediaTimestamp: vi.fn(),
        sendConversationItem: vi.fn(),
        submitToolResult: (callId, result) => {
          submitted.push({ callId, result });
        },
        acknowledgeMark: vi.fn(),
        close: vi.fn(),
        isConnected: () => true,
      };
      fake = {
        bridge,
        capturedCreateReq: req,
        fireToolCall: (event) => {
          callbacks.onToolCall?.(event);
        },
        submitted,
      };
      // Rebind callbacks on subsequent create calls (not used here, but
      // cheap to keep symmetric with reconnect paths).
      callbacks = req;
      return bridge;
    },
  } as unknown as RealtimeVoiceProviderPlugin;
  return { plugin, getFake: () => fake };
}

function makeClientWs(): {
  ws: WebSocket;
  sent: string[];
} {
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    send: (data: string | Buffer) => {
      sent.push(typeof data === "string" ? data : data.toString("utf8"));
    },
    close: vi.fn(),
  } as unknown as WebSocket;
  return { ws, sent };
}

function makeTicket(): TalkRealtimeTicket {
  return {
    ticket: "t",
    voiceRunId: "run-integration-1",
    agentId: "main",
    operatorConnId: "conn-integration",
    sessionKey: "agent:main:main",
    issuedAtMs: 1,
    expiresAtMs: 60_000,
  };
}

function makeFakeTool(
  name: string,
  handler: (args: unknown) => Promise<string> = async () => "ok",
): AnyAgentTool {
  return {
    name,
    label: name,
    description: `Fake ${name}`,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
    },
    execute: async (_callId: string, args: unknown) => ({
      content: [{ type: "text", text: await handler(args) }],
      details: undefined,
    }),
  } as unknown as AnyAgentTool;
}

describe("talk-realtime integration: tool-call round trip", () => {
  it("dispatches an Azure-originated tool call through the agent tool, posts the result to the fake Azure bridge, and surfaces started/finished on the iOS WS", async () => {
    const { plugin, getFake } = makeProviderPlugin();
    const factory = createDefaultTalkRealtimeBridgeFactory({
      loadConfigFn: () =>
        ({
          talk: {
            provider: "openai",
            providers: { openai: { apiKey: "sk-test" } },
          },
        }) as unknown as OpenClawConfig,
      resolveProviderFn: () => plugin,
      listToolsFn: () => [
        makeFakeTool("lookup", async (args) => {
          const record = (args ?? {}) as { query?: unknown };
          const query =
            typeof record.query === "string" && record.query.length > 0 ? record.query : "(empty)";
          return `result for ${query}`;
        }),
      ],
      loadMemorySnapshotFn: () => [],
    });

    // Wire the session handlers the way the real upgrade host does.
    const { ws, sent } = makeClientWs();
    const ticket = makeTicket();
    let toolStarted: { callId: string; name: string } | null = null;
    let toolFinished: { callId: string; name: string; ok: boolean } | null = null;

    const sessionHandlersForBridge = {
      onAudio: (audio: Buffer) => {
        session.handleAssistantAudio(audio);
      },
      onClearAudio: () => session.handleClearAudio(),
      onTranscript: (role: "user" | "assistant", text: string, isFinal: boolean) =>
        session.handleTranscript(role, text, isFinal),
      onError: vi.fn(),
      onClose: vi.fn(),
      onToolCallStarted: (event: { callId: string; name: string }) => {
        toolStarted = event;
        session.sendServerEvent({
          type: "response.tool_call.started",
          callId: event.callId,
          name: event.name,
        });
      },
      onToolCallFinished: (event: {
        callId: string;
        name: string;
        durationMs: number;
        ok: boolean;
      }) => {
        toolFinished = { callId: event.callId, name: event.name, ok: event.ok };
        session.sendServerEvent({
          type: "response.tool_call.finished",
          callId: event.callId,
          name: event.name,
          durationMs: event.durationMs,
          ok: event.ok,
        });
      },
    };

    const bridge = await factory({ ticket, sessionHandlersForBridge });
    const session = createTalkRealtimeSession({ clientWs: ws, bridge, ticket });
    await bridge.connect();

    // Verify the bridge was configured for voice: pcm16, composed
    // instructions, one tool advertised to the realtime side.
    const fake = getFake();
    expect(fake).not.toBeNull();
    expect(fake?.capturedCreateReq.audioFormat).toBe("pcm16");
    expect(fake?.capturedCreateReq.instructions).toContain(
      "You are speaking on a live voice call.",
    );
    const advertised = fake?.capturedCreateReq.tools as RealtimeVoiceTool[];
    expect(advertised.map((t) => t.name)).toEqual(["lookup"]);

    // Simulate the upstream realtime model emitting a tool call.
    fake?.fireToolCall({
      itemId: "item-1",
      callId: "call-xyz",
      name: "lookup",
      args: { query: "apollo" },
    });

    // Drain the microtask queue; tool dispatch is async.
    await new Promise((r) => setTimeout(r, 0));

    // Provider bridge received the result.
    expect(fake?.submitted).toEqual([{ callId: "call-xyz", result: "result for apollo" }]);

    // iOS WS observed the started + finished events.
    const iosFrames = sent.map((s) => JSON.parse(s));
    const started = iosFrames.find((f) => f.type === "response.tool_call.started");
    const finished = iosFrames.find((f) => f.type === "response.tool_call.finished");
    expect(started).toMatchObject({ callId: "call-xyz", name: "lookup" });
    expect(finished).toMatchObject({
      callId: "call-xyz",
      name: "lookup",
      ok: true,
    });
    expect(toolStarted).toEqual({ callId: "call-xyz", name: "lookup" });
    expect(toolFinished).toMatchObject({
      callId: "call-xyz",
      name: "lookup",
      ok: true,
    });
  });

  it("short-circuits voice-disabled tools with a spoken-hint payload and still emits started+finished", async () => {
    const { plugin, getFake } = makeProviderPlugin();
    const factory = createDefaultTalkRealtimeBridgeFactory({
      loadConfigFn: () =>
        ({
          talk: {
            provider: "openai",
            providers: { openai: { apiKey: "sk-test" } },
          },
        }) as unknown as OpenClawConfig,
      resolveProviderFn: () => plugin,
      // `exec` is in VOICE_DISABLED_TOOL_NAMES; we include it here to
      // prove that if the realtime model emits a call for it (perhaps
      // because a stale schema advertised it), the dispatcher blocks
      // the execution and returns the spoken hint.
      listToolsFn: () => [makeFakeTool("exec", async () => "SHOULD NOT RUN")],
      loadMemorySnapshotFn: () => [],
    });
    const { ws, sent } = makeClientWs();
    const sessionHandlersForBridge = {
      onAudio: () => {},
      onClearAudio: () => {},
      onTranscript: () => {},
      onError: vi.fn(),
      onClose: vi.fn(),
      onToolCallStarted: (event: { callId: string; name: string }) => {
        session.sendServerEvent({
          type: "response.tool_call.started",
          callId: event.callId,
          name: event.name,
        });
      },
      onToolCallFinished: (event: {
        callId: string;
        name: string;
        durationMs: number;
        ok: boolean;
      }) => {
        session.sendServerEvent({
          type: "response.tool_call.finished",
          callId: event.callId,
          name: event.name,
          durationMs: event.durationMs,
          ok: event.ok,
        });
      },
    };
    const bridge = await factory({ ticket: makeTicket(), sessionHandlersForBridge });
    const session = createTalkRealtimeSession({ clientWs: ws, bridge, ticket: makeTicket() });
    await bridge.connect();

    const fake = getFake();
    fake?.fireToolCall({
      itemId: "item-2",
      callId: "call-exec",
      name: "exec",
      args: { cmd: "rm -rf /" },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(fake?.submitted).toHaveLength(1);
    expect(fake?.submitted[0]?.result).toEqual({
      error: "approval_required",
      tool: "exec",
      message: "For that I'd need to run exec. Easiest to switch to chat and I'll do it there.",
      spokenHint: true,
    });

    const iosFrames = sent.map((s) => JSON.parse(s));
    expect(iosFrames.map((f) => f.type)).toEqual(
      expect.arrayContaining(["response.tool_call.started", "response.tool_call.finished"]),
    );
    const finished = iosFrames.find((f) => f.type === "response.tool_call.finished");
    // `ok` is true because the dispatcher produced a deterministic
    // spoken-hint output; it's not an infrastructure error.
    expect(finished).toMatchObject({ ok: true });
  });
});
