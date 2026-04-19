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
  it("passes pcm16 and empty instructions/tools to the provider createBridge", async () => {
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
    expect(captured[0]?.instructions).toBe("");
    expect(captured[0]?.tools).toEqual([]);
    expect(captured[0]?.providerConfig).toMatchObject({ model: "gpt-realtime-1-5" });
  });

  it("throws when no talk provider is configured", async () => {
    const factory = createDefaultTalkRealtimeBridgeFactory({
      loadConfigFn: () => ({ talk: undefined }) as unknown as OpenClawConfig,
      resolveProviderFn: () => undefined,
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
