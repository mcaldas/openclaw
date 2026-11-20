import { escapeXml } from "../voice-mapping.js";

/** Generate TwiML that speaks one notification and hangs up. */
export function generateNotifyTwiml(message: string, voice: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}">${escapeXml(message)}</Say>
  <Hangup/>
</Response>`;
}

/**
 * TwiML that (re)joins a call's conference room, optionally pressing keys first. Keys sent with
 * <Play digits> travel out of band (RFC 2833), the only kind Twilio menus and Israeli IVRs read.
 */
export function generateRoomTwiml(room: string, digits?: string): string {
  const play = digits ? `\n  <Play digits="${escapeXml(digits)}" />` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>${play}
  <Dial><Conference beep="false" waitUrl="" startConferenceOnEnter="true" endConferenceOnExit="false" jitterBufferSize="small">${escapeXml(room)}</Conference></Dial>
</Response>`;
}

/** Hold music for queued inbound callers. */
export const HOLD_MUSIC_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">All agents are currently busy. Please hold.</Say>
  <Play loop="0">https://s3.amazonaws.com/com.twilio.music.classical/BusyStrings.mp3</Play>
</Response>`;

/** TwiML that connects the call to a bidirectional realtime media stream. */
export function generateRealtimeStreamTwiml(streamUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;
}

/** Generate TwiML that plays DTMF digits before redirecting to a webhook URL. */
export function generateDtmfRedirectTwiml(digits: string, webhookUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play digits="${escapeXml(digits)}" />
  <Redirect method="POST">${escapeXml(webhookUrl)}</Redirect>
</Response>`;
}
