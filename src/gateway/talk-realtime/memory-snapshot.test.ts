import { describe, expect, it } from "vitest";
import { formatSnapshotFromMessages } from "./memory-snapshot.js";

function userMsg(text: string) {
  return { role: "user", content: text };
}
function asstMsg(text: string) {
  return { role: "assistant", content: text };
}
function asstBlocks(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

describe("formatSnapshotFromMessages", () => {
  it("maps user/assistant messages into conversation.item.create payloads", () => {
    const items = formatSnapshotFromMessages([userMsg("hello"), asstMsg("hi there")], {
      maxChars: 10_000,
      maxTurns: 10,
    });
    expect(items).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      },
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "hi there" }],
        },
      },
    ]);
  });

  it("flattens array content blocks into a single string", () => {
    const items = formatSnapshotFromMessages([asstBlocks("piece one")], {
      maxChars: 10_000,
      maxTurns: 10,
    });
    expect(items[0]?.item.content[0]?.text).toBe("piece one");
  });

  it("drops messages with unsupported roles or empty content", () => {
    const items = formatSnapshotFromMessages(
      [
        userMsg(""),
        { role: "system", content: "ignored" },
        asstMsg("   \n  "),
        userMsg("real content"),
      ],
      { maxChars: 10_000, maxTurns: 10 },
    );
    expect(items.map((i) => i.item.content[0]?.text)).toEqual(["real content"]);
  });

  it("keeps the TAIL of the transcript when maxTurns is exceeded", () => {
    const messages = Array.from({ length: 20 }).map((_, i) =>
      i % 2 === 0 ? userMsg(`u${i}`) : asstMsg(`a${i}`),
    );
    const items = formatSnapshotFromMessages(messages, { maxChars: 10_000, maxTurns: 4 });
    expect(items.map((i) => i.item.content[0]?.text)).toEqual(["u16", "a17", "u18", "a19"]);
  });

  it("trims oldest turns first when maxChars is exceeded", () => {
    const items = formatSnapshotFromMessages(
      [userMsg("A".repeat(60)), userMsg("B".repeat(60)), userMsg("C".repeat(60))],
      { maxChars: 120, maxTurns: 10 },
    );
    // Only the two newest fit in 120 chars (60 * 2 = 120).
    expect(items.map((i) => i.item.content[0]?.text)).toEqual(["B".repeat(60), "C".repeat(60)]);
  });

  it("returns empty when every message is filtered out", () => {
    const items = formatSnapshotFromMessages([{}, { role: "system", content: "x" }], {
      maxChars: 1000,
      maxTurns: 10,
    });
    expect(items).toEqual([]);
  });
});
