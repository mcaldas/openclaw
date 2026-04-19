import { describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceToolCallEvent,
} from "../../realtime-voice/provider-types.js";
import { createToolDispatcher } from "./tool-dispatch.js";

function makeBridge(): RealtimeVoiceBridge & {
  _submitted: Array<{ callId: string; result: unknown }>;
} {
  const submitted: Array<{ callId: string; result: unknown }> = [];
  return {
    _submitted: submitted,
    connect: vi.fn(async () => {}),
    sendAudio: vi.fn(),
    setMediaTimestamp: vi.fn(),
    submitToolResult: (callId, result) => {
      submitted.push({ callId, result });
    },
    acknowledgeMark: vi.fn(),
    close: vi.fn(),
    isConnected: () => true,
  };
}

type LooseExecute = (...args: unknown[]) => Promise<unknown>;

function mkTool(
  name: string,
  execute: LooseExecute = async () => ({
    content: [{ type: "text", text: "ok" }],
    details: undefined,
  }),
): AnyAgentTool {
  return {
    name,
    label: name,
    description: `Tool ${name}`,
    parameters: { type: "object", properties: {} },
    execute,
  } as unknown as AnyAgentTool;
}

function mkCall(
  name: string,
  overrides: Partial<RealtimeVoiceToolCallEvent> = {},
): RealtimeVoiceToolCallEvent {
  return {
    itemId: `item-${name}`,
    callId: `call-${name}`,
    name,
    args: {},
    ...overrides,
  };
}

describe("createToolDispatcher", () => {
  it("executes a known tool and posts the result string via submitToolResult", async () => {
    const bridge = makeBridge();
    const executed: string[] = [];
    const dispatcher = createToolDispatcher({
      tools: [
        mkTool("hello", async () => {
          executed.push("hello");
          return {
            content: [{ type: "text", text: "world" }],
            details: undefined,
          };
        }),
      ],
      bridge,
    });
    dispatcher.dispatch(mkCall("hello"));
    await dispatcher.drain();
    expect(executed).toEqual(["hello"]);
    expect(bridge._submitted).toEqual([{ callId: "call-hello", result: "world" }]);
  });

  it("emits onStarted immediately and onFinished after execution", async () => {
    const bridge = makeBridge();
    const started: unknown[] = [];
    const finished: unknown[] = [];
    const dispatcher = createToolDispatcher({
      tools: [mkTool("hello")],
      bridge,
      onStarted: (event) => started.push(event),
      onFinished: (event) => finished.push(event),
    });
    dispatcher.dispatch(mkCall("hello"));
    // onStarted fires synchronously from dispatch.
    expect(started).toEqual([{ callId: "call-hello", name: "hello" }]);
    expect(finished).toEqual([]);
    await dispatcher.drain();
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      callId: "call-hello",
      name: "hello",
      ok: true,
    });
  });

  it("short-circuits voice-disabled tools with the spoken-hint payload", async () => {
    const bridge = makeBridge();
    const disabledExecute = vi.fn(async () => ({
      content: [{ type: "text", text: "should not run" }],
      details: undefined,
    }));
    const dispatcher = createToolDispatcher({
      tools: [mkTool("exec", disabledExecute)],
      bridge,
    });
    dispatcher.dispatch(mkCall("exec"));
    await dispatcher.drain();
    expect(disabledExecute).not.toHaveBeenCalled();
    expect(bridge._submitted).toHaveLength(1);
    expect(bridge._submitted[0]?.result).toEqual({
      error: "approval_required",
      tool: "exec",
      message: "For that I'd need to run exec. Easiest to switch to chat and I'll do it there.",
      spokenHint: true,
    });
  });

  it("returns tool_not_found for unknown tool names", async () => {
    const bridge = makeBridge();
    const dispatcher = createToolDispatcher({
      tools: [mkTool("read")],
      bridge,
    });
    dispatcher.dispatch(mkCall("nonexistent"));
    await dispatcher.drain();
    expect(bridge._submitted).toHaveLength(1);
    expect(bridge._submitted[0]?.result).toMatchObject({
      error: "tool_not_found",
    });
  });

  it("reports tool_execution_failed when the tool throws", async () => {
    const bridge = makeBridge();
    const errorSpy = vi.fn();
    const dispatcher = createToolDispatcher({
      tools: [
        mkTool("boom", async () => {
          throw new Error("kaboom");
        }),
      ],
      bridge,
      onError: errorSpy,
    });
    dispatcher.dispatch(mkCall("boom"));
    await dispatcher.drain();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(bridge._submitted[0]?.result).toEqual({
      error: "tool_execution_failed",
      message: "kaboom",
    });
  });

  it("joins multiple text blocks into the output string", async () => {
    const bridge = makeBridge();
    const dispatcher = createToolDispatcher({
      tools: [
        mkTool("multi", async () => ({
          content: [
            { type: "text", text: "line one" },
            { type: "text", text: "line two" },
          ],
          details: undefined,
        })),
      ],
      bridge,
    });
    dispatcher.dispatch(mkCall("multi"));
    await dispatcher.drain();
    expect(bridge._submitted[0]?.result).toBe("line one\nline two");
  });

  it("stubs image-only results with a placeholder", async () => {
    const bridge = makeBridge();
    const dispatcher = createToolDispatcher({
      tools: [
        mkTool("snap", async () => ({
          content: [
            { type: "image", image: "data:image/png;base64,xxxx" },
            { type: "image", image: "data:image/png;base64,yyyy" },
          ] as never,
          details: undefined,
        })),
      ],
      bridge,
    });
    dispatcher.dispatch(mkCall("snap"));
    await dispatcher.drain();
    expect(bridge._submitted[0]?.result).toBe("[2 images omitted in voice mode]");
  });

  it("runs concurrent calls in parallel and reports each distinctly", async () => {
    const bridge = makeBridge();
    let resolveA!: (text: string) => void;
    let resolveB!: (text: string) => void;
    const dispatcher = createToolDispatcher({
      tools: [
        mkTool(
          "alpha",
          () =>
            new Promise((r) => {
              resolveA = (text) => r({ content: [{ type: "text", text }], details: undefined });
            }),
        ),
        mkTool(
          "bravo",
          () =>
            new Promise((r) => {
              resolveB = (text) => r({ content: [{ type: "text", text }], details: undefined });
            }),
        ),
      ],
      bridge,
    });
    dispatcher.dispatch(mkCall("alpha"));
    dispatcher.dispatch(mkCall("bravo"));
    // Resolve bravo first to show order independence.
    resolveB("B-done");
    resolveA("A-done");
    await dispatcher.drain();
    expect(bridge._submitted.map((s) => s.callId).toSorted()).toEqual(["call-alpha", "call-bravo"]);
  });
});
