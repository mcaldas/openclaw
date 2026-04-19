import os from "node:os";
import { buildSystemPromptParams } from "../../agents/system-prompt-params.js";
import { buildAgentSystemPrompt } from "../../agents/system-prompt.js";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/**
 * Compose the `instructions` string the gateway hands to the realtime
 * provider via `session.update`. Reuses the text-chat system-prompt
 * composer (`buildAgentSystemPrompt`) so voice sessions inherit the
 * same agent identity, tool hints, skill block, owner rules, and
 * channel conventions that text chat sees.
 *
 * The ONLY voice-specific addition is a small preamble appended at the
 * tail, telling the model it is on a live audio channel. Keeping it at
 * the tail preserves the cached prefix of the system prompt so the
 * text-chat and voice paths share most of their cache footprint.
 *
 * Prompt-cache stability: `buildAgentSystemPrompt` is deterministic
 * given its inputs. Tool names are passed in the order the tool list
 * was produced (which in turn is a deterministic slice of the registry
 * order). The voice preamble is a constant string.
 */
export const VOICE_SYSTEM_PROMPT_PREAMBLE = [
  "",
  "You are speaking on a live voice call.",
  "Keep replies short and conversational.",
  "Answer with your voice first; only use tools when they produce a clearly better answer than speaking from memory.",
  "If a tool you need is not available in this voice mode, say so briefly and offer to switch to text chat.",
].join("\n");

export type BuildVoiceSystemPromptOptions = {
  agentId: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  tools: AnyAgentTool[];
  /** Model id advertised to the agent for the runtime info block. */
  modelDisplay: string;
  /** Extra system prompt the agent carries (e.g. persona/custom). */
  extraSystemPrompt?: string;
  /** Repo root detected by the caller, if any. Passed through verbatim. */
  repoRoot?: string;
};

export function buildVoiceSystemPrompt(opts: BuildVoiceSystemPromptOptions): string {
  const { runtimeInfo, userTimezone, userTime, userTimeFormat } = buildSystemPromptParams({
    config: opts.config,
    agentId: opts.agentId,
    workspaceDir: opts.workspaceDir,
    cwd: process.cwd(),
    runtime: {
      host: "openclaw",
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      node: process.version,
      model: opts.modelDisplay,
      channel: "voice",
    },
  });
  const body = buildAgentSystemPrompt({
    workspaceDir: opts.workspaceDir ?? process.cwd(),
    extraSystemPrompt: opts.extraSystemPrompt,
    toolNames: opts.tools.map((tool) => tool.name),
    userTimezone,
    userTime,
    userTimeFormat,
    runtimeInfo,
    // Voice never has a reasoning-tag hint; realtime models do not emit
    // reasoning traces in a way we want to quote back to the user.
    reasoningTagHint: false,
  });
  return `${body}${VOICE_SYSTEM_PROMPT_PREAMBLE}`;
}
