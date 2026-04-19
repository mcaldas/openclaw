import { describe, expect, it } from "vitest";
import {
  buildOpenAIRealtimeSessionUpdate,
  buildOpenAIRealtimeVoiceProvider,
} from "./realtime-voice-provider.js";

describe("buildOpenAIRealtimeVoiceProvider", () => {
  it("normalizes provider-owned voice settings from raw provider config", () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      rawConfig: {
        providers: {
          openai: {
            model: "gpt-realtime",
            voice: "verse",
            temperature: 0.6,
            silenceDurationMs: 850,
            vadThreshold: 0.35,
          },
        },
      },
    });

    expect(resolved).toEqual({
      model: "gpt-realtime",
      voice: "verse",
      temperature: 0.6,
      silenceDurationMs: 850,
      vadThreshold: 0.35,
    });
  });
});

describe("buildOpenAIRealtimeSessionUpdate", () => {
  const baseConfig = {
    apiKey: "sk-test",
    providerConfig: {},
    onAudio: () => {},
    onClearAudio: () => {},
  } as const;

  it("defaults to g711_ulaw for voice-call / Twilio backwards compatibility", () => {
    const update = buildOpenAIRealtimeSessionUpdate({ ...baseConfig });
    expect(update.session.input_audio_format).toBe("g711_ulaw");
    expect(update.session.output_audio_format).toBe("g711_ulaw");
  });

  it("uses pcm16 for both input and output when audioFormat is pcm16", () => {
    const update = buildOpenAIRealtimeSessionUpdate({
      ...baseConfig,
      audioFormat: "pcm16",
    });
    expect(update.session.input_audio_format).toBe("pcm16");
    expect(update.session.output_audio_format).toBe("pcm16");
  });

  it("omits tools entirely when the config has no tools", () => {
    const update = buildOpenAIRealtimeSessionUpdate({
      ...baseConfig,
      audioFormat: "pcm16",
    });
    expect("tools" in update.session).toBe(false);
    expect("tool_choice" in update.session).toBe(false);
  });

  it("includes tools verbatim and sets tool_choice=auto when tools are provided", () => {
    const tools = [
      {
        type: "function" as const,
        name: "weather",
        description: "Look up the weather.",
        parameters: {
          type: "object" as const,
          properties: {
            location: { type: "string" },
          },
          required: ["location"],
        },
      },
    ];
    const update = buildOpenAIRealtimeSessionUpdate({
      ...baseConfig,
      audioFormat: "pcm16",
      tools,
    });
    expect(update.session.tools).toEqual(tools);
    expect(update.session.tool_choice).toBe("auto");
  });

  it("carries the agent instructions through verbatim (prompt-cache stability)", () => {
    const update = buildOpenAIRealtimeSessionUpdate({
      ...baseConfig,
      audioFormat: "pcm16",
      instructions: "You are the active agent.",
    });
    expect(update.session.instructions).toBe("You are the active agent.");
  });
});
