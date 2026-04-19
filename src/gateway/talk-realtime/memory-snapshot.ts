import { loadConfig } from "../../config/config.js";
import { loadSessionStore } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  readSessionMessages,
  resolveFreshestSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTarget,
} from "../session-utils.js";

/**
 * Read the tail of the matching agent's default text-chat session and
 * format it as realtime `conversation.item.create` payloads so the voice
 * model starts with the same recent context as text chat.
 *
 * Why this (instead of calling into `memory-core` for a summary)? The
 * agent's memory surface is driven by the registered context-engine in
 * text chat; duplicating that layer for voice would be a separate
 * plumbing project. Reading the transcript tail picks up
 * `lossless-claw` compression when active (it rewrites the transcript
 * in place) without requiring a voice-specific integration.
 *
 * Size budget is enforced by character count, not tokens. The oldest
 * turns are dropped first so the most recent exchange is always
 * preserved — voice latency favors recency.
 */

export type VoiceMemorySnapshotOptions = {
  sessionKey: string;
  /**
   * Injected for tests. Defaults to the standard config loader.
   */
  loadConfigFn?: () => OpenClawConfig;
  /**
   * Maximum total character count across all injected messages. Oldest
   * messages are dropped first until the payload fits.
   */
  maxChars?: number;
  /**
   * Hard cap on number of turns to inject regardless of size budget.
   * Defaults to 12 (roughly 6 user + 6 assistant turns).
   */
  maxTurns?: number;
};

export type VoiceMemoryItem = {
  type: "conversation.item.create";
  item: {
    type: "message";
    role: "user" | "assistant";
    content: Array<{
      type: "input_text" | "text";
      text: string;
    }>;
  };
};

const DEFAULT_MAX_CHARS = 8_000;
const DEFAULT_MAX_TURNS = 12;

export function loadVoiceMemorySnapshot(opts: VoiceMemorySnapshotOptions): VoiceMemoryItem[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const cfg = (opts.loadConfigFn ?? loadConfig)();
  const target = resolveGatewaySessionStoreTarget({ cfg, key: opts.sessionKey });
  const store = loadSessionStore(target.storePath);
  const entry = resolveFreshestSessionEntryFromStoreKeys(store, target.storeKeys);
  if (!entry?.sessionId) {
    return [];
  }
  const messages = readSessionMessages(entry.sessionId, target.storePath, entry.sessionFile);
  return formatSnapshotFromMessages(messages, { maxChars, maxTurns });
}

/**
 * Pure transform from the raw transcript-message list (as returned by
 * `readSessionMessages`) into realtime `conversation.item.create`
 * payloads. Exported so unit tests can assert the selection / budget
 * behavior without touching the filesystem.
 */
export function formatSnapshotFromMessages(
  messages: readonly unknown[],
  opts: { maxChars: number; maxTurns: number },
): VoiceMemoryItem[] {
  const pruned: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const message of messages) {
    const entry = normalizeTranscriptMessage(message);
    if (!entry) {
      continue;
    }
    pruned.push(entry);
  }
  // Keep the tail, not the head: most recent N turns, fitting the char budget.
  const startIdx = Math.max(0, pruned.length - opts.maxTurns);
  let windowed = pruned.slice(startIdx);
  while (windowed.length > 0 && totalChars(windowed) > opts.maxChars) {
    windowed = windowed.slice(1);
  }
  return windowed.map((entry) => ({
    type: "conversation.item.create" as const,
    item: {
      type: "message" as const,
      role: entry.role,
      content: [
        {
          type: entry.role === "user" ? ("input_text" as const) : ("text" as const),
          text: entry.text,
        },
      ],
    },
  }));
}

function totalChars(entries: Array<{ text: string }>): number {
  let n = 0;
  for (const e of entries) {
    n += e.text.length;
  }
  return n;
}

function normalizeTranscriptMessage(
  message: unknown,
): { role: "user" | "assistant"; text: string } | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const record = message as Record<string, unknown>;
  const role = record.role;
  if (role !== "user" && role !== "assistant") {
    return null;
  }
  const content = record.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object") {
        const blockRecord = block as Record<string, unknown>;
        const blockText = blockRecord.text;
        if (typeof blockText === "string") {
          text += text.length > 0 ? `\n${blockText}` : blockText;
        }
      }
    }
  }
  text = text.trim();
  if (text.length === 0) {
    return null;
  }
  return { role, text };
}
