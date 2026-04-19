import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { talkHandlers } from "./talk.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn<() => OpenClawConfig>(),
  readConfigFileSnapshot: vi.fn(),
  canonicalizeSpeechProviderId: vi.fn((providerId: string | undefined) => providerId),
  getSpeechProvider: vi.fn(),
  synthesizeSpeech: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../../tts/provider-registry.js", () => ({
  canonicalizeSpeechProviderId: mocks.canonicalizeSpeechProviderId,
  getSpeechProvider: mocks.getSpeechProvider,
}));

vi.mock("../../tts/tts.js", () => ({
  synthesizeSpeech: mocks.synthesizeSpeech,
}));

function createTalkConfig(apiKey: unknown): OpenClawConfig {
  return {
    talk: {
      provider: "acme",
      providers: {
        acme: {
          apiKey,
          voiceId: "stub-default-voice",
        },
      },
    },
  } as OpenClawConfig;
}

describe("talk.speak handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the active runtime config snapshot instead of the raw config snapshot", async () => {
    const runtimeConfig = createTalkConfig("env-acme-key");
    const diskConfig = createTalkConfig({
      source: "env",
      provider: "default",
      id: "ACME_SPEECH_API_KEY",
    });

    mocks.loadConfig.mockReturnValue(runtimeConfig);
    mocks.readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/openclaw.json",
      hash: "test-hash",
      valid: true,
      config: diskConfig,
    });
    mocks.getSpeechProvider.mockReturnValue({
      id: "acme",
      label: "Acme Speech",
      resolveTalkConfig: ({
        talkProviderConfig,
      }: {
        talkProviderConfig: Record<string, unknown>;
      }) => talkProviderConfig,
    });
    mocks.synthesizeSpeech.mockImplementation(
      async ({ cfg }: { cfg: OpenClawConfig; text: string; disableFallback: boolean }) => {
        expect(cfg.messages?.tts?.provider).toBe("acme");
        expect(cfg.messages?.tts?.providers?.acme?.apiKey).toBe("env-acme-key");
        return {
          success: true,
          provider: "acme",
          audioBuffer: Buffer.from([1, 2, 3]),
          outputFormat: "mp3",
          voiceCompatible: false,
          fileExtension: ".mp3",
        };
      },
    );

    const respond = vi.fn();
    await talkHandlers["talk.speak"]({
      req: { type: "req", id: "1", method: "talk.speak" },
      params: { text: "Hello from talk mode." },
      client: null,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {} as never,
    });

    expect(mocks.loadConfig).toHaveBeenCalledTimes(1);
    expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(mocks.synthesizeSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Hello from talk mode.",
        disableFallback: true,
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        provider: "acme",
        audioBase64: Buffer.from([1, 2, 3]).toString("base64"),
        outputFormat: "mp3",
        mimeType: "audio/mpeg",
        fileExtension: ".mp3",
      }),
      undefined,
    );
  });
});

describe("talk.realtime.start handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects the call when the ticket registry is not wired", async () => {
    mocks.loadConfig.mockReturnValue({} as OpenClawConfig);
    const respond = vi.fn();
    await talkHandlers["talk.realtime.start"]({
      req: { type: "req", id: "1", method: "talk.realtime.start" },
      params: {},
      client: { connId: "conn-1", connect: { scopes: [] } } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {} as never,
    });
    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, _payload, error] = respond.mock.calls[0];
    expect(ok).toBe(false);
    expect(error).toMatchObject({
      code: expect.any(String),
      message: expect.stringContaining("gateway built without realtime bridge"),
    });
  });

  it("rejects the call when the operator is not connected", async () => {
    mocks.loadConfig.mockReturnValue({} as OpenClawConfig);
    const respond = vi.fn();
    await talkHandlers["talk.realtime.start"]({
      req: { type: "req", id: "1", method: "talk.realtime.start" },
      params: {},
      client: null,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {
        talkRealtimeTicketRegistry: { issue: vi.fn() },
      } as never,
    });
    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, _payload, error] = respond.mock.calls[0];
    expect(ok).toBe(false);
    expect(error.message).toContain("requires connected operator");
  });

  it("mints a ticket bound to the operator connId and the main session key", async () => {
    mocks.loadConfig.mockReturnValue({
      session: { mainKey: "primary" },
    } as OpenClawConfig);
    const issue = vi.fn((input: { voiceRunId: string; agentId: string; sessionKey: string }) => ({
      ticket: "tk-xyz",
      issuedAtMs: 100,
      expiresAtMs: 100 + 60_000,
      ...input,
    }));
    const respond = vi.fn();
    await talkHandlers["talk.realtime.start"]({
      req: { type: "req", id: "1", method: "talk.realtime.start" },
      params: { agentId: "main", providerId: "openai", voiceId: "alloy" },
      client: { connId: "conn-42", connect: { scopes: [] } } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {
        talkRealtimeTicketRegistry: { issue },
      } as never,
    });
    expect(issue).toHaveBeenCalledTimes(1);
    const input = issue.mock.calls[0][0];
    expect(input).toMatchObject({
      agentId: "main",
      operatorConnId: "conn-42",
      sessionKey: "agent:main:primary",
    });
    expect(typeof input.voiceRunId).toBe("string");
    expect(input.voiceRunId.length).toBeGreaterThan(0);
    const [ok, payload] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({
      sessionKey: "agent:main:primary",
      ticket: "tk-xyz",
      wsPath: "/talk/realtime",
      audio: { sampleRateHz: 24_000, format: "pcm16", channels: 1 },
    });
  });

  it("falls back to the default agent id when the caller omits agentId", async () => {
    mocks.loadConfig.mockReturnValue({} as OpenClawConfig);
    const issue = vi.fn((input: { agentId: string; sessionKey: string }) => ({
      ticket: "tk",
      issuedAtMs: 0,
      expiresAtMs: 1,
      ...input,
    }));
    const respond = vi.fn();
    await talkHandlers["talk.realtime.start"]({
      req: { type: "req", id: "1", method: "talk.realtime.start" },
      params: {},
      client: { connId: "conn-1", connect: { scopes: [] } } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: { talkRealtimeTicketRegistry: { issue } } as never,
    });
    const input = issue.mock.calls[0][0];
    expect(input.agentId).toBe("main");
    expect(input.sessionKey).toBe("agent:main:main");
  });
});
