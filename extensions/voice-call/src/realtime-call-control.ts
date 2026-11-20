import {
  resolveRealtimeVoiceAgentConsultTools,
  type RealtimeVoiceAgentConsultToolPolicy,
  type RealtimeVoiceTool,
} from "openclaw/plugin-sdk/realtime-voice";

/** Stable provider-facing tool name for ending the current phone call. */
export const REALTIME_VOICE_END_CALL_TOOL_NAME = "openclaw_end_call";

/** Closure-bound end-call control exposed on every realtime phone call. */
const REALTIME_VOICE_END_CALL_TOOL: RealtimeVoiceTool = {
  type: "function",
  name: REALTIME_VOICE_END_CALL_TOOL_NAME,
  description:
    "End the current phone call immediately. Speak any final words to the caller before invoking this tool because the call ends as soon as it is invoked and no further reply will be spoken.",
  parameters: {
    type: "object",
    properties: {},
  },
};

/** Stable provider-facing tool name for pressing keypad keys on the current phone call. */
export const REALTIME_VOICE_SEND_DTMF_TOOL_NAME = "openclaw_send_dtmf";

/** Keypad tones played in-band on the live call audio, for phone menus. */
const REALTIME_VOICE_SEND_DTMF_TOOL: RealtimeVoiceTool = {
  type: "function",
  name: REALTIME_VOICE_SEND_DTMF_TOOL_NAME,
  description:
    "Press keys on the phone keypad during the current call, for example to choose an option in a phone menu or enter a number it asks for. Do not announce or describe the keys, and stay silent while a menu speaks. The result says when the keys were sent.",
  parameters: {
    type: "object",
    properties: {
      digits: {
        type: "string",
        description:
          "Keys to press in order: 0-9, *, #, A-D. A w waits half a second. At most 20 seconds of keys per call.",
      },
    },
    required: ["digits"],
  },
};

/** Stable provider-facing tool name for adding the owner to a room call. */
export const REALTIME_VOICE_ADD_OWNER_TOOL_NAME = "openclaw_add_owner";

/** Room calls only: ring the owner and add them to the call as a third participant. */
export function buildAddOwnerTool(ownerName: string): RealtimeVoiceTool {
  return {
    type: "function",
    name: REALTIME_VOICE_ADD_OWNER_TOOL_NAME,
    description: `Ring ${ownerName}'s phone and add ${ownerName} to this call, so that ${ownerName}, the other person and you can all talk. Use it when a live person is on the line and your task says to bring ${ownerName} in, or when only ${ownerName} can answer. When ${ownerName} later tells you to go, say goodbye and call ${REALTIME_VOICE_END_CALL_TOOL_NAME}: only you leave, and ${ownerName} and the other person stay connected.`,
    parameters: { type: "object", properties: {} },
  };
}

/** Merge built-in call controls with consult and configured realtime tools. */
export function resolveVoiceCallRealtimeTools(
  policy: RealtimeVoiceAgentConsultToolPolicy,
  customTools: RealtimeVoiceTool[] = [],
  roomTools: RealtimeVoiceTool[] = [],
): RealtimeVoiceTool[] {
  const builtIn = [REALTIME_VOICE_END_CALL_TOOL, REALTIME_VOICE_SEND_DTMF_TOOL, ...roomTools];
  const tools = resolveRealtimeVoiceAgentConsultTools(policy, customTools).filter(
    (tool) => !builtIn.some((control) => control.name === tool.name),
  );
  return [...builtIn, ...tools];
}
