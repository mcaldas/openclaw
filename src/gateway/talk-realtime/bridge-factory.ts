import { listAgentToolsForChannel } from "../../agents/list-channel-tools.js";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import { loadConfig } from "../../config/config.js";
import { resolveActiveTalkProviderConfig } from "../../config/talk.js";
import type { RealtimeVoiceProviderPlugin } from "../../plugins/types.js";
import {
  canonicalizeRealtimeVoiceProviderId,
  getRealtimeVoiceProvider,
} from "../../realtime-voice/provider-registry.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
} from "../../realtime-voice/provider-types.js";
import { loadVoiceMemorySnapshot, type VoiceMemoryItem } from "./memory-snapshot.js";
import { buildVoiceSystemPrompt } from "./session-prompt.js";
import { createToolDispatcher } from "./tool-dispatch.js";
import { marshalAgentToolsForRealtime } from "./tool-marshalling.js";
import type { TalkRealtimeBridgeFactory } from "./upgrade-host.js";

/**
 * Build a `TalkRealtimeBridgeFactory` that resolves the active realtime
 * voice provider from the current gateway config, then produces a bridge
 * that inherits the active agent's system prompt and tool registry.
 *
 * What this factory composes at bridge-build time:
 *
 * 1. The OpenClaw agent tool list for the active agent, filtered for
 *    voice via `listAgentToolsForChannel(agentId, "voice", ...)`, which
 *    silent-disables approval-required tools (`exec`, `write`, etc.).
 * 2. A voice-aware system prompt via `buildVoiceSystemPrompt`, which
 *    reuses the same `buildAgentSystemPrompt` composer that text chat
 *    uses and appends a small voice preamble.
 * 3. A history tail read from the matching text chat session via
 *    `loadVoiceMemorySnapshot`. The tail is returned alongside the
 *    bridge so the upgrade host can splice it into the conversation
 *    after `bridge.connect()` and before the first `response.create`.
 *
 * Memory-core summary injection is intentionally deferred; see
 * `docs/voice/gateway-realtime-bridge.md` -> "A memory snapshot is
 * injected".
 */
export type TalkRealtimeBridgeFactoryDeps = {
  /** Injected for tests. Defaults to the global config loader. */
  loadConfigFn?: typeof loadConfig;
  /** Injected for tests. Defaults to the realtime-voice provider registry. */
  resolveProviderFn?: typeof getRealtimeVoiceProvider;
  /** Injected for tests. Defaults to `listAgentToolsForChannel`. */
  listToolsFn?: typeof listAgentToolsForChannel;
  /** Injected for tests. Defaults to `loadVoiceMemorySnapshot`. */
  loadMemorySnapshotFn?: typeof loadVoiceMemorySnapshot;
  /** Optional logging hook for schemas dropped during tool marshalling. */
  onToolMarshallingSkip?: (skipped: Array<{ name: string; reason: string }>) => void;
};

export function createDefaultTalkRealtimeBridgeFactory(
  deps: TalkRealtimeBridgeFactoryDeps = {},
): TalkRealtimeBridgeFactory {
  const loadConfigFn = deps.loadConfigFn ?? loadConfig;
  const resolveProviderFn = deps.resolveProviderFn ?? getRealtimeVoiceProvider;
  const listToolsFn = deps.listToolsFn ?? listAgentToolsForChannel;
  const loadMemorySnapshotFn = deps.loadMemorySnapshotFn ?? loadVoiceMemorySnapshot;

  return async ({ ticket, sessionHandlersForBridge }) => {
    const runtimeConfig = loadConfigFn();
    const resolved = resolveActiveTalkProviderConfig(runtimeConfig.talk);
    if (!resolved) {
      throw new Error("talk.realtime: no active talk provider configured");
    }
    const canonical = canonicalizeRealtimeVoiceProviderId(resolved.provider, runtimeConfig);
    if (!canonical) {
      throw new Error(
        `talk.realtime: provider "${resolved.provider}" is not a realtime-voice provider`,
      );
    }
    const plugin: RealtimeVoiceProviderPlugin | undefined = resolveProviderFn(
      canonical,
      runtimeConfig,
    );
    if (!plugin) {
      throw new Error(`talk.realtime: realtime voice provider "${canonical}" not registered`);
    }

    const agentTools: AnyAgentTool[] = listToolsFn({
      agentId: ticket.agentId,
      channel: "voice",
      config: runtimeConfig,
      sessionKey: ticket.sessionKey,
      // Realtime model provider is OpenAI for this bridge; the
      // normalization path in tool-marshalling already keys off the
      // literal "openai" string so keep it explicit.
      modelProvider: "openai",
    });
    const marshalled = marshalAgentToolsForRealtime(agentTools);
    if (marshalled.skipped.length > 0) {
      deps.onToolMarshallingSkip?.(marshalled.skipped);
    }
    const instructions = buildVoiceSystemPrompt({
      agentId: ticket.agentId,
      config: runtimeConfig,
      tools: agentTools,
      modelDisplay: "realtime-voice",
    });
    const memorySnapshot: VoiceMemoryItem[] = loadMemorySnapshotFn({
      sessionKey: ticket.sessionKey,
      loadConfigFn,
    });

    const createReq: RealtimeVoiceBridgeCreateRequest = {
      providerConfig: resolved.config as RealtimeVoiceBridgeCreateRequest["providerConfig"],
      instructions,
      tools: marshalled.tools,
      audioFormat: "pcm16",
      onAudio: (audio) => sessionHandlersForBridge.onAudio(audio),
      onClearAudio: () => sessionHandlersForBridge.onClearAudio(),
      onTranscript: (role, text, isFinal) =>
        sessionHandlersForBridge.onTranscript(role, text, isFinal),
      onError: (err) => sessionHandlersForBridge.onError(err),
      onClose: (reason) => sessionHandlersForBridge.onClose(reason),
      onReady: () => {
        // Seed the conversation with the recent history tail before the
        // realtime model speaks its first reply. We pin this to onReady
        // so the `session.update` has already been sent and the bridge
        // is ready to accept conversation items.
        if (typeof bridge.sendConversationItem !== "function") {
          return;
        }
        for (const entry of memorySnapshot) {
          try {
            bridge.sendConversationItem(entry.item);
          } catch {
            // Seeding is best-effort; a provider that rejects one item
            // should not abort the whole voice session.
          }
        }
      },
      onToolCall: (toolCall) => {
        dispatcher.dispatch(toolCall);
      },
    };
    const bridge: RealtimeVoiceBridge = plugin.createBridge(createReq);
    // Dispatcher is constructed after the bridge so it can post results
    // via `bridge.submitToolResult`. The `onToolCall` callback closes
    // over the `dispatcher` binding declared below; because
    // `plugin.createBridge` returns synchronously before any upstream
    // event can fire, the binding is live by the time any tool call is
    // received.
    const dispatcher = createToolDispatcher({
      tools: agentTools,
      bridge,
      onStarted: (event) => sessionHandlersForBridge.onToolCallStarted?.(event),
      onFinished: (event) => sessionHandlersForBridge.onToolCallFinished?.(event),
    });
    return bridge;
  };
}
