/**
 * Stops a model that calls tools in a loop. Gemini answers every tool result, and on a 20-minute
 * lab hold it called the same tool 760 times (30-74 a minute, each a billed turn). Normal calls use
 * a handful of tools a minute; past `maxPerMinute` the call is ended (in a room, Jarvis leaves).
 */
export function createToolCallGuard(params: {
  maxPerMinute?: number;
  now?: () => number;
  onLoop: (callId: string, callsInLastMinute: number) => void;
}) {
  const max = params.maxPerMinute ?? 20;
  const now = params.now ?? Date.now;
  const recent = new Map<string, number[]>();
  return {
    /** Records a tool call; false once the call is looping (the tool should not run). */
    note(callId: string): boolean {
      const at = now();
      const calls = (recent.get(callId) ?? []).filter((t) => at - t < 60_000);
      calls.push(at);
      recent.set(callId, calls);
      if (calls.length <= max) {
        return true;
      }
      if (calls.length === max + 1) {
        params.onLoop(callId, calls.length);
      }
      return false;
    },
  };
}
