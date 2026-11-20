import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "../api.js";
import { recordingWanted, type CallRecordingOutcome } from "./call-recordings.js";
import type { VoiceCallConfig } from "./config.js";
import { holdWakeServices, WAKE_TRANSCRIPT_PROMPT } from "./hold-wake.js";
import type { CallManager } from "./manager.js";
import {
  phoneMenuHoldEnded,
  phoneMenuResult,
  REALTIME_VOICE_PHONE_MENU_TOOL_NAME,
} from "./phone-menu.js";
import type { VoiceCallProvider } from "./providers/base.js";
import {
  REALTIME_VOICE_ADD_OWNER_TOOL_NAME,
  REALTIME_VOICE_WHO_SPOKE_TOOL_NAME,
} from "./realtime-call-control.js";
import { createCallRooms, roomOf, type CallRooms } from "./room.js";
import { loadSileroVad } from "./silero-vad.js";
import { buildSpeakerTranscript, SPEAKER_TRANSCRIPT_PROMPT } from "./speaker-transcript.js";
import type { CallRecord } from "./types.js";
import type { VoiceCallWebhookServer } from "./webhook.js";
import {
  modelQuietWindows,
  roomHoldGates,
  SILENT_TOOL_QUIET_MS,
} from "./webhook/realtime-call-playback.js";
import type { RealtimeCallHandler } from "./webhook/realtime-handler.js";

type Logger = { info: (message: string) => void; warn: (message: string) => void };

/** Room mode for outbound calls: rooms, the add-owner tool and the room legs' webhook. */
export function wireCallRooms(params: {
  config: VoiceCallConfig;
  manager: CallManager;
  provider: VoiceCallProvider;
  realtimeHandler: RealtimeCallHandler;
  webhookServer: VoiceCallWebhookServer;
  webhookUrl: () => string | null;
  log: Logger;
  /** The configured audio model, for checking hold wakes against known announcements. */
  transcribeWav?: (wavPath: string) => Promise<string | undefined>;
}): CallRooms | undefined {
  const { config, manager, realtimeHandler } = params;
  if (!config.room?.enabled) {
    return undefined;
  }
  if (!params.provider.room) {
    params.log.warn(
      `[voice-call] ${params.provider.name} has no conference rooms; room mode stays off.`,
    );
    return undefined;
  }
  const rooms = createCallRooms({
    config,
    manager,
    carrier: params.provider.room,
    webhookUrl: params.webhookUrl,
    note: (callId, instructions) => {
      const result = realtimeHandler.speak(callId, instructions);
      if (!result.success) {
        params.log.warn(`[voice-call] room note not delivered callId=${callId}: ${result.error}`);
      }
    },
    allowHold: (callId, allowed) => roomHoldGates.get(callId)?.setEnabled(allowed),
    recordOwner: (call) => config.recording.enabled && recordingWanted(call),
    log: (message) => params.log.info(`[voice-call] ${message}`),
  });
  manager.room = rooms.hooks;
  realtimeHandler.registerToolHandler(REALTIME_VOICE_ADD_OWNER_TOOL_NAME, (_args, callId) =>
    rooms.addOwner(callId),
  );
  realtimeHandler.registerToolHandler(REALTIME_VOICE_WHO_SPOKE_TOOL_NAME, async (_args, callId) =>
    rooms.whoSpoke(callId),
  );
  realtimeHandler.registerToolHandler(REALTIME_VOICE_PHONE_MENU_TOOL_NAME, async (args, callId) => {
    const status = args && typeof args === "object" && "status" in args ? args.status : args;
    params.log.info(`[voice-call] phone menu ${String(status)} callId=${callId}`);
    const gate = roomHoldGates.get(callId);
    modelQuietWindows.get(callId)?.(SILENT_TOOL_QUIET_MS);
    if (status === "hold" && gate) {
      gate.holdNow();
      if (gate.mode === "hold") {
        const how = await gate.whenHoldEnds();
        params.log.info(`[voice-call] phone menu hold ended (${how}) callId=${callId}`);
        return phoneMenuHoldEnded(how);
      }
    }
    return phoneMenuResult(
      status,
      gate &&
        (() => {
          gate.holdNow();
          return gate.mode === "hold";
        }),
    );
  });
  if (config.room.holdDetector !== "energy") {
    holdWakeServices.transcribe = params.transcribeWav;
    void loadSileroVad((message) => params.log.warn(message)).then((vad) => {
      holdWakeServices.vad = vad;
      if (vad) {
        params.log.info("[voice-call] Silero VAD ready for hold detection");
      }
    });
  }
  params.webhookServer.roomRouter = (ctx, req) => {
    const form = new URLSearchParams(ctx.rawBody);
    return rooms.routeWebhook(ctx.query, form, (target) =>
      realtimeHandler.buildTwiMLPayload(req, form, target),
    );
  };
  return rooms;
}

