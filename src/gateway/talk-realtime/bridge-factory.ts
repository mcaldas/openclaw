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
import type { TalkRealtimeBridgeFactory } from "./upgrade-host.js";

/**
 * Build a `TalkRealtimeBridgeFactory` that resolves the active realtime
 * voice provider from the current gateway config, then produces a bridge
 * wired for pcm16 audio (iOS uses 24 kHz pcm16) and no tools / no
 * instructions. Commits 3 and 4 replace this with an agent-aware factory
 * that injects the active agent's system prompt, tool registry, and
 * memory snapshot.
 *
 * The factory is intentionally dependency-injected so the boot wiring can
 * swap in a test or agent-aware factory without touching the upgrade
 * host.
 */
export type TalkRealtimeBridgeFactoryDeps = {
  /** Injected for tests. Defaults to the global config loader. */
  loadConfigFn?: typeof loadConfig;
  /** Injected for tests. Defaults to the realtime-voice provider registry. */
  resolveProviderFn?: typeof getRealtimeVoiceProvider;
};

export function createDefaultTalkRealtimeBridgeFactory(
  deps: TalkRealtimeBridgeFactoryDeps = {},
): TalkRealtimeBridgeFactory {
  const loadConfigFn = deps.loadConfigFn ?? loadConfig;
  const resolveProviderFn = deps.resolveProviderFn ?? getRealtimeVoiceProvider;

  return async ({ sessionHandlersForBridge }) => {
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

    const createReq: RealtimeVoiceBridgeCreateRequest = {
      providerConfig: resolved.config as RealtimeVoiceBridgeCreateRequest["providerConfig"],
      // commit 2: no instructions, no tools. commit 3 injects the agent
      // system prompt + tool schemas; commit 4 injects memory.
      instructions: "",
      tools: [],
      audioFormat: "pcm16",
      onAudio: (audio) => sessionHandlersForBridge.onAudio(audio),
      onClearAudio: () => sessionHandlersForBridge.onClearAudio(),
      onTranscript: (role, text, isFinal) =>
        sessionHandlersForBridge.onTranscript(role, text, isFinal),
      onError: (err) => sessionHandlersForBridge.onError(err),
      onClose: (reason) => sessionHandlersForBridge.onClose(reason),
    };
    const bridge: RealtimeVoiceBridge = plugin.createBridge(createReq);
    return bridge;
  };
}
