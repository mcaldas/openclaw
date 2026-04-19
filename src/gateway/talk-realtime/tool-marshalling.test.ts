import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import { marshalAgentToolsForRealtime } from "./tool-marshalling.js";

function mkTool(name: string, schema: unknown, description = ""): AnyAgentTool {
  return {
    name,
    description,
    parameters: schema,
  } as unknown as AnyAgentTool;
}

describe("marshalAgentToolsForRealtime", () => {
  it("maps object-root schemas into RealtimeVoiceTool shape", () => {
    const tools = [
      mkTool(
        "read",
        {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
        "Read a file.",
      ),
    ];
    const result = marshalAgentToolsForRealtime(tools);
    expect(result.skipped).toEqual([]);
    expect(result.tools).toEqual([
      {
        type: "function",
        name: "read",
        description: "Read a file.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ]);
  });

  it("preserves tool order (prompt-cache stability)", () => {
    const tools = [
      mkTool("alpha", { type: "object", properties: {} }),
      mkTool("bravo", { type: "object", properties: {} }),
      mkTool("charlie", { type: "object", properties: {} }),
    ];
    const result = marshalAgentToolsForRealtime(tools);
    expect(result.tools.map((t) => t.name)).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("drops tools with missing parameters and records a skip reason", () => {
    const tools = [
      mkTool("no-schema", undefined),
      mkTool("ok", { type: "object", properties: {} }),
    ];
    const result = marshalAgentToolsForRealtime(tools);
    expect(result.tools.map((t) => t.name)).toEqual(["ok"]);
    expect(result.skipped).toEqual([{ name: "no-schema", reason: "missing parameters schema" }]);
  });

  it("flattens TypeBox union-root schemas via the OpenAI normalization", () => {
    // Simulates TypeBox's `Type.Union([Type.Object(...), Type.Object(...)])`
    // output where there is no top-level `type` and the root is `anyOf`.
    const unionSchema = {
      anyOf: [
        {
          type: "object",
          properties: { action: { const: "start" } },
          required: ["action"],
        },
        {
          type: "object",
          properties: { action: { const: "stop" } },
          required: ["action"],
        },
      ],
    };
    const result = marshalAgentToolsForRealtime([mkTool("union", unionSchema)]);
    expect(result.skipped).toEqual([]);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]?.parameters.type).toBe("object");
    expect(Object.keys(result.tools[0]?.parameters.properties ?? {})).toContain("action");
  });

  it("drops a tool whose schema cannot reduce to type:object", () => {
    // Realtime tools must be object-rooted. A pure-array schema can't be
    // represented.
    const result = marshalAgentToolsForRealtime([
      mkTool("array-only", { type: "array", items: { type: "string" } }),
    ]);
    expect(result.tools).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.name).toBe("array-only");
  });

  it("tolerates schemas without properties by emitting an empty properties object", () => {
    const result = marshalAgentToolsForRealtime([mkTool("empty", { type: "object" })]);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]?.parameters).toEqual({
      type: "object",
      properties: {},
    });
  });
});
