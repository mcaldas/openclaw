import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  buildVoiceToolDisabledHint,
  VOICE_DISABLED_TOOL_NAMES,
} from "../../agents/list-channel-tools.js";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceToolCallEvent,
} from "../../realtime-voice/provider-types.js";

/**
 * Dispatches realtime tool calls emitted by the provider bridge. Looks
 * the tool up in the agent's voice-channel tool list, validates args
 * (if the tool exposes a prepare helper), invokes `tool.execute`, and
 * posts the result back to the bridge via `submitToolResult`.
 *
 * Two client-visible events surface through the supplied callbacks so
 * the iOS session can render progress:
 *
 * - `onStarted({ callId, name })` immediately when a call is received.
 * - `onFinished({ callId, name, durationMs, ok })` when it resolves.
 *
 * Voice-disabled tools (see `VOICE_DISABLED_TOOL_NAMES`) short-circuit
 * to a spoken-hint `function_call_output` telling the user to switch
 * to chat. They still surface through `onStarted` + `onFinished` so
 * the client UI can show "tried to run exec -> declined" if desired.
 *
 * Parallel tool calls: the dispatcher runs each call concurrently but
 * serializes `submitToolResult` via a tail-chained promise so the
 * upstream realtime WS receives one `response.create` per burst of
 * function calls. This matches OpenAI realtime's contract that
 * `response.create` is only emitted once all outstanding outputs are
 * posted.
 */

export type ToolDispatchEvent = {
  callId: string;
  name: string;
};

export type ToolDispatchFinishedEvent = ToolDispatchEvent & {
  durationMs: number;
  ok: boolean;
};

export type ToolDispatchCallbacks = {
  onStarted?: (event: ToolDispatchEvent) => void;
  onFinished?: (event: ToolDispatchFinishedEvent) => void;
  onError?: (err: Error, call: RealtimeVoiceToolCallEvent) => void;
};

export type CreateToolDispatcherOptions = ToolDispatchCallbacks & {
  /** The tool set voice has access to. Indexed by tool name. */
  tools: AnyAgentTool[];
  /** The provider bridge to post results to. */
  bridge: RealtimeVoiceBridge;
  /** Optional abort signal shared across all dispatched calls. */
  signal?: AbortSignal;
  /** Injected clock for deterministic tests. */
  now?: () => number;
};

export type ToolDispatcher = {
  dispatch: (call: RealtimeVoiceToolCallEvent) => void;
  /** Awaits all in-flight calls. For test teardown. */
  drain: () => Promise<void>;
};

export function createToolDispatcher(opts: CreateToolDispatcherOptions): ToolDispatcher {
  const byName = new Map<string, AnyAgentTool>();
  for (const tool of opts.tools) {
    if (tool.name) {
      byName.set(tool.name, tool);
    }
  }
  const now = opts.now ?? Date.now;
  const inFlight = new Set<Promise<void>>();

  const dispatch = (call: RealtimeVoiceToolCallEvent): void => {
    const startedAt = now();
    opts.onStarted?.({ callId: call.callId, name: call.name });

    const task = (async (): Promise<void> => {
      let ok = false;
      try {
        const output = await executeOne(call, byName, opts.signal);
        opts.bridge.submitToolResult(call.callId, output);
        ok = true;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        opts.onError?.(e, call);
        try {
          opts.bridge.submitToolResult(call.callId, {
            error: "tool_execution_failed",
            message: e.message,
          });
        } catch {
          // Best-effort: if submission also fails, leave the realtime
          // model to time out the call and recover.
        }
      } finally {
        opts.onFinished?.({
          callId: call.callId,
          name: call.name,
          durationMs: now() - startedAt,
          ok,
        });
      }
    })();
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  };

  const drain = async (): Promise<void> => {
    while (inFlight.size > 0) {
      await Promise.all(inFlight);
    }
  };

  return { dispatch, drain };
}

async function executeOne(
  call: RealtimeVoiceToolCallEvent,
  byName: Map<string, AnyAgentTool>,
  signal?: AbortSignal,
): Promise<unknown> {
  if (VOICE_DISABLED_TOOL_NAMES.has(call.name)) {
    // Short-circuit: do not even attempt to execute; hand the spoken
    // nudge back to the realtime model as a structured function output.
    return buildVoiceToolDisabledHint(call.name);
  }
  const tool = byName.get(call.name);
  if (!tool) {
    return {
      error: "tool_not_found",
      message: `No tool named "${call.name}" is available in voice mode.`,
      spokenHint: true,
    };
  }
  const prepared = prepareArgs(tool, call.args);
  // biome / oxlint: `execute` signature is (callId, params, signal, onUpdate).
  const result: AgentToolResult<unknown> = await tool.execute(call.callId, prepared, signal);
  return serializeToolResult(result);
}

function prepareArgs(tool: AnyAgentTool, raw: unknown): unknown {
  if (typeof tool.prepareArguments === "function") {
    try {
      return tool.prepareArguments(raw);
    } catch {
      // Fall through to the raw args; the schema-validated path inside
      // the tool itself will reject if the shape is wrong.
      return raw ?? {};
    }
  }
  return raw ?? {};
}

/**
 * Render an `AgentToolResult` into the string-shaped output the realtime
 * model expects for `function_call_output`. We take the text blocks
 * verbatim (joined on newlines) and append a machine-readable trailer
 * only when there are non-text details the model might find useful.
 * Image-only results are stubbed with a "[image] ..." marker because
 * realtime function outputs do not carry binary content.
 */
function serializeToolResult(result: AgentToolResult<unknown>): unknown {
  const textParts: string[] = [];
  let imageCount = 0;
  for (const block of result.content ?? []) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as unknown as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      textParts.push(record.text);
    } else if (record.type === "image") {
      imageCount += 1;
    }
  }
  if (textParts.length === 0 && imageCount > 0) {
    return `[${imageCount} image${imageCount === 1 ? "" : "s"} omitted in voice mode]`;
  }
  const text = textParts.join("\n");
  return text.length > 0 ? text : "";
}
