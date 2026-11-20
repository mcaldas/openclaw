import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCallRecordings } from "./call-recordings.js";
import type { CallRecord } from "./types.js";

function createCall(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    callId: "call-1",
    providerCallId: "CA1",
    provider: "twilio",
    direction: "outbound",
    state: "active",
    from: "+15550000001",
    to: "+15550000002",
    startedAt: Date.UTC(2026, 10, 20, 1, 0, 0),
    answeredAt: Date.UTC(2026, 10, 20, 1, 0, 5),
    transcript: [],
    processedEventIds: [],
    metadata: {},
    ...overrides,
  };
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function setup(api: Partial<Parameters<typeof createCallRecordings>[0]["api"]> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-call-recordings-"));
  dirs.push(dir);
  let clock = 0;
  const fake = {
    start: vi.fn(async () => ({ id: "RE1" })),
    list: vi.fn(async () => [{ id: "RE1", ready: true, durationSeconds: 42 }]),
    download: vi.fn(async () => Buffer.from("RIFF-two-channel-wav")),
    delete: vi.fn(async () => {}),
    ...api,
  };
  const persist = vi.fn(async () => {});
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const recordings = createCallRecordings({
    api: fake,
    dir: path.join(dir, "recordings"),
    persist,
    log,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
  return { recordings, fake, persist, log, dir: path.join(dir, "recordings") };
}

describe("call recordings", () => {
  it("starts once an answered call updates, unless its brief says record false", async () => {
    const { recordings, fake } = await setup();
    recordings.observe(createCall({ answeredAt: undefined, state: "ringing" }));
    recordings.observe(createCall({ callId: "quiet", metadata: { brief: { record: false } } }));
    recordings.observe(createCall());
    recordings.observe(createCall());

    expect(fake.start).toHaveBeenCalledTimes(1);
    expect(fake.start).toHaveBeenCalledWith("CA1");
    await expect(recordings.finish(createCall({ callId: "quiet" }))).resolves.toBeUndefined();
  });

  it("saves the file owner-only, deletes it at the provider and stores where it went", async () => {
    let polls = 0;
    const { recordings, fake, persist, dir } = await setup({
      list: vi.fn(async () => [{ id: "RE1", ready: ++polls > 2, durationSeconds: 42 }]),
    });
    recordings.observe(createCall());
    const ended = createCall({ state: "completed", endedAt: Date.UTC(2026, 10, 20, 1, 1, 0) });
    recordings.observe(ended);
    const outcome = await recordings.finish(ended);

    const file = path.join(dir, "2026-11-20-call-1.wav");
    expect(outcome).toMatchObject({ status: "saved", paths: [file], durationSeconds: 42 });
    expect(await fs.readFile(file, "utf8")).toBe("RIFF-two-channel-wav");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(fake.delete).toHaveBeenCalledWith("RE1");
    expect(persist).toHaveBeenCalledWith(ended, outcome);
    expect(recordings.finish(ended)).toBe(recordings.finish(ended));
  });

  it("keeps the recording at the provider and says so when the download fails", async () => {
    const { recordings, fake, persist, log } = await setup({
      download: vi.fn(async () => {
        throw new Error("HTTP 503");
      }),
    });
    recordings.observe(createCall());
    const outcome = await recordings.finish(createCall({ state: "completed" }));

    expect(outcome).toMatchObject({ status: "failed", paths: [], keptAtProvider: ["RE1"] });
    expect(outcome?.error).toContain("HTTP 503");
    expect(fake.delete).not.toHaveBeenCalled();
    expect(persist).toHaveBeenLastCalledWith(expect.anything(), outcome);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("Recording not saved"));
  });

  it("stops waiting for an unfinished recording after two minutes and leaves it there", async () => {
    const { recordings, fake } = await setup({
      list: vi.fn(async () => [{ id: "RE1", ready: false, durationSeconds: 0 }]),
    });
    recordings.observe(createCall());
    const outcome = await recordings.finish(createCall({ state: "completed" }));

    expect(outcome).toMatchObject({ status: "failed", paths: [] });
    expect(outcome?.error).toContain("RE1 not ready after 120 s; it stays at the provider");
    expect(fake.download).not.toHaveBeenCalled();
  });

  it("reports a recording that never started", async () => {
    const { recordings } = await setup({
      start: vi.fn(async () => {
        throw new Error("Twilio recording API error: 400 call not in progress");
      }),
      list: vi.fn(async () => []),
    });
    recordings.observe(createCall());
    const outcome = await recordings.finish(createCall({ state: "completed" }));

    expect(outcome).toMatchObject({ status: "failed", paths: [] });
    expect(outcome?.error).toContain("start failed: Twilio recording API error");
  });

  it("still collects a recording whose start response was lost", async () => {
    const { recordings, fake } = await setup({
      start: vi.fn(async () => {
        throw new Error("timed out after 30000 ms");
      }),
    });
    recordings.observe(createCall());
    const outcome = await recordings.finish(createCall({ state: "completed" }));

    expect(outcome).toMatchObject({ status: "saved" });
    expect(fake.delete).toHaveBeenCalledWith("RE1");
  });

  it("marks a started recording on the call and collects it after a gateway restart", async () => {
    const first = await setup();
    first.recordings.observe(createCall());
    await vi.waitFor(() =>
      expect(first.persist).toHaveBeenCalledWith(expect.anything(), {
        status: "recording",
        paths: [],
        at: 0,
      }),
    );

    // A new gateway process sees the stored marker instead of in-memory state.
    const { recordings, fake } = await setup();
    const restored = createCall({ metadata: { recording: { status: "recording" } } });
    recordings.observe(restored);
    expect(fake.start).not.toHaveBeenCalled();
    const outcome = await recordings.finish({ ...restored, state: "completed" });
    expect(outcome).toMatchObject({ status: "saved" });
  });
});
