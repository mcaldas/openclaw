import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { fetchWithSsrFGuard } from "../../../api.js";
import type { CallRecordingApi } from "../base.js";
import { guardedJsonApiRequest } from "../shared/guarded-json-api.js";

// A 10-minute dual-channel PCM recording is about 19 MB; leave room for longer calls.
const MAX_RECORDING_BYTES = 128 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Twilio call recordings: start on a live call, list, download as two-channel WAV, delete. */
export function createTwilioRecordingApi(params: {
  baseUrl: string;
  authorization: string;
}): CallRecordingApi {
  const headers = { Authorization: params.authorization };
  const allowedHostnames = [new URL(params.baseUrl).hostname];
  const call = <T>(method: "GET" | "POST" | "DELETE", endpoint: string, body?: URLSearchParams) =>
    guardedJsonApiRequest<T>({
      method,
      url: `${params.baseUrl}${endpoint}`,
      headers: body ? { ...headers, "Content-Type": "application/x-www-form-urlencoded" } : headers,
      body,
      allowNotFound: method === "DELETE",
      allowedHostnames,
      auditContext: "voice-call.twilio.recordings",
      errorPrefix: "Twilio recording API error",
    });
  return {
    async start(providerCallId) {
      // Dual channel keeps each side of the call on its own channel.
      const body = new URLSearchParams({ RecordingChannels: "dual", RecordingTrack: "both" });
      const result = await call<{ sid?: string }>(
        "POST",
        `/Calls/${providerCallId}/Recordings.json`,
        body,
      );
      return { id: result?.sid ?? "" };
    },
    async list(providerCallId) {
      const result = await call<{
        recordings?: { sid?: string; status?: string; duration?: string }[];
      }>("GET", `/Calls/${providerCallId}/Recordings.json`);
      return (result?.recordings ?? []).flatMap((recording) =>
        recording.sid
          ? [
              {
                id: recording.sid,
                // Twilio reports "completed" once the media can be fetched.
                ready: recording.status === "completed",
                durationSeconds: Number(recording.duration) || 0,
              },
            ]
          : [],
      );
    },
    async download(recordingId) {
      const { response, release } = await fetchWithSsrFGuard({
        url: `${params.baseUrl}/Recordings/${recordingId}.wav?RequestedChannels=2`,
        init: { method: "GET", headers },
        policy: { allowedHostnames },
        auditContext: "voice-call.twilio.recording-download",
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
      });
      try {
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error(`Twilio recording download failed: HTTP ${response.status}`);
        }
        const body = await readResponseWithLimit(response, MAX_RECORDING_BYTES, {
          onOverflow: ({ size, maxBytes }) =>
            new Error(`recording too large: ${size} bytes (limit: ${maxBytes} bytes)`),
        });
        return Buffer.from(body);
      } finally {
        await release();
      }
    },
    async delete(recordingId) {
      await call("DELETE", `/Recordings/${recordingId}.json`);
    },
  };
}
