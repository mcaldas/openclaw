import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { sleep as defaultSleep } from "openclaw/plugin-sdk/runtime-env";
import type { CallRecordingApi } from "./providers/base.js";
import { roomOf } from "./room.js";
import { TerminalStates, type CallRecord } from "./types.js";

/** What became of a call's recording; stored on the call record as `metadata.recording`. */
export type CallRecordingOutcome = {
  /** "recording" is stored when the provider starts recording, so a gateway restart can still collect it. */
  status: "recording" | "saved" | "failed";
  /** Local two-channel WAV files, one per provider recording (normally one). */
  paths: string[];
  /** Whose leg each file records; channel 0 is that person alone. Room calls add the owner's leg. */
  legs?: { leg: "callee" | "owner"; path: string; startedAt: number }[];
  /** Per-speaker transcript built from the recordings, when one was made. */
  transcriptPath?: string;
  durationSeconds?: number;
  /** Provider recordings still held at the provider, so nothing is lost when a download fails. */
  keptAtProvider?: string[];
  error?: string;
  at: number;
};

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

const READY_POLL_MS = 3_000;
const READY_TIMEOUT_MS = 120_000;
const FINISHED_RETENTION_MS = 10 * 60_000;

export function recordingWanted(call: CallRecord): boolean {
  const brief = call.metadata?.brief;
  return !(brief && typeof brief === "object" && "record" in brief && brief.record === false);
}

/** A recording an earlier gateway process started for this call. */
function recordingMarked(call: CallRecord): boolean {
  const recording = call.metadata?.recording;
  return Boolean(
    recording &&
    typeof recording === "object" &&
    "status" in recording &&
    recording.status === "recording",
  );
}

// Not yet connected: the provider refuses to record a call that is not in progress.
const NOT_CONNECTED = new Set(["initiated", "ringing"]);

/**
 * Record answered calls at the provider, then fetch each recording to `dir`, delete it at the
 * provider and store the outcome on the call. A failed download keeps the provider copy.
 */
