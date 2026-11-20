import path from "node:path";
import { listAgentIds } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isLoopbackHost } from "openclaw/plugin-sdk/gateway-runtime";
import type { PluginLogger, PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import {
  assertRealtimeVoiceAgentConsultModelSelectionUnlocked,
  consultRealtimeVoiceAgent,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  resolveRealtimeVoiceAgentConsultToolsAllow,
  resolveRealtimeVoiceFastContextConsult,
  type RealtimeVoiceAgentConsultTranscriptEntry,
} from "openclaw/plugin-sdk/realtime-voice";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import type { OpenClawPluginApi } from "../api.js";
import { buildCallBriefInstructions } from "./call-brief.js";
import { createCallDeliveryRuntime } from "./call-delivery-runtime.js";
import { createCallRecordings } from "./call-recordings.js";
import type { VoiceCallConfig } from "./config.js";
import {
  resolveVoiceCallEffectiveConfig,
  resolveVoiceCallNumberRouteKeyForCall,
  resolveVoiceCallSessionKey,
  resolveVoiceCallStreamExposurePaths,
  resolveTwilioAuthToken,
} from "./config.js";
import { CallManager } from "./manager.js";
import { PHONE_MENU_INSTRUCTIONS, PHONE_MENU_TOOL } from "./phone-menu.js";
import type { VoiceCallProvider } from "./providers/base.js";
import type { TwilioProvider } from "./providers/twilio.js";
import { buildRealtimeVoiceInstructions } from "./realtime-agent-context.js";
import {
  buildAddOwnerTool,
  buildWhoSpokeTool,
  REALTIME_VOICE_SEND_DTMF_TOOL_NAME,
  resolveVoiceCallRealtimeTools,
} from "./realtime-call-control.js";
import { resolveCallAgentId, resolveVoiceCallAgentId } from "./resolve-call-agent-id.js";
import { resolveVoiceResponseModel } from "./response-model.js";
import {
  createRecordingTranscriber,
  createWakeTranscriber,
  wireCallRooms,
} from "./room-runtime.js";
import { roomOf, type CallRooms } from "./room.js";
import { setVoiceCallStateRuntime, type VoiceCallStateRuntime } from "./runtime-state.js";
import type { TelephonyTtsRuntime } from "./telephony-tts.js";
import { createTelephonyTtsProvider } from "./telephony-tts.js";
import { startTunnel, type TunnelResult } from "./tunnel.js";
import { TerminalStates, type CallRecord, type ToolHandlerContext } from "./types.js";
import {
  isProviderUnreachableWebhookUrl,
  providerRequiresPublicWebhook,
} from "./webhook-exposure.js";
import { VoiceCallWebhookServer } from "./webhook.js";
import { modelQuietWindows, SILENT_TOOL_QUIET_MS } from "./webhook/realtime-call-playback.js";
import { cleanupTailscaleExposure, setupTailscaleExposure } from "./webhook/tailscale.js";

export type VoiceCallRuntime = {
  config: VoiceCallConfig;
  manager: CallManager;
  webhookServer: VoiceCallWebhookServer;
  stop: () => Promise<void>;
};

const REALTIME_VOICE_CONSULT_SYSTEM_PROMPT = [
  "You are the configured OpenClaw agent receiving delegated requests from a live phone voice bridge.",
  "Act on behalf of the caller using the normal available tools when the caller asks you to do work.",
  "Prioritize completing the user's request and returning a fast, speakable result over exhaustive investigation.",
  "For tool-backed status checks, prefer one or two bounded read-only queries before answering.",
  "This consult is bound to the current phone call. Use voice_call end_call to hang up; no other voice_call action or call is permitted.",
  "The delegated input is the other party's latest words and the transcript shows both sides. Act on that context: when the Agent line says it is hanging up, do exactly that; when both sides have said goodbye or the other party asks to end the call, hang up with end_call.",
  "Do not print secret values or dump environment variables; only check whether required configuration is present.",
  "Be accurate, brief, and speakable.",
].join(" ");

function mapVoiceCallConsultTranscript(
  call: CallRecord,
  context: ToolHandlerContext,
): RealtimeVoiceAgentConsultTranscriptEntry[] {
  const transcript: RealtimeVoiceAgentConsultTranscriptEntry[] = call.transcript.map((entry) => ({
    role: entry.speaker === "bot" ? "assistant" : "user",
    text: entry.text,
  }));
  const partial = context.partialUserTranscript?.trim();
  if (partial && transcript.at(-1)?.text !== partial) {
    transcript.push({ role: "user", text: partial });
  }
  return transcript;
}

async function resolveProvider(config: VoiceCallConfig): Promise<VoiceCallProvider> {
  const allowNgrokFreeTierLoopbackBypass =
    config.tunnel.provider === "ngrok" &&
    isLoopbackHost(config.serve.bind) &&
    config.tunnel.allowNgrokFreeTierLoopbackBypass;

  switch (config.provider) {
    case "telnyx": {
      const { TelnyxProvider } = await import("./providers/telnyx.js");
      return new TelnyxProvider(
        {
          apiKey: config.telnyx?.apiKey,
          connectionId: config.telnyx?.connectionId,
          publicKey: config.telnyx?.publicKey,
        },
        {
          skipVerification: config.skipSignatureVerification,
        },
      );
    }
    case "twilio": {
      const { TwilioProvider } = await import("./providers/twilio.js");
      return new TwilioProvider(
        {
          accountSid: config.twilio?.accountSid,
          authToken: resolveTwilioAuthToken(config),
          region: config.twilio?.region,
        },
        {
          allowNgrokFreeTierLoopbackBypass,
          publicUrl: config.publicUrl,
          skipVerification: config.skipSignatureVerification,
          streamPath: config.streaming?.enabled ? config.streaming.streamPath : undefined,
          webhookSecurity: config.webhookSecurity,
        },
      );
    }
    case "plivo": {
      const { PlivoProvider } = await import("./providers/plivo.js");
      return new PlivoProvider(
        {
          authId: config.plivo?.authId,
          authToken: config.plivo?.authToken,
        },
        {
          publicUrl: config.publicUrl,
          skipVerification: config.skipSignatureVerification,
          ringTimeoutSec: Math.max(1, Math.floor(config.ringTimeoutMs / 1000)),
          webhookSecurity: config.webhookSecurity,
        },
      );
    }
    case "mock": {
      const { MockProvider } = await import("./providers/mock.js");
      return new MockProvider();
    }
    default:
      throw new Error(`Unsupported voice-call provider: ${String(config.provider)}`);
  }
}

function listRealtimeAgentIds(config: VoiceCallConfig, coreConfig: OpenClawConfig): string[] {
  const agentIds = new Set<string>([normalizeAgentId(config.agentId)]);
  for (const agentId of listAgentIds(coreConfig)) {
    agentIds.add(normalizeAgentId(agentId));
  }
  for (const route of Object.values(config.numbers)) {
    if (route.agentId) {
      agentIds.add(normalizeAgentId(route.agentId));
    }
  }
  return [...agentIds];
}

async function createRealtimeInstructionsResolver(params: {
  config: VoiceCallConfig & { agentId: string };
  coreConfig: OpenClawConfig;
  warn: (message: string) => void;
}): Promise<(call: CallRecord) => string> {
  const genericConfig: VoiceCallConfig = {
    ...params.config,
    realtime: {
      ...params.config.realtime,
      agentContext: { ...params.config.realtime.agentContext, enabled: false },
    },
  };
  const genericInstructions = await buildRealtimeVoiceInstructions({
    baseInstructions: params.config.realtime.instructions,
    config: genericConfig,
    coreConfig: params.coreConfig,
    warn: params.warn,
    agentId: params.config.agentId,
  });
  const entries = await Promise.all(
    listRealtimeAgentIds(params.config, params.coreConfig).map(async (agentId) => {
      const instructions = await buildRealtimeVoiceInstructions({
        baseInstructions: params.config.realtime.instructions,
        config: { ...params.config, agentId },
        coreConfig: params.coreConfig,
        warn: params.warn,
        agentId,
      });
      return [agentId, instructions] as const;
    }),
  );
  const instructionsByAgentId = new Map(entries);
  return (call) => {
    const instructions = instructionsByAgentId.get(resolveCallAgentId(call)) ?? genericInstructions;
    const brief = buildCallBriefInstructions(call);
    return brief ? `${instructions}\n\n${brief}` : instructions;
  };
}

export async function createVoiceCallRuntime(params: {
  scheduler: PluginServiceSchedulerV1;
  config: VoiceCallConfig;
  coreConfig: OpenClawConfig;
  agentRuntime: OpenClawPluginApi["runtime"]["agent"];
  stateRuntime?: VoiceCallStateRuntime["state"];
  ttsRuntime?: TelephonyTtsRuntime;
  logger?: PluginLogger;
  deliveryRuntime?: Pick<
    OpenClawPluginApi["runtime"],
    "gateway" | "subagent" | "mediaUnderstanding"
  >;
  runInServiceContext?: <T>(run: () => T) => T;
}): Promise<VoiceCallRuntime> {
  params.scheduler.signal.throwIfAborted();
  const {
    config: rawConfig,
    coreConfig: cfg,
    agentRuntime,
    stateRuntime,
    ttsRuntime,
    logger,
  } = params;
  const log = logger ?? {
    info: console.log,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };

  const config = { ...rawConfig, agentId: resolveVoiceCallAgentId(rawConfig, cfg) };

  if (config.skipSignatureVerification) {
    log.warn(
      "[voice-call] SECURITY WARNING: skipSignatureVerification=true disables webhook signature verification (development only). Do not use in production.",
    );
  }

  const provider = await resolveProvider(config);
  if (stateRuntime) {
    setVoiceCallStateRuntime({ state: stateRuntime });
  }
  const manager = new CallManager(config, undefined, cfg.session, stateRuntime);
  // Known once the webhook is exposed; room legs need it for their status callbacks.
  let publicWebhookUrl: string | null = null;
  let rooms: CallRooms | undefined;
  const realtimeVoiceRuntime = config.realtime.enabled
    ? await import("./realtime-voice.runtime.js")
    : null;
  const webhookServer = new VoiceCallWebhookServer(
    params.scheduler,
    config,
    manager,
    provider,
    cfg,
    agentRuntime,
    log,
  );
  if (realtimeVoiceRuntime) {
    const { RealtimeCallHandler } = await import("./webhook/realtime-handler.js");
    const resolveRealtimeInstructions = await createRealtimeInstructionsResolver({
      config,
      coreConfig: cfg,
      warn: (message) => log.warn(`[voice-call] ${message}`),
    });
    const realtimeConfig = {
      ...config.realtime,
      tools: resolveVoiceCallRealtimeTools(
        config.realtime.toolPolicy,
        config.realtime.tools,
        config.room?.enabled
          ? [
              buildAddOwnerTool(config.room.ownerName ?? "the owner"),
              buildWhoSpokeTool(config.room.ownerName ?? "the owner"),
              PHONE_MENU_TOOL,
            ]
          : [],
      ),
    };
    const resolveCallRegistration = async (call: CallRecord) => {
      const numberRouteKey = resolveVoiceCallNumberRouteKeyForCall(call);
      const effectiveConfig = resolveVoiceCallEffectiveConfig(config, numberRouteKey).config;
      const agentId = resolveCallAgentId(call);
      const resolved = await realtimeVoiceRuntime.resolveConfiguredRealtimeVoiceProviderAsync({
        configuredProviderId: effectiveConfig.realtime.provider,
        providerConfigs: effectiveConfig.realtime.providers,
        cfg,
        agentId,
        surface: "gateway-relay",
        useProviderDefaultModel: true,
      });
      return {
        agentId,
        provider: resolved.provider,
        providerConfig: resolved.providerConfig,
        capabilities: resolved.capabilities,
        instructions: roomOf(call)
          ? `${resolveRealtimeInstructions(call)}\n\n${PHONE_MENU_INSTRUCTIONS}`
          : resolveRealtimeInstructions(call),
      };
    };
    const realtimeHandler = new RealtimeCallHandler(
      realtimeConfig,
      manager,
      resolveCallRegistration,
      config.serve.path,
      webhookServer.getStreamDisconnectLifecycle(),
      cfg,
      config.voicemail.holdOpeningMaxMs,
    );
    if (config.realtime.toolPolicy !== "none") {
      realtimeHandler.registerToolHandler(
        REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        async (args, callId, handlerContext) => {
          handlerContext.abortSignal?.throwIfAborted();
          const call = manager.getCall(callId);
          if (!call) {
            return { error: `Call "${callId}" not found` };
          }
          const numberRouteKey = resolveVoiceCallNumberRouteKeyForCall(call);
          const effectiveConfig = resolveVoiceCallEffectiveConfig(config, numberRouteKey).config;
          const agentId = resolveCallAgentId(call);
          const sessionKey = resolveVoiceCallSessionKey({
            config: { ...effectiveConfig, agentId },
            callId: call.callId,
            phone: call.direction === "outbound" ? call.to : call.from,
            explicitSessionKey: call.sessionKey,
            coreSession: cfg.session,
          });
          const requesterSessionKey =
            typeof call.metadata?.requesterSessionKey === "string"
              ? call.metadata.requesterSessionKey
              : undefined;
          const modelLockParams = {
            cfg,
            agentRuntime,
            agentId,
            sessionKey,
            spawnedBy: requesterSessionKey,
          };
          assertRealtimeVoiceAgentConsultModelSelectionUnlocked(modelLockParams);
          const fastContext = await resolveRealtimeVoiceFastContextConsult({
            cfg,
            agentId,
            sessionKey,
            config: effectiveConfig.realtime.fastContext,
            args,
            logger: log,
            labels: {
              audienceLabel: "caller",
              contextName: "OpenClaw memory or session context",
            },
            // Memory reads for this caller stay bound to the consult and its live call.
            liveness: {
              signal: handlerContext.abortSignal,
              assertCurrent() {
                if (manager.getCall(callId) !== call || TerminalStates.has(call.state)) {
                  throw new Error(`Call "${callId}" is no longer active`);
                }
              },
            },
          });
          handlerContext.abortSignal?.throwIfAborted();
          if (fastContext.handled) {
            assertRealtimeVoiceAgentConsultModelSelectionUnlocked(modelLockParams);
            return fastContext.result;
          }
          const { provider: agentProvider, model } = resolveVoiceResponseModel({
            cfg,
            agentId,
            voiceConfig: effectiveConfig,
            agentRuntime,
          });
          const thinkLevel =
            effectiveConfig.realtime.consultThinkingLevel ??
            agentRuntime.resolveThinkingDefault({
              cfg,
              provider: agentProvider,
              model,
            });
          return await consultRealtimeVoiceAgent({
            cfg,
            agentRuntime,
            logger: log,
            agentId,
            sessionKey,
            messageProvider: "voice",
            lane: "voice",
            runIdPrefix: `voice-realtime-consult:${callId}`,
            args,
            transcript: mapVoiceCallConsultTranscript(call, handlerContext),
            surface: "a live phone call",
            userLabel: "Caller",
            assistantLabel: "Agent",
            questionSourceLabel: "caller",
            provider: agentProvider,
            model,
            thinkLevel,
            fastMode: effectiveConfig.realtime.consultFastMode,
            timeoutMs: effectiveConfig.responseTimeoutMs,
            spawnedBy: requesterSessionKey,
            contextMode: requesterSessionKey ? "fork" : undefined,
            toolsAllow: (() => {
              const allowed = resolveRealtimeVoiceAgentConsultToolsAllow(
                effectiveConfig.realtime.toolPolicy,
              );
              return allowed?.length ? [...allowed, "voice_call"] : allowed;
            })(),
            toolBindings: {
              voice_call: { kind: "active-call", callId: call.callId },
            },
            extraSystemPrompt: `${REALTIME_VOICE_CONSULT_SYSTEM_PROMPT} The bound call id is ${JSON.stringify(call.callId)}.\n\n${buildCallBriefInstructions(call)}`,
            abortSignal: handlerContext.abortSignal,
          });
        },
      );
    }
    realtimeHandler.registerToolHandler(
      REALTIME_VOICE_SEND_DTMF_TOOL_NAME,
      async (args, callId) => {
        const digits =
          args && typeof args === "object" && "digits" in args ? args.digits : undefined;
        if (typeof digits !== "string" || !digits) {
          return { error: "digits is required" };
        }
        // In-band only: the provider fallback would replace the TwiML and end this stream.
        const result = await manager.sendDtmf(callId, digits, { inBandOnly: true });
        if (result.success) {
          modelQuietWindows.get(callId)?.(SILENT_TOOL_QUIET_MS);
        }
        return result.success
          ? {
              success: true,
              digits,
              note: "Keys sent. Say nothing; listen for the menu's next prompt.",
            }
          : { error: result.error };
      },
    );
    manager.playRealtimeKeypadTones = (callId, digits) =>
      realtimeHandler.playKeypadTones(callId, digits);
    manager.playRealtimeVoicemail = (callId, instructions) =>
      realtimeHandler.playVoicemail(callId, instructions);
    manager.beforeCarrierPlayback = (callId) => realtimeHandler.prepareCarrierPlayback(callId);
    if (config.reports.enabled || config.live.transcript || config.voicemail.detection !== "off") {
      manager.beforeCallEnd = (call) => realtimeHandler.drainCall(call.callId);
    }
    webhookServer.setRealtimeHandler(realtimeHandler);
    rooms = wireCallRooms({
      config,
      manager,
      provider,
      realtimeHandler,
      webhookServer,
      webhookUrl: () => publicWebhookUrl,
      log,
      transcribeWav: params.deliveryRuntime?.mediaUnderstanding
        ? createWakeTranscriber({
            coreConfig: cfg,
            mediaUnderstanding: params.deliveryRuntime.mediaUnderstanding,
          })
        : undefined,
    });
  }
  const recordingApi = config.recording.enabled ? provider.recordings : undefined;
  if (config.recording.enabled && !recordingApi) {
    log.warn(`[voice-call] ${provider.name} calls cannot be recorded; recording stays off.`);
  }
  const recordings = recordingApi
    ? createCallRecordings({
        api: recordingApi,
        dir: path.join(manager.storePath, "recordings"),
        persist: (call, outcome) =>
          // Only the recording key: the stored record keeps its newer delivery statuses.
          manager.persistDeliveryStatus({ ...call, metadata: { recording: outcome } }),
        log,
        transcribe: params.deliveryRuntime?.mediaUnderstanding
          ? createRecordingTranscriber({
              config,
              coreConfig: cfg,
              mediaUnderstanding: params.deliveryRuntime.mediaUnderstanding,
              dir: path.join(manager.storePath, "recordings"),
              log,
            })
          : undefined,
      })
    : undefined;
  const delivery =
    (config.reports.enabled || config.live.transcript) &&
    params.deliveryRuntime &&
    params.runInServiceContext
      ? createCallDeliveryRuntime({
          config,
          coreConfig: cfg,
          runtime: params.deliveryRuntime,
          runInServiceContext: params.runInServiceContext,
          manager,
          logger: log,
          recordingFor: recordings?.finish,
        })
      : undefined;
  if (recordings || rooms) {
    const deliverCallUpdate = manager.onCallUpdated;
    manager.onCallUpdated = (call) => {
      recordings?.observe(call);
      rooms?.observe(call);
      return deliverCallUpdate?.(call);
    };
  }
  if ((config.reports.enabled || config.live.transcript) && !delivery) {
    log.warn(
      "[voice-call] Reports/live transcript require the plugin delivery runtime; transcripts remain in call history.",
    );
  }
  let tunnelResult: TunnelResult | null = null;
  let stopPromise: Promise<void> | undefined;
  const stop = (suppressErrors = false): Promise<void> => {
    stopPromise ??= (async () => {
      let failure: { error: unknown } | undefined;
      for (const step of [
        () => tunnelResult?.stop(),
        () => cleanupTailscaleExposure(config),
        () => webhookServer.stop(),
        () => delivery?.stop(),
        () => manager.stop(),
      ]) {
        try {
          await step();
        } catch (error) {
          failure ??= { error };
        }
      }
      if (failure && !suppressErrors) {
        throw failure.error;
      }
    })();
    return stopPromise;
  };

  const localUrl = await webhookServer.start();

  // Wrap remaining initialization in try/catch so the webhook server is
  // properly stopped if any subsequent step fails.  Without this, the server
  // keeps the port bound while the runtime promise rejects, causing
  // EADDRINUSE on the next attempt.  See: #32387
  try {
    // Determine public URL - priority: config.publicUrl > tunnel > legacy tailscale
    let publicUrl: string | null = config.publicUrl ?? null;

    if (!publicUrl && config.tunnel?.provider && config.tunnel.provider !== "none") {
      try {
        tunnelResult = await startTunnel({
          provider: config.tunnel.provider,
          port: config.serve.port,
          tailscalePort: config.tailscale.port,
          path: config.serve.path,
          streamPaths: resolveVoiceCallStreamExposurePaths(config, {
            publicWebhookPath: config.serve.path,
            localWebhookPath: config.serve.path,
          }),
          ngrokAuthToken: config.tunnel.ngrokAuthToken,
          ngrokDomain: config.tunnel.ngrokDomain,
        });
        publicUrl = tunnelResult?.publicUrl ?? null;
      } catch (err) {
        log.error(`[voice-call] Tunnel setup failed: ${formatErrorMessage(err)}`);
      }
    }

    if (!publicUrl && config.tailscale?.mode !== "off") {
      publicUrl = await setupTailscaleExposure(config);
    }

    const webhookUrl = publicUrl ?? localUrl;
    publicWebhookUrl = webhookUrl;

    if (
      providerRequiresPublicWebhook(provider.name) &&
      isProviderUnreachableWebhookUrl(webhookUrl)
    ) {
      throw new Error(
        `[voice-call] ${provider.name} requires a publicly reachable webhook URL. ` +
          `Refusing to use local-only webhook ${webhookUrl}. ` +
          "Set plugins.entries.voice-call.config.publicUrl or enable tunnel/tailscale exposure.",
      );
    }

    if (publicUrl) {
      provider.setPublicUrl?.(publicUrl);
    }
    if (publicUrl && realtimeVoiceRuntime) {
      webhookServer.getRealtimeHandler()?.setPublicUrl(publicUrl);
    }

    const realtimeHandler = webhookServer.getRealtimeHandler();
    if (realtimeHandler) {
      manager.streamSessionIssuer = (request) => realtimeHandler.issueStreamSession(request);
    }

    if (provider.name === "twilio" && config.streaming?.enabled) {
      const twilioProvider = provider as TwilioProvider;
      if (ttsRuntime?.textToSpeechTelephony) {
        try {
          const ttsProvider = await createTelephonyTtsProvider({
            coreConfig: cfg,
            ttsOverride: config.tts,
            runtime: ttsRuntime,
            logger: log,
          });
          twilioProvider.setTTSProvider(ttsProvider);
          log.info("[voice-call] Telephony TTS provider configured");
        } catch (err) {
          log.warn(`[voice-call] Failed to initialize telephony TTS: ${formatErrorMessage(err)}`);
        }
      } else {
        log.warn("[voice-call] Telephony TTS unavailable; streaming TTS disabled");
      }

      const mediaHandler = webhookServer.getMediaStreamHandler();
      if (mediaHandler) {
        twilioProvider.setMediaStreamHandler(mediaHandler);
        log.info("[voice-call] Media stream handler wired to provider");
      }
    }

    if (realtimeVoiceRuntime) {
      log.info("[voice-call] Realtime voice enabled");
    }

    await manager.initialize(provider, webhookUrl);

    log.info("[voice-call] Runtime initialized");
    log.info(`[voice-call] Webhook URL: ${webhookUrl}`);

    return {
      config,
      manager,
      webhookServer,
      stop: () => stop(),
    };
  } catch (err) {
    await stop(true);
    throw err;
  }
}
