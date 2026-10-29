import { describe, expect, it } from "vitest";
import type { StreamEvent } from "@/lib/stream-events";
import { applyEvent, type Entry } from "./use-support-session";

const fold = (events: StreamEvent[], start: Entry[] = []) =>
  events.reduce(applyEvent, start);

describe("applyEvent", () => {
  it("streams tokens into one assistant message and closes it on tool activity", () => {
    const entries = fold([
      { type: "token", text: "Vou " },
      { type: "token", text: "consultar." },
      {
        type: "tool_call",
        id: "1",
        name: "consultar_chamado",
        args: { id: "CH-101" },
      },
      {
        type: "tool_result",
        id: "1",
        name: "consultar_chamado",
        status: "success",
        attempts: 2,
      },
    ]);

    expect(entries).toEqual([
      { type: "assistant", text: "Vou consultar.", streaming: false },
      {
        type: "activity",
        items: [
          {
            kind: "call",
            id: "1",
            name: "consultar_chamado",
            args: { id: "CH-101" },
          },
          {
            kind: "result",
            id: "1",
            name: "consultar_chamado",
            status: "success",
            attempts: 2,
            error: undefined,
          },
        ],
      },
    ]);
  });

  it("adds a final reply that was not streamed (e.g. the registration result)", () => {
    const entries = fold([
      {
        type: "done",
        outcome: {
          status: "completed",
          reply: "Escalonamento ESC-0001 registrado para o CH-101.",
        },
      },
    ]);
    expect(entries).toEqual([
      {
        type: "assistant",
        text: "Escalonamento ESC-0001 registrado para o CH-101.",
      },
    ]);
  });

  it("does not duplicate a reply that was already streamed", () => {
    const entries = fold([
      { type: "token", text: "Abertos: CH-101, CH-103" },
      {
        type: "done",
        outcome: { status: "completed", reply: "Abertos: CH-101, CH-103" },
      },
    ]);
    expect(entries).toEqual([
      { type: "assistant", text: "Abertos: CH-101, CH-103", streaming: false },
    ]);
  });

  it("shows failures as errors and replays as notices", () => {
    const entries = fold([
      {
        type: "done",
        outcome: {
          status: "failed",
          reply: "Execução interrompida.",
          error: { code: "LIMIT_EXCEEDED", message: "x" },
        },
      },
      {
        type: "done",
        outcome: {
          status: "already_processed",
          resolution: "approved",
          escalonamento: { id: "ESC-0001" },
        },
      },
    ]);
    expect(entries[0]).toEqual({
      type: "error",
      text: "Execução interrompida.",
    });
    expect(entries[1]).toMatchObject({
      type: "notice",
      text: expect.stringContaining("ESC-0001"),
    });
  });
});