/** One audio file through the configured audio model, for the hold gate's wake check. */
export function createWakeTranscriber(params: {
  coreConfig: OpenClawConfig;
  mediaUnderstanding: Pick<
    OpenClawPluginApi["runtime"]["mediaUnderstanding"],
    "transcribeAudioFile"
  >;
}) {
  return async (filePath: string) =>
    (
      await params.mediaUnderstanding.transcribeAudioFile({
        filePath,
        cfg: params.coreConfig,
        mime: "audio/wav",
        prompt: WAKE_TRANSCRIPT_PROMPT,
      })
    ).text;
}

/** Per-speaker transcripts from call recordings, with the configured audio model. */
export function createRecordingTranscriber(params: {
  config: VoiceCallConfig;
  coreConfig: OpenClawConfig;
  mediaUnderstanding: Pick<
    OpenClawPluginApi["runtime"]["mediaUnderstanding"],
    "transcribeAudioFile"
  >;
  dir: string;
  log: Logger;
}) {
  return async (
    call: CallRecord,
    legs: NonNullable<CallRecordingOutcome["legs"]>,
  ): Promise<string | undefined> => {
    // Room calls only: Mathias asked for these, and channel 0 is the far end on their legs.
    if (!roomOf(call)) {
      return undefined;
    }
    const ownerName = params.config.room?.ownerName ?? "Owner";
    const transcript = await buildSpeakerTranscript({
      legs: legs.map((leg) => ({
        label: leg.leg === "owner" ? ownerName : "Callee",
        file: leg.path,
        startedAt: leg.startedAt,
      })),
      // Jarvis's own words come from his text, which is exact.
      assistant: call.transcript
        // A bare tag such as "<no spoken response>" is the model narrating a tool result.
        .filter(
          (entry) =>
            entry.speaker === "bot" && entry.isFinal && !/^<[^>]*>\S*$/u.test(entry.text.trim()),
        )
        .map((entry) => ({ at: entry.timestamp, text: entry.text })),
      assistantLabel: "Assistant",
      transcribe: async (filePath) =>
        (
          await params.mediaUnderstanding.transcribeAudioFile({
            filePath,
            cfg: params.coreConfig,
            mime: "audio/wav",
            prompt: SPEAKER_TRANSCRIPT_PROMPT,
          })
        ).text,
      workDir: path.join(params.dir, `.segments-${call.callId}`),
      warn: (message) => params.log.warn(`[voice-call] ${message}`),
    });
    if (!transcript) {
      return undefined;
    }
    const date = new Date(call.startedAt).toISOString().slice(0, 10);
    const file = path.join(params.dir, `${date}-${call.callId}-transcript.md`);
    await fs.writeFile(file, `# Call ${call.callId}\n\n${transcript}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    params.log.info(`[voice-call] Speaker transcript saved callId=${call.callId} path=${file}`);
    return file;
  };
}
