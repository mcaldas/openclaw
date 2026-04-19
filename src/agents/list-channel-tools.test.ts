import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildVoiceToolDisabledHint,
  listAgentToolsForChannel,
  VOICE_DISABLED_TOOL_NAMES,
} from "./list-channel-tools.js";
import { createOpenClawCodingTools } from "./pi-tools.js";

function baseOptions() {
  return {
    agentId: "main",
    config: {} as OpenClawConfig,
    workspaceDir: process.cwd(),
  };
}

describe("listAgentToolsForChannel", () => {
  it("chat channel returns the same tool-id set as createOpenClawCodingTools (parity anchor)", () => {
    const base = baseOptions();
    const direct = createOpenClawCodingTools(base);
    const viaHelper = listAgentToolsForChannel({ ...base, channel: "chat" });
    const directNames = direct.map((t) => t.name).toSorted();
    const helperNames = viaHelper.map((t) => t.name).toSorted();
    expect(helperNames).toEqual(directNames);
    // Sanity check: the baseline actually contains the core tools we expect
    // a text-chat agent to carry. If this ever regresses we want a loud
    // failure here, not silent drift.
    expect(directNames).toEqual(expect.arrayContaining(["read", "exec"]));
  });

  it("voice channel filters out the approval-required tool names", () => {
    const base = baseOptions();
    const voice = listAgentToolsForChannel({ ...base, channel: "voice" });
    const voiceNames = new Set(voice.map((t) => t.name));
    for (const disabled of VOICE_DISABLED_TOOL_NAMES) {
      expect(voiceNames.has(disabled)).toBe(false);
    }
    // And keeps at least the read tool so voice is not tool-empty.
    expect(voiceNames.has("read")).toBe(true);
  });

  it("voice-disabled names are non-empty and the shared ones line up with chat", () => {
    // Guardrail: a future refactor could narrow the default chat tool set
    // (e.g. `apply_patch` only activates for OpenAI models). The filter
    // still needs to block the shared names — `exec`, `process`, `write`,
    // `edit` — which are the core approval-sensitive tools; `apply_patch`
    // may or may not be present depending on the active provider.
    const chat = listAgentToolsForChannel({ ...baseOptions(), channel: "chat" });
    const chatNames = new Set(chat.map((t) => t.name));
    const sharedCore = ["exec", "process", "write", "edit"] as const;
    for (const disabled of sharedCore) {
      expect(chatNames.has(disabled)).toBe(true);
      expect(VOICE_DISABLED_TOOL_NAMES.has(disabled)).toBe(true);
    }
    expect(VOICE_DISABLED_TOOL_NAMES.size).toBeGreaterThanOrEqual(sharedCore.length);
  });
});

describe("buildVoiceToolDisabledHint", () => {
  it("produces a spokenHint-tagged function_call_output payload", () => {
    const hint = buildVoiceToolDisabledHint("exec");
    expect(hint).toEqual({
      error: "approval_required",
      tool: "exec",
      message: "For that I'd need to run exec. Easiest to switch to chat and I'll do it there.",
      spokenHint: true,
    });
  });

  it("quotes the tool name into the spoken message", () => {
    const hint = buildVoiceToolDisabledHint("apply_patch");
    expect(hint.message).toContain("apply_patch");
  });
});
