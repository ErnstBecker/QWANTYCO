import { describe, expect, it } from "vitest";
import { readSSE } from "./sse-client";

function streamOf(chunks: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]) {
  const events: unknown[] = [];
  for await (const event of readSSE(streamOf(chunks))) events.push(event);
  return events;
}

describe("readSSE", () => {
  it("parses events split across chunks", async () => {
    expect(
      await collect(['data: {"a":', '1}\n\ndata: {"b"', ":2}\n", "\n"]),
    ).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("handles multi-byte characters split across chunks", async () => {
    const bytes = new TextEncoder().encode('data: {"t":"ação"}\n\n');
    // Splitting at byte 14 cuts the two-byte "ç" in half.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 14));
        controller.enqueue(bytes.slice(14));
        controller.close();
      },
    });
    const events: unknown[] = [];
    for await (const event of readSSE(stream)) events.push(event);
    expect(events).toEqual([{ t: "ação" }]);
  });

  it("ignores comments and empty blocks", async () => {
    expect(await collect([": ping\n\n", "data: 1\n\n", "\n\n"])).toEqual([1]);
  });
});
