import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCallRecordings } from "./call-recordings.js";
import type { CallRecord } from "./types.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function roomCall(state: CallRecord["state"]): CallRecord {
  return {
    callId: "call-1",
    providerCallId: "CA-callee",
    provider: "twilio",
    direction: "outbound",
    state,
    from: "+15550000001",
    to: "+15550000002",
    startedAt: Date.UTC(2026, 10, 20, 1, 0, 0),
    answeredAt: Date.UTC(2026, 10, 20, 1, 0, 5),
    transcript: [],
    processedEventIds: [],
    metadata: {
      room: {
        name: "oc-call-1",
        ownerLegs: [
          { callSid: "CA-owner-1", answeredAt: 1_000 },
          { callSid: "CA-owner-2", answeredAt: 2_000 },
        ],
      },
    },
  };
}

async function setup(calleeRecordings: string[]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-call-room-recordings-"));
  dirs.push(dir);
  let clock = 500;
  const byLeg: Record<string, string[]> = {
    "CA-callee": calleeRecordings,
    "CA-owner-1": ["RE-o1"],
    "CA-owner-2": ["RE-o2"],
  };
  const api = {
    start: vi.fn(async () => ({ id: "RE-c" })),
    list: vi.fn(async (sid: string) =>
      (byLeg[sid] ?? []).map((id) => ({ id, ready: true, durationSeconds: 10 })),
    ),
    download: vi.fn(async (id: string) => Buffer.from(`wav ${id}`)),
    delete: vi.fn(async (_id: string) => {}),
  };
  const transcribe = vi.fn(async () => undefined);
  const recordings = createCallRecordings({
    api,
    dir: path.join(dir, "recordings"),
    persist: vi.fn(async () => {}),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    transcribe,
  });
  return { recordings, api, transcribe, dir: path.join(dir, "recordings") };
}

describe("room call recordings", () => {
  it("saves the callee's leg and every owner leg that answered", async () => {
    const { recordings, api, transcribe, dir } = await setup(["RE-c"]);
    recordings.observe(roomCall("active"));
    await Promise.resolve();
    const outcome = await recordings.finish(roomCall("completed"));
    expect(outcome?.status).toBe("saved");
    expect(outcome?.legs?.map((leg) => [leg.leg, path.basename(leg.path), leg.startedAt])).toEqual([
      ["callee", "2026-11-20-call-1.wav", 500],
      ["owner", "2026-11-20-call-1-owner.wav", 1_000],
      ["owner", "2026-11-20-call-1-owner-2.wav", 2_000],
    ]);
    expect(api.delete.mock.calls.map(([id]) => id)).toEqual(["RE-c", "RE-o1", "RE-o2"]);
    await expect(
      fs.readFile(path.join(dir, "2026-11-20-call-1-owner-2.wav"), "utf8"),
    ).resolves.toBe("wav RE-o2");
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it("still collects the owner's legs when the callee's recording is missing", async () => {
    const { recordings, api } = await setup([]);
    recordings.observe(roomCall("active"));
    await Promise.resolve();
    const outcome = await recordings.finish(roomCall("completed"));
    expect(outcome?.status).toBe("failed");
    expect(outcome?.error).toContain("provider has no recording");
    expect(outcome?.legs?.map((leg) => leg.leg)).toEqual(["owner", "owner"]);
    expect(api.delete).toHaveBeenCalledWith("RE-o1");
  });
});
