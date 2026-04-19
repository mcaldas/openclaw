/**
 * Barrel for the gateway-side `talk.realtime` WS bridge. Internal to the
 * gateway host; not part of the Plugin SDK public surface.
 *
 * See docs/voice/gateway-realtime-bridge.md.
 */

export {
  decodeClientFrame,
  encodeServerEvent,
  TALK_REALTIME_AUDIO,
  TALK_REALTIME_CLOSE,
  TALK_REALTIME_WS_PATH,
  type TalkRealtimeAudio,
  type TalkRealtimeClientEvent,
  type TalkRealtimeCloseCode,
  type TalkRealtimeServerEvent,
} from "./protocol.js";

export {
  TalkRealtimeTicketRegistry,
  type RedeemResult,
  type TalkRealtimeTicket,
  type TalkRealtimeTicketInput,
  type TalkRealtimeTicketRegistryOptions,
} from "./ticket-registry.js";

export {
  VoiceRunRegistry,
  type RegisterResult,
  type VoiceRunEvictReason,
  type VoiceRunHandle,
} from "./voice-run-registry.js";

export {
  createTalkRealtimeSession,
  type TalkRealtimeSession,
  type TalkRealtimeSessionDeps,
} from "./session.js";

export {
  createTalkRealtimeHost,
  type TalkRealtimeBridgeFactory,
  type TalkRealtimeBridgeSessionHandlers,
  type TalkRealtimeHost,
  type TalkRealtimeHostDeps,
} from "./upgrade-host.js";

export {
  createDefaultTalkRealtimeBridgeFactory,
  type TalkRealtimeBridgeFactoryDeps,
} from "./bridge-factory.js";
