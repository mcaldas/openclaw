// Ported from LiveKit Agents (livekit-agents/livekit/agents/voice/ivr/ivr_activity.py,
// TfidfLoopDetector), Apache License 2.0, Copyright LiveKit, Inc.
// https://github.com/livekit/agents. Changes: TypeScript, Unicode-aware tokens (Hebrew),
// and `similarity()` exposed so a hold can ask "have I heard this before?" for one chunk.

// Python's `(?u)\b\w\w+\b`: two or more letters, digits or underscores, in any script.
const TOKEN = /[\p{L}\p{N}_]{2,}/gu;

export type LoopDetectorOptions = {
  /** Chunks kept for comparison (default 20). */
  windowSize?: number;
  /** Cosine similarity above which a chunk counts as a repeat (default 0.85). */
  similarityThreshold?: number;
  /** Consecutive repeats that make a loop (default 3). */
  consecutiveThreshold?: number;
};

function tokens(text: string): string[] {
  return text.toLowerCase().match(TOKEN) ?? [];
}

/** TF-IDF (smooth idf, l2-normalised) cosine similarity of the last chunk to each earlier one. */
function lastChunkSimilarities(chunks: readonly string[]): number[] {
  const docs = chunks.map(tokens);
  const vocab = new Map<string, number>();
  for (const doc of docs) {
    for (const token of doc) {
      if (!vocab.has(token)) {
        vocab.set(token, vocab.size);
      }
    }
  }
  if (vocab.size === 0) {
    return [];
  }
  const tf = docs.map((doc) => {
    const row = new Float64Array(vocab.size);
    for (const token of doc) {
      const index = vocab.get(token) ?? 0;
      row[index] = (row[index] ?? 0) + 1;
    }
    return row;
  });
  const df = new Float64Array(vocab.size);
  for (const row of tf) {
    row.forEach((count, index) => {
      if (count > 0) {
        df[index] = (df[index] ?? 0) + 1;
      }
    });
  }
  const idf = Array.from(df, (count) => Math.log((1 + docs.length) / (1 + count)) + 1);
  const vectors = tf.map((row) => {
    const weighted = Array.from(row, (count, index) => count * (idf[index] ?? 1));
    const norm = Math.hypot(...weighted) || 1;
    return weighted.map((value) => value / norm);
  });
  const last = vectors.at(-1) ?? [];
  return vectors
    .slice(0, -1)
    .map((vector) => vector.reduce((sum, value, index) => sum + value * (last[index] ?? 0), 0));
}

export function createLoopDetector(options: LoopDetectorOptions = {}) {
  const windowSize = options.windowSize ?? 20;
  const similarityThreshold = options.similarityThreshold ?? 0.85;
  const consecutiveThreshold = options.consecutiveThreshold ?? 3;
  if (windowSize <= 0 || consecutiveThreshold <= 0) {
    throw new Error("window and consecutive thresholds must be greater than 0");
  }
  if (similarityThreshold < 0 || similarityThreshold > 1) {
    throw new Error("similarity threshold must be between 0 and 1");
  }
  let chunks: string[] = [];
  let consecutive = 0;
  const similarity = (chunk: string) => Math.max(0, ...lastChunkSimilarities([...chunks, chunk]));
  return {
    reset(): void {
      chunks = [];
      consecutive = 0;
    },
    addChunk(chunk: string): void {
      chunks.push(chunk);
      if (chunks.length > windowSize) {
        chunks = chunks.slice(-windowSize);
      }
    },
    /** Highest similarity of `chunk` to the kept chunks, without adding it. */
    similarity,
    /** LiveKit's check: true once the newest chunk repeated an earlier one N times running. */
    checkLoopDetection(): boolean {
      if (chunks.length < 2) {
        return false;
      }
      const similarities = lastChunkSimilarities(chunks);
      if (similarities.length === 0) {
        return false;
      }
      const similar = Math.max(...similarities) > similarityThreshold;
      consecutive = similar ? consecutive + 1 : 0;
      return consecutive >= consecutiveThreshold;
    },
    isRepeat(chunk: string): boolean {
      return similarity(chunk) > similarityThreshold;
    },
  };
}

export type LoopDetector = ReturnType<typeof createLoopDetector>;