export function createCallRecordings(params: {
  api: CallRecordingApi;
  dir: string;
  persist: (call: CallRecord, outcome: CallRecordingOutcome) => Promise<void>;
  log: Logger;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Builds a transcript from the saved legs and returns its file; failures are only logged. */
  transcribe?: (
    call: CallRecord,
    legs: NonNullable<CallRecordingOutcome["legs"]>,
  ) => Promise<string | undefined>;
}) {
  const { api, log } = params;
  const sleep = params.sleep ?? defaultSleep;
  const now = params.now ?? Date.now;
  const started = new Map<string, Promise<string | undefined>>();
  const startedAt = new Map<string, number>();
  const finished = new Map<string, Promise<CallRecordingOutcome | undefined>>();

  const start = (call: CallRecord, providerCallId: string) => {
    started.set(
      call.callId,
      api.start(providerCallId).then(
        async ({ id }) => {
          startedAt.set(call.callId, now());
          log.info(`[voice-call] Recording started callId=${call.callId} recording=${id}`);
          await params
            .persist(call, { status: "recording", paths: [], at: now() })
            .catch((error: unknown) => {
              log.warn(
                `[voice-call] Recording start not stored callId=${call.callId}: ${formatErrorMessage(error)}`,
              );
            });
          return undefined;
        },
        (error: unknown) => {
          const message = formatErrorMessage(error);
          log.error(`[voice-call] Recording failed to start callId=${call.callId}: ${message}`);
          return message;
        },
      ),
    );
  };

  const waitUntilReady = async (providerCallId: string) => {
    const deadline = now() + READY_TIMEOUT_MS;
    for (;;) {
      const recordings = await api.list(providerCallId);
      if (recordings.length > 0 && recordings.every((recording) => recording.ready)) {
        return recordings;
      }
      if (now() >= deadline) {
        const ids = recordings.map((recording) => recording.id).join(",");
        throw new Error(
          ids
            ? `recording ${ids} not ready after ${READY_TIMEOUT_MS / 1000} s; it stays at the provider`
            : "provider has no recording for this call",
        );
      }
      await sleep(READY_POLL_MS);
    }
  };

  type Found = Awaited<ReturnType<CallRecordingApi["list"]>>;

  const save = async (call: CallRecord, providerCallId: string): Promise<CallRecordingOutcome> => {
    const startError = await started.get(call.callId);
    const errors: string[] = [];
    const sources: { found: Found; leg: "callee" | "owner"; startedAt: number }[] = [];
    try {
      // A start whose response was lost may still have made a recording; only an empty list proves none.
      if (startError && (await api.list(providerCallId)).length === 0) {
        errors.push(`start failed: ${startError}`);
      } else {
        sources.push({
          found: await waitUntilReady(providerCallId),
          leg: "callee",
          // The file's second 0 is when recording started, not when the callee answered.
          startedAt: startedAt.get(call.callId) ?? call.answeredAt ?? call.startedAt,
        });
      }
    } catch (error) {
      const prefix = startError ? `start failed: ${startError}; ` : "";
      errors.push(`${prefix}${formatErrorMessage(error)}`);
    }
    // A room call also recorded every owner leg that answered, even if the callee's failed.
    const room = roomOf(call);
    for (const leg of room?.ownerLegs ?? []) {
      try {
        sources.push({
          found: await waitUntilReady(leg.callSid),
          leg: "owner",
          startedAt: leg.answeredAt,
        });
      } catch (error) {
        errors.push(`owner leg ${leg.callSid}: ${formatErrorMessage(error)}`);
      }
    }
    if (sources.length === 0) {
      return { status: "failed", paths: [], error: errors.join("; "), at: now() };
    }
    await fs.mkdir(params.dir, { recursive: true, mode: 0o700 });
    const date = new Date(call.startedAt).toISOString().slice(0, 10);
    const paths: string[] = [];
    const legs: NonNullable<CallRecordingOutcome["legs"]> = [];
    const kept: string[] = [];
    const taken = new Set<string>();
    for (const { found, leg, startedAt: legStartedAt } of sources) {
      for (const recording of found) {
        const base = `${date}-${call.callId}${leg === "owner" ? "-owner" : ""}`;
        let name = `${base}.wav`;
        for (let index = 2; taken.has(name); index += 1) {
          name = `${base}-${index}.wav`;
        }
        taken.add(name);
        const file = path.join(params.dir, name);
        try {
          // wx: never overwrite an earlier call's file.
          await fs.writeFile(file, await api.download(recording.id), { mode: 0o600, flag: "wx" });
          paths.push(file);
          legs.push({ leg, path: file, startedAt: legStartedAt });
        } catch (error) {
          kept.push(recording.id);
          errors.push(`${recording.id}: ${formatErrorMessage(error)}`);
          continue;
        }
        try {
          await api.delete(recording.id);
        } catch (error) {
          kept.push(recording.id);
          log.warn(
            `[voice-call] Recording saved but not deleted at the provider callId=${call.callId} recording=${recording.id}: ${formatErrorMessage(error)}`,
          );
        }
      }
    }
    const transcriptPath =
      legs.length > 0
        ? await params.transcribe?.(call, legs).catch((error: unknown) => {
            log.warn(
              `[voice-call] Speaker transcript failed callId=${call.callId}: ${formatErrorMessage(error)}`,
            );
            return undefined;
          })
        : undefined;
    return {
      status: errors.length === 0 ? "saved" : "failed",
      paths,
      ...(room ? { legs } : {}),
      ...(transcriptPath ? { transcriptPath } : {}),
      durationSeconds: sources
        .flatMap((source) => source.found)
        .reduce((sum, recording) => sum + recording.durationSeconds, 0),
      ...(kept.length > 0 ? { keptAtProvider: kept } : {}),
      ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
      at: now(),
    };
  };

  /** Settles once the recording is saved or has failed; undefined when nothing was recorded. */
  const finish = (call: CallRecord): Promise<CallRecordingOutcome | undefined> => {
    const existing = finished.get(call.callId);
    if (existing) {
      return existing;
    }
    const providerCallId = call.providerCallId;
    // shortcut: a save cut off by a gateway exit is not resumed; the file stays at the provider
    // and the call record keeps status "recording". Sweep stored calls if that ever matters.
    if ((!started.has(call.callId) && !recordingMarked(call)) || !providerCallId) {
      return Promise.resolve(undefined);
    }
    const work = save(call, providerCallId)
      .catch((error: unknown): CallRecordingOutcome => ({
        status: "failed",
        paths: [],
        error: formatErrorMessage(error),
        at: now(),
      }))
      .then(async (outcome) => {
        started.delete(call.callId);
        startedAt.delete(call.callId);
        const detail = `callId=${call.callId} paths=${outcome.paths.join(",") || "none"}${outcome.keptAtProvider ? ` keptAtProvider=${outcome.keptAtProvider.join(",")}` : ""}`;
        if (outcome.status === "saved") {
          log.info(`[voice-call] Recording saved ${detail}`);
        } else {
          log.error(`[voice-call] Recording not saved ${detail}: ${outcome.error}`);
        }
        await params.persist(call, outcome).catch((error: unknown) => {
          log.error(
            `[voice-call] Recording outcome not stored callId=${call.callId}: ${formatErrorMessage(error)}`,
          );
        });
        setTimeout(() => finished.delete(call.callId), FINISHED_RETENTION_MS).unref?.();
        return outcome;
      });
    finished.set(call.callId, work);
    return work;
  };

  return {
    /** Feed every call update: starts recording once answered, collects it once ended. */
    observe(call: CallRecord): void {
      if (TerminalStates.has(call.state)) {
        void finish(call);
      } else if (
        call.providerCallId &&
        !NOT_CONNECTED.has(call.state) &&
        !started.has(call.callId) &&
        !finished.has(call.callId) &&
        !recordingMarked(call) &&
        recordingWanted(call)
      ) {
        start(call, call.providerCallId);
      }
    },
    finish,
  };
}
