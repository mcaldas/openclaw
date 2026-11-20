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
    "Press keys on the phone keypad during the current call, for example to choose an option in a phone menu or enter a number it asks for. The tones play on the line; do not speak while they play. The result says when the keys were sent.",
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

/** Merge built-in call controls with consult and configured realtime tools. */
export function resolveVoiceCallRealtimeTools(
  policy: RealtimeVoiceAgentConsultToolPolicy,
  customTools: RealtimeVoiceTool[] = [],
): RealtimeVoiceTool[] {
  const builtIn = [REALTIME_VOICE_END_CALL_TOOL, REALTIME_VOICE_SEND_DTMF_TOOL];
  const tools = resolveRealtimeVoiceAgentConsultTools(policy, customTools).filter(
    (tool) => !builtIn.some((control) => control.name === tool.name),
  );
  return [...builtIn, ...tools];
}
