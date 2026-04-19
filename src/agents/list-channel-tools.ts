import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawCodingTools } from "./pi-tools.js";
import type { AnyAgentTool } from "./tools/common.js";

/**
 * Channel labels `listAgentToolsForChannel` understands. `"chat"` is the
 * baseline parity anchor: the tool set text chat sees. `"voice"` is the
 * realtime voice bridge's filtered set.
 *
 * Kept as a closed union so new channels force a decision in this module.
 */
export type ListAgentToolsChannel = "chat" | "voice";

export type ListAgentToolsOptions = {
  agentId?: string;
  channel: ListAgentToolsChannel;
  config?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  sessionKey?: string;
  modelProvider?: string;
  modelId?: string;
  senderIsOwner?: boolean;
};

/**
 * Tools that voice-mode sessions silent-disable even if policy would allow
 * them. The realtime model has no approval UI; if it emits a call to one
 * of these, the gateway returns a spoken-hint `function_call_output` telling
 * the user to switch to chat (see `buildVoiceToolDisabledHint`).
 *
 * The list intentionally errs toward safety: anything that can run a shell
 * command, mutate the workspace, or rewrite-apply a patch goes here. Read-
 * only and send-message tools stay enabled so voice can actually be useful.
 *
 * If this list ever needs to grow dynamically (e.g. to honor a new
 * `ownerOnly` marker or an explicit "approvalRequired" metadata bit), move
 * the check into the plugin-owned tool metadata layer rather than hard-
 * coding more names here.
 */
export const VOICE_DISABLED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "exec",
  "process",
  "write",
  "edit",
  "apply_patch",
]);

export type VoiceToolDisabledOutput = {
  error: "approval_required";
  tool: string;
  message: string;
  /** Tells the realtime model to paraphrase `message` in its next spoken reply. */
  spokenHint: true;
};

/**
 * Build the spoken-hint payload the gateway posts back to the realtime
 * model when the assistant tries to call a voice-disabled tool. Pure; no
 * state. Voice uses it from the tool-dispatch path (commit 5).
 */
export function buildVoiceToolDisabledHint(toolName: string): VoiceToolDisabledOutput {
  return {
    error: "approval_required",
    tool: toolName,
    message: `For that I'd need to run ${toolName}. Easiest to switch to chat and I'll do it there.`,
    spokenHint: true,
  };
}

/**
 * Returns the tool list an agent sees for a given channel, with
 * channel-specific filtering applied.
 *
 * Implementation is a thin wrapper around `createOpenClawCodingTools`:
 * that function is already functionally pure at call time (it wires
 * lazy tool constructors and hook wrappers, no hooks fire and no memory
 * flushes run from just building the list). The "list-only" contract
 * this helper advertises is therefore inherited from the current shape
 * of `createOpenClawCodingTools` — if that function ever starts firing
 * hooks or writing workspace state at construct time, this helper must
 * grow its own list-only stub context instead of delegating.
 *
 * Guardrail: callers must not hand the returned array to the execution
 * runtime for a live agent run. The hook wrappers remain tied to the
 * options passed here (sessionKey, runId if any), so executing them
 * would attribute activity to whatever session was named at list time.
 * For voice, the bridge passes the voice session context at list time
 * and is also the one dispatching the call later; that matches.
 */
export function listAgentToolsForChannel(options: ListAgentToolsOptions): AnyAgentTool[] {
  const tools = createOpenClawCodingTools({
    agentId: options.agentId,
    agentDir: options.agentDir,
    workspaceDir: options.workspaceDir,
    sessionKey: options.sessionKey,
    config: options.config,
    modelProvider: options.modelProvider,
    modelId: options.modelId,
    senderIsOwner: options.senderIsOwner,
  });
  if (options.channel === "voice") {
    return tools.filter((tool) => !VOICE_DISABLED_TOOL_NAMES.has(tool.name));
  }
  return tools;
}
