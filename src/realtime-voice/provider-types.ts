import type { OpenClawConfig } from "../config/types.openclaw.js";

export type RealtimeVoiceProviderId = string;

export type RealtimeVoiceRole = "user" | "assistant";

export type RealtimeVoiceCloseReason = "completed" | "error";

export type RealtimeVoiceTool = {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export type RealtimeVoiceToolCallEvent = {
  itemId: string;
  callId: string;
  name: string;
  args: unknown;
};

/**
 * Audio wire format. `g711_ulaw` is the historical Twilio / voice-call default
 * (8 kHz, 8-bit mu-law). `pcm16` is 16-bit little-endian signed PCM at the
 * sample rate agreed between the caller and the provider (24 kHz for the
 * gateway-proxied iOS voice bridge).
 */
export type RealtimeVoiceAudioFormat = "g711_ulaw" | "pcm16";

export type RealtimeVoiceBridgeCallbacks = {
  onAudio: (audio: Buffer) => void;
  onClearAudio: () => void;
  onMark?: (markName: string) => void;
  onTranscript?: (role: RealtimeVoiceRole, text: string, isFinal: boolean) => void;
  onToolCall?: (event: RealtimeVoiceToolCallEvent) => void;
  onReady?: () => void;
  onError?: (error: Error) => void;
  onClose?: (reason: RealtimeVoiceCloseReason) => void;
};

export type RealtimeVoiceProviderConfig = Record<string, unknown>;

export type RealtimeVoiceProviderResolveConfigContext = {
  cfg: OpenClawConfig;
  rawConfig: RealtimeVoiceProviderConfig;
};

export type RealtimeVoiceProviderConfiguredContext = {
  cfg?: OpenClawConfig;
  providerConfig: RealtimeVoiceProviderConfig;
};

export type RealtimeVoiceBridgeCreateRequest = RealtimeVoiceBridgeCallbacks & {
  providerConfig: RealtimeVoiceProviderConfig;
  instructions?: string;
  tools?: RealtimeVoiceTool[];
  /**
   * Audio wire format for both input and output. When unset, defaults to
   * `g711_ulaw` to preserve the voice-call / Twilio contract that was in
   * place before this field existed. The gateway-proxied iOS voice bridge
   * passes `pcm16`.
   */
  audioFormat?: RealtimeVoiceAudioFormat;
};

/**
 * Realtime conversation item the gateway may seed before the first
 * `response.create`. Intentionally a narrow subset of the upstream
 * OpenAI realtime shape: text-only roles, no audio attachments. The
 * voice bridge uses this to splice a short history tail without having
 * to reach into provider-internal event shapes.
 */
export type RealtimeConversationItem = {
  type: "message";
  role: "user" | "assistant" | "system";
  content: Array<{ type: "input_text" | "text"; text: string }>;
};

export type RealtimeVoiceBridge = {
  connect(): Promise<void>;
  sendAudio(audio: Buffer): void;
  setMediaTimestamp(ts: number): void;
  sendUserMessage?(text: string): void;
  /**
   * Inject a realtime conversation item WITHOUT kicking off a
   * `response.create`. Used by the gateway voice bridge to seed the
   * session with recent chat-history turns before the first realtime
   * response. Optional so existing providers that have not opted in
   * keep their current contract; callers should feature-check it.
   */
  sendConversationItem?(item: RealtimeConversationItem): void;
  triggerGreeting?(instructions?: string): void;
  submitToolResult(callId: string, result: unknown): void;
  acknowledgeMark(): void;
  close(): void;
  isConnected(): boolean;
};
