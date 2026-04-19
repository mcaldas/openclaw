import { normalizeToolParameterSchema } from "../../agents/pi-tools.schema.js";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import type { RealtimeVoiceTool } from "../../realtime-voice/provider-types.js";

/**
 * Convert an OpenClaw `AnyAgentTool[]` into the OpenAI-realtime
 * function-tool shape. The heavy lifting is reused: the existing text-
 * chat pipeline already runs `normalizeToolParameterSchema` with the
 * OpenAI provider hint, which flattens TypeBox union roots, strips
 * unsupported keywords, and guarantees a `type: "object"` root. We
 * invoke the same normalization here so voice tool schemas match what
 * text chat produces for OpenAI byte-for-byte.
 *
 * Tools whose schema cannot be reduced to `type: "object"` after
 * normalization are dropped; the caller receives a `skipped` list it
 * can log. This preserves prompt-cache stability (bad-schema tools
 * silently drop) rather than emitting malformed frames to the upstream
 * realtime WS.
 *
 * Tool ordering is preserved verbatim: `AgentTool` order is the same
 * order the agent pipeline gives to text chat; preserving it in the
 * `session.update.tools` payload keeps the cached prefix byte-identical
 * between voice and text turns where possible.
 */
export type MarshalToolsResult = {
  tools: RealtimeVoiceTool[];
  skipped: Array<{ name: string; reason: string }>;
};

export function marshalAgentToolsForRealtime(tools: AnyAgentTool[]): MarshalToolsResult {
  const out: RealtimeVoiceTool[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const tool of tools) {
    if (!tool.name) {
      skipped.push({ name: "(anonymous)", reason: "missing name" });
      continue;
    }
    const rawSchema =
      tool.parameters && typeof tool.parameters === "object"
        ? (tool.parameters as Record<string, unknown>)
        : undefined;
    if (!rawSchema) {
      skipped.push({ name: tool.name, reason: "missing parameters schema" });
      continue;
    }
    // Normalize for OpenAI to get a flattened `type:"object"` schema.
    const normalized = normalizeToolParameterSchema(rawSchema, {
      modelProvider: "openai",
    });
    const sanitized = sanitizeForRealtime(normalized);
    if (!sanitized) {
      skipped.push({ name: tool.name, reason: "schema does not reduce to object root" });
      continue;
    }
    const description = typeof tool.description === "string" ? tool.description : "";
    out.push({
      type: "function",
      name: tool.name,
      description,
      parameters: sanitized,
    });
  }
  return { tools: out, skipped };
}

/**
 * Verify the schema is an object-root with properties, and coerce it
 * into the `RealtimeVoiceTool["parameters"]` shape. Returns `null` when
 * the schema cannot be safely represented.
 */
function sanitizeForRealtime(schema: unknown): RealtimeVoiceTool["parameters"] | null {
  if (!schema || typeof schema !== "object") {
    return null;
  }
  const record = schema as Record<string, unknown>;
  if (record.type !== "object") {
    return null;
  }
  const propsRaw = record.properties;
  if (!propsRaw || typeof propsRaw !== "object") {
    // Empty-property schemas are acceptable; record this as an empty map
    // rather than dropping the tool entirely.
    return {
      type: "object",
      properties: {},
    };
  }
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(propsRaw as Record<string, unknown>)) {
    properties[key] = value;
  }
  const required = Array.isArray(record.required)
    ? record.required.filter((v): v is string => typeof v === "string")
    : undefined;
  return {
    type: "object",
    properties,
    ...(required && required.length > 0 ? { required } : {}),
  };
}
