import type {
  AnswerCallInput,
  GetCallStatusInput,
  GetCallStatusResult,
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  PlayTtsInput,
  ProviderName,
  SendDtmfInput,
  WebhookParseOptions,
  ProviderWebhookParseResult,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookVerificationResult,
} from "../types.js";

/** Provider-side call recordings, downloaded after the call and then deleted at the provider. */
export type CallRecordingApi = {
  start(providerCallId: string): Promise<{ id: string }>;
  list(providerCallId: string): Promise<{ id: string; ready: boolean; durationSeconds: number }[]>;
  download(recordingId: string): Promise<Buffer>;
  delete(recordingId: string): Promise<void>;
};

/** A leg added to a call's conference room. */
export type RoomParticipantInput = {
  to: string;
  from: string;
  statusCallback: string;
  /** Seconds to ring before giving up (default 30). */
  timeoutSeconds?: number;
  /** Record this leg, one side per channel. */
  record?: boolean;
  /** Report whether a person or a voicemail answered, to the status callback with check=voicemail. */
  detectVoicemail?: boolean;
  /** Hard cap on the leg, so it cannot outlive a crashed gateway for long. */
  timeLimitSeconds?: number;
};

/** Conference rooms: the call's legs meet in a room, so keys, a third person and hand-over work. */
export type CallRoomApi = {
  addParticipant(
    room: string,
    input: RoomParticipantInput,
  ): Promise<{ callSid: string; conferenceSid?: string }>;
  /** Press keys on one leg: it steps out of the room for a moment and comes back. */
  pressKeys(callSid: string, room: string, digits: string): Promise<void>;
  /** End one leg only. */
  hangupLeg(callSid: string): Promise<void>;
};

export interface VoiceCallProvider {
  readonly name: ProviderName;

  /** Call recording, when the provider supports it. */
  readonly recordings?: CallRecordingApi;

  /** Conference rooms, when the provider supports them. */
  readonly room?: CallRoomApi;

  setPublicUrl?(url: string): void;

  /** Defer conversation greeting/listening until the configured stream connects. */
  isConversationStreamConnectEnabled?(): boolean;

  /**
   * Verify webhook signature/HMAC before processing.
   * Must be called before parseWebhookEvent.
   */
  verifyWebhook(ctx: WebhookContext): WebhookVerificationResult;

  parseWebhookEvent(ctx: WebhookContext, options?: WebhookParseOptions): ProviderWebhookParseResult;

  /**
   * Consume one-time TwiML that must be served before shortcut handlers such as
   * realtime media streams take over the webhook response.
   */
  consumeInitialTwiML?: (ctx: WebhookContext) => string | null;

  initiateCall(input: InitiateCallInput): Promise<InitiateCallResult>;

  /**
   * Answer an accepted inbound call when the provider requires an explicit
   * answer command after the initial webhook.
   */
  answerCall?: (input: AnswerCallInput) => Promise<void>;

  hangupCall(input: HangupCallInput): Promise<void>;

  /**
   * Play TTS audio to the caller.
   * The provider should handle streaming if supported.
   */
  playTts(input: PlayTtsInput): Promise<void>;

  /** Play a message followed by carrier-owned hangup; acceptance is not completion. */
  playMessageAndHangup?(input: PlayTtsInput): Promise<void>;

  /**
   * Send DTMF digits to an active call.
   */
  sendDtmf?: (input: SendDtmfInput) => Promise<void>;

  startListening(input: StartListeningInput): Promise<void>;

  stopListening(input: StopListeningInput): Promise<void>;

  /**
   * Query provider for current call status.
   * Used to verify persisted calls are still active on restart.
   * Must return `isUnknown: true` for transient errors (network, 5xx)
   * so the caller can keep the call and rely on timer-based fallback.
   */
  getCallStatus(input: GetCallStatusInput): Promise<GetCallStatusResult>;
}

export function assertVoiceCallProviderSetting(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}
