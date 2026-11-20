// The recording-or-person cues, navigation rules and wait / stuck / completed criteria below are
// adapted from Pipecat's IVRNavigator prompts (src/pipecat/extensions/ivr/ivr_navigator.py,
// https://github.com/pipecat-ai/pipecat), BSD 2-Clause License, Copyright (c) 2024-2026, Daily.
// Full licence text: ../assets/THIRD_PARTY_NOTICES.md. Changes: rewritten for a realtime voice
// model that hears the line and presses keys with a tool; Pipecat's "wait" is silence here, and
// "completed" (being transferred) is a hold.
import type { RealtimeVoiceTool } from "openclaw/plugin-sdk/realtime-voice";
import { REALTIME_VOICE_SEND_DTMF_TOOL_NAME } from "./realtime-call-control.js";

export const REALTIME_VOICE_PHONE_MENU_TOOL_NAME = "openclaw_phone_menu";

export const PHONE_MENU_TOOL: RealtimeVoiceTool = {
  type: "function",
  name: REALTIME_VOICE_PHONE_MENU_TOOL_NAME,
  description:
    'Tell the call where you are in a phone menu. "hold": you are being transferred, or only hold music or hold messages are playing; the line goes quiet for you until a person speaks. "stuck": the menu has nothing for your task or keeps repeating. Say nothing when you call it.',
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["hold", "stuck"] },
    },
    required: ["status"],
  },
};

export const PHONE_MENU_INSTRUCTIONS = `Phone menus and hold.
Recording or person? These are recordings: menu options ("Press 1 for billing", "Press 0 to speak to an agent"); automated instructions ("Please enter your account number", "Say or press your selection"); system prompts ("Thank you for calling", "Your call is important to us", "Please hold while we connect you"); scripted introductions ("Welcome to customer service", "For faster service, have your account number ready"); navigation phrases ("To return to the main menu", "Press star to repeat"); hold messages ("Please continue to hold", "Your estimated wait time is", "Thank you for your patience"); carrier messages ("All circuits are busy", "Due to high call volume"). These are a live person: personal greetings ("Hello, this is Sarah", "Customer service, this is Mike"); questions to you ("Who am I speaking with?", "What can I do for you today?"); natural speech with hesitations and informal words; direct engagement ("I see you're calling about...", "Let me look that up for you", "Can you spell that for me?"); spontaneous replies ("Oh, I can help with that", "Sure, no problem", "Hmm, let me check"). The same cues hold in Hebrew and every other language.
In a menu: press a key with ${REALTIME_VOICE_SEND_DTMF_TOOL_NAME} only when an option fits your task; if several fit, take the most specific or direct one. Enter numbers (dates, account or phone numbers) as one key sequence. When the menu asks you to say something ("Say yes or no", "Please state your name", "What department?"), answer in a few words. If no option fits yet, the list sounds cut off, or the options are for other kinds of callers, stay silent and keep listening: menus often come in waves and waiting is often right. Try general options such as "customer service" or "all other inquiries" when nothing specific fits, and expect several menu levels. Never talk to a recording otherwise, and never announce key presses.
On hold: when a recording says you are being transferred or connected ("Please hold while I transfer you", "Connecting you to...", "One moment please" after your last choice), or only hold music and hold messages play, call ${REALTIME_VOICE_PHONE_MENU_TOOL_NAME} with status "hold" and say nothing. You will hear the line again, from the person's first words, when someone speaks; if it is a person, greet them and continue your task.
Stuck: call ${REALTIME_VOICE_PHONE_MENU_TOOL_NAME} with status "stuck" when you have heard the same menu three times without progress, no option relates to your task, you keep hearing "invalid selection", or the menu asks for information you do not have. Then press the key for an operator or other inquiries if one was offered; otherwise end the call and report that you were stuck.`;

/** What the tool returns; every result makes the model reply, so each one says to stay quiet. */
export function phoneMenuResult(status: unknown, holdNow: (() => boolean) | undefined) {
  if (status === "hold") {
    const holding = holdNow?.() ?? false;
    return {
      ok: true,
      note: holding
        ? "On hold. Say nothing; you will hear the line again when a person speaks."
        : "Say nothing and keep listening.",
    };
  }
  if (status === "stuck") {
    return {
      ok: true,
      note: "Noted. Say nothing to the menu. If it offered a key for an operator or other inquiries, press it; otherwise end the call and report that you were stuck.",
    };
  }
  return { error: 'status must be "hold" or "stuck"' };
}
