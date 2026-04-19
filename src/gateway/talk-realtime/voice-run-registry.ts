/**
 * Tracks active realtime voice runs keyed by agent id.
 *
 * Correctness constraint (not abuse prevention): at most one active
 * realtime WS per agent. Two concurrent WSs would interleave transcript
 * writes into the same chat session. When a new `talk.realtime.start`
 * beats an existing run, the existing run is evicted with
 * `TALK_REALTIME_CLOSE.REPLACED_BY_NEWER`.
 *
 * This registry owns only the lifecycle signal (evict callback); the
 * caller owns the WS / bridge instances and is responsible for invoking
 * `register`, `markReady`, and `unregister` in the right order.
 */

export type VoiceRunEvictReason = "replaced_by_newer" | "session_ended" | "bridge_error";

export type VoiceRunHandle = {
  voiceRunId: string;
  agentId: string;
  operatorConnId: string;
  startedAtMs: number;
  /**
   * Called when the registry decides to evict this run. The handler is
   * expected to close the WS + bridge. Must be idempotent: the registry
   * may call it at most once, but the caller may also call `unregister`
   * after a self-initiated close.
   */
  evict: (reason: VoiceRunEvictReason) => void;
};

export type RegisterResult = {
  previous: VoiceRunHandle | null;
};

export class VoiceRunRegistry {
  private readonly byAgent = new Map<string, VoiceRunHandle>();
  private readonly byRunId = new Map<string, VoiceRunHandle>();

  /**
   * Register a new run. If an earlier run exists for the same agent, it
   * is evicted with `replaced_by_newer` before the new run is stored.
   * The evicted handle is returned for logging / diagnostics.
   */
  register(handle: VoiceRunHandle): RegisterResult {
    const existing = this.byAgent.get(handle.agentId) ?? null;
    if (existing) {
      this.byAgent.delete(existing.agentId);
      this.byRunId.delete(existing.voiceRunId);
      try {
        existing.evict("replaced_by_newer");
      } catch {
        // Eviction handlers must not throw; swallow to avoid losing the
        // new registration. The caller logs from its own hook.
      }
    }
    this.byAgent.set(handle.agentId, handle);
    this.byRunId.set(handle.voiceRunId, handle);
    return { previous: existing };
  }

  /**
   * Remove a run from the registry (self-close path). Does NOT invoke
   * `evict`; the caller is already closing the WS. Safe no-op if the
   * run is unknown.
   */
  unregister(voiceRunId: string): void {
    const handle = this.byRunId.get(voiceRunId);
    if (!handle) {
      return;
    }
    this.byRunId.delete(voiceRunId);
    const sameAgent = this.byAgent.get(handle.agentId);
    if (sameAgent && sameAgent.voiceRunId === voiceRunId) {
      this.byAgent.delete(handle.agentId);
    }
  }

  getByAgent(agentId: string): VoiceRunHandle | undefined {
    return this.byAgent.get(agentId);
  }

  getByRunId(voiceRunId: string): VoiceRunHandle | undefined {
    return this.byRunId.get(voiceRunId);
  }

  /** Testing helper. */
  _size(): number {
    return this.byRunId.size;
  }
}
