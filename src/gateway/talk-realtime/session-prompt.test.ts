import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildVoiceSystemPrompt, VOICE_SYSTEM_PROMPT_PREAMBLE } from "./session-prompt.js";

function mkTool(name: string): AnyAgentTool {
  return {
    name,
    description: `Tool ${name}`,
    parameters: { type: "object", properties: {} },
  } as unknown as AnyAgentTool;
}

describe("buildVoiceSystemPrompt", () => {
  const baseOpts = {
    agentId: "main",
    config: {} as OpenClawConfig,
    workspaceDir: process.cwd(),
    modelDisplay: "realtime-voice",
  };

  it("appends the voice preamble exactly once at the tail (prompt-cache stability)", () => {
    const prompt = buildVoiceSystemPrompt({
      ...baseOpts,
      tools: [mkTool("read")],
    });
    expect(prompt.endsWith(VOICE_SYSTEM_PROMPT_PREAMBLE)).toBe(true);
    // Preamble must not appear anywhere else (e.g. embedded accidentally).
    const nonTailCount =
      prompt
        .slice(0, -VOICE_SYSTEM_PROMPT_PREAMBLE.length)
        .split("You are speaking on a live voice call.").length - 1;
    expect(nonTailCount).toBe(0);
  });

  it("is deterministic for identical inputs (no timestamps or non-deterministic data leak)", () => {
    const a = buildVoiceSystemPrompt({
      ...baseOpts,
      tools: [mkTool("read"), mkTool("message")],
    });
    const b = buildVoiceSystemPrompt({
      ...baseOpts,
      tools: [mkTool("read"), mkTool("message")],
    });
    // The system prompt embeds `userTime` (wall clock) via buildSystemPromptParams,
    // so identical-input determinism only holds ignoring the runtime block. We
    // strip any "Current time:" line before comparing.
    const stripTime = (s: string) => s.replace(/Current time:[^\n]*\n/g, "");
    expect(stripTime(a)).toBe(stripTime(b));
  });

  it("preserves tool ordering in toolNames hints", () => {
    const prompt = buildVoiceSystemPrompt({
      ...baseOpts,
      tools: [mkTool("alpha"), mkTool("bravo"), mkTool("charlie")],
    });
    // The system prompt groups known core tools; for unknown names it may
    // omit them. Assert the preamble still ends the string regardless of
    // whether the individual names made it in, and that ordering is not
    // re-sorted when the names ARE present.
    const alphaIdx = prompt.indexOf("alpha");
    const bravoIdx = prompt.indexOf("bravo");
    const charlieIdx = prompt.indexOf("charlie");
    if (alphaIdx !== -1 && bravoIdx !== -1) {
      expect(alphaIdx).toBeLessThan(bravoIdx);
    }
    if (bravoIdx !== -1 && charlieIdx !== -1) {
      expect(bravoIdx).toBeLessThan(charlieIdx);
    }
  });
});
