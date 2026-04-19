import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RealtimeVoiceProviderPlugin } from "../../plugins/types.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
} from "../../realtime-voice/provider-types.js";
import { createDefaultTalkRealtimeBridgeFactory } from "./bridge-factory.js";
import type { TalkRealtimeTicket } from "./ticket-registry.js";

function makeTicket(): TalkRealtimeTicket {
  return {
    ticket: "t",
    voiceRunId: "run-1",
    agentId: "main",
    operatorConnId: "conn-1",
    sessionKey: "agent:main:default",
    issuedAtMs: 1,
    expiresAtMs: 1_000,
  };
}

function makeBridge(): RealtimeVoiceBridge {
  return {
    connect: vi.fn(async () => {}),
    sendAudio: vi.fn(),
    setMediaTimestamp: vi.fn(),
    submitToolResult: vi.fn(),
    acknowledgeMark: vi.fn(),
    close: vi.fn(),
    isConnected: () => true,
  };
}

describe("createDefaultTalkRealtimeBridgeFactory", () => {
  it("passes pcm16, a composed instructions string, and marshalled tools to the provider createBridge", async () => {
    const captured: RealtimeVoiceBridgeCreateRequest[] = [];
    const fakeBridge = makeBridge();
    const plugin: RealtimeVoiceProviderPlugin = {
      id: "openai",
      label: "Fake OpenAI",
      createBridge: (req: RealtimeVoiceBridgeCreateRequest) => {
        captured.push(req);
        return fakeBridge;
      },
      resolveConfig: undefined,
      isConfigured: undefined,
    } as unknown as RealtimeVoiceProviderPlugin;
    const loadConfigFn: () => OpenClawConfig = () =>
      ({
        talk: {
          provider: "openai",
          providers: {
            openai: { apiKey: "sk-test", model: "gpt-realtime-1-5" },
          },
        },
      }) as unknown as OpenClawConfig;

    const factory = createDefaultTalkRealtimeBridgeFactory({
      loadConfigFn,
      resolveProviderFn: () => plugin,
      listToolsFn: () => [
        {
          name: "read",
          description: "Read a file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        } as never,
      ],
      loadMemorySnapshotFn: () => [],
    });
    const bridge = await factory({
      ticket: makeTicket(),
      sessionHandlersForBridge: {
        onAudio: () => {},
        onClearAudio: () => {},
        onTranscript: () => {},
        onError: () => {},
        onClose: () => {},
      },
    });

    expect(bridge).toBe(fakeBridge);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.audioFormat).toBe("pcm16");
    expect(captured[0]?.instructions).toContain("You are speaking on a live voice call.");
    expect(captured[0]?.tools).toEqual([
      {
        type: "function",
        name: "read",
        description: "Read a file.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ]);
    expect(captured[0]?.providerConfig).toMatchObject({ model: "gpt-realtime-1-5" });
  });

  it("seeds the memory snapshot via sendConversationItem on bridge onReady", async () => {
    const seeded: Array<{ role: string; text: string }> = [];
    const fakeBridge: RealtimeVoiceBridge & {
      sendConversationItem?: (item: {
        role: "user" | "assistant" | "system";
        content: Array<{ text: string }>;
      }) => void;
    } = {
      connect: vi.fn(async () => {}),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: () => true,
      sendConversationItem: (item) => {
        seeded.push({
          role: item.role,
          text: item.content[0]?.text ?? "",
        });
      },
    };
    const plugin: RealtimeVoiceProviderPlugin = {
      id: "openai",
      label: "Fake OpenAI",
      createBridge: (req: RealtimeVoiceBridgeCreateRequest) => {
        // Simulate the real bridge: on createBridge we stash onReady and
        // fire it once to mimic session.update having completed.
        queueMicrotask(() => req.onReady?.());
        return fakeBridge;
      },
      resolveConfig: undefined,
      isConfigured: undefined,
    } as unknown as RealtimeVoiceProviderPlugin;
    const factory = createDefaultTalkRealtimeBridgeFactory({
      loadConfigFn: () =>
        ({
          talk: {
            provider: "openai",
            providers: { openai: { apiKey: "sk-test" } },
          },
        }) as unknown as OpenClawConfig,
      resolveProviderFn: () => plugin,
      listToolsFn: () => [],
      loadMemorySnapshotFn: () => [
        {
          type: "conversation.item.create" as const,
          item: {
            type: "message" as const,
            role: "user" as const,
            content: [{ type: "input_text" as const, text: "earlier user turn" }],
          },
        },
        {
          type: "conversation.item.create" as const,
          item: {
            type: "message" as const,
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "earlier assistant turn" }],
          },
        },
      ],
    });
    await factory({
      ticket: makeTicket(),
      sessionHandlersForBridge: {
        onAudio: () => {},
        onClearAudio: () => {},
        onTranscript: () => {},
        onError: () => {},
        onClose: () => {},
      },
    });
    // Yield so the queued onReady microtask fires.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seeded).toEqual([
      { role: "user", text: "earlier user turn" },
      { role: "assistant", text: "earlier assistant turn" },
    ]);
  });

  it("throws when no talk provider is configured", async () => {
    const factory = createDefaultTalkRealtimeBridgeFactory({
      loadConfigFn: () => ({ talk: undefined }) as unknown as OpenClawConfig,
      resolveProviderFn: () => undefined,
      listToolsFn: () => [],
      loadMemorySnapshotFn: () => [],
    });
    await expect(
      factory({
        ticket: makeTicket(),
        sessionHandlersForBridge: {
          onAudio: () => {},
          onClearAudio: () => {},
          onTranscript: () => {},
          onError: () => {},
          onClose: () => {},
        },
      }),
    ).rejects.toThrow(/no active talk provider/);
  });

  it("throws when the configured provider is not registered as realtime-voice", async () => {
    const factory = createDefaultTalkRealtimeBridgeFactory({
      loadConfigFn: () =>
        ({
          talk: {
            provider: "openai",
            providers: { openai: { apiKey: "sk-test" } },
          },
        }) as unknown as OpenClawConfig,
      resolveProviderFn: () => undefined,
      listToolsFn: () => [],
      loadMemorySnapshotFn: () => [],
    });
    await expect(
      factory({
        ticket: makeTicket(),
        sessionHandlersForBridge: {
          onAudio: () => {},
          onClearAudio: () => {},
          onTranscript: () => {},
          onError: () => {},
          onClose: () => {},
        },
      }),
    ).rejects.toThrow(/not registered/);
  });
});
