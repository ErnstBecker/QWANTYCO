/**
 * Acceptance suite for the assistants: support and travel are two
 * configurations of the same graph and executor. Every test goes through the
 * HTTP handlers; only the model is a scripted double.
 */
import { ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handleChat, handleGetSession } from "./http/handlers";
import { createTicketRepository } from "./mocks/stores";
import { reply, toolCall, type ScriptStep } from "./testing/scripted-model";
import {
  createHarness,
  outcomeOf,
  post,
  readEvents,
  toolResults,
} from "./testing/http";
import type { TicketRepository } from "./tickets/store";

type Harness = ReturnType<typeof createHarness>;
type AssistantId = "support" | "travel";

const chat = async (
  h: Harness,
  assistantId: AssistantId,
  sessionId: string,
  message: string,
) =>
  readEvents(
    await handleChat(post({ sessionId, assistantId, message }), h.service),
  );

const lastToolResult = (messages: BaseMessage[]) =>
  JSON.parse(messages.filter(ToolMessage.isInstance).at(-1)!.text);

/** Cites every source returned by call_rag, as a grounded model would. */
const citeSources: ScriptStep = (messages) => {
  const result = lastToolResult(messages);
  const fontes: string[] = result.data.trechos.map(
    (t: { fonte: string }) => `[${t.fonte}]`,
  );
  return reply(
    fontes.length
      ? `Base simulada. Documentos exigidos: ${fontes.join(" ")}`
      : "A base simulada não contém essa informação.",
  );
};

/** Repository that counts reads, to prove a tool never touched the tickets. */
function countingTickets() {
  const inner = createTicketRepository();
  const reads = { count: 0 };
  const tickets: TicketRepository = {
    list: () => (reads.count++, inner.list()),
    findById: (id) => (reads.count++, inner.findById(id)),
  };
  return { tickets, reads };
}

describe("Assistente de viagens: recuperação por RAG", () => {
  it("recupera trechos da base e cita as fontes", async () => {
    const h = createHarness([
      toolCall("call_rag", {
        pergunta: "Qual documentação preciso para viajar para a França?",
        destino: "França",
        nacionalidade: "brasileira",
        finalidade: "turismo",
      }),
      citeSources,
    ]);

    const events = await chat(
      h,
      "travel",
      randomUUID(),
      "Sou brasileiro e vou à França a turismo. Qual documentação preciso?",
    );

    expect(toolResults(events)).toEqual([
      expect.objectContaining({ name: "call_rag", status: "success" }),
    ]);
    const result = lastToolResult(h.model.calls[1]!);
    expect(result.data.simulacao).toBe(true);
    expect(result.data.trechos.map((t: { fonte: string }) => t.fonte)).toEqual([
      "FR-BR-TURISMO",
    ]);
    expect(outcomeOf(events)).toEqual({
      status: "completed",
      reply: "Base simulada. Documentos exigidos: [FR-BR-TURISMO]",
    });
  });

  it("sem evidência na base, não inventa: a busca volta vazia", async () => {
    const h = createHarness([
      toolCall("call_rag", {
        pergunta: "Preciso de visto para a Austrália?",
        destino: "Austrália",
      }),
      citeSources,
    ]);

    const events = await chat(
      h,
      "travel",
      randomUUID(),
      "Preciso de visto para a Austrália?",
    );

    expect(lastToolResult(h.model.calls[1]!).data.trechos).toEqual([]);
    expect(outcomeOf(events)).toEqual({
      status: "completed",
      reply: "A base simulada não contém essa informação.",
    });
  });
});

describe("Separação de tools entre assistentes (backend)", () => {
  it("cada assistente recebe o próprio prompt e só as próprias tools", async () => {
    const h = createHarness([reply("Oi"), reply("Olá")]);

    await chat(h, "support", randomUUID(), "Oi");
    await chat(h, "travel", randomUUID(), "Olá");

    expect(h.model.toolsPerCall).toEqual([
      ["listar_chamados", "consultar_chamado", "propor_escalonamento"],
      ["call_rag"],
    ]);
    const systemPrompt = (call: BaseMessage[] | undefined) => call?.[0]?.text;
    expect(systemPrompt(h.model.calls[0])).toContain("assistente de suporte");
    expect(systemPrompt(h.model.calls[1])).toContain("assistente de viagens");
  });

  it("viagens não executa tools de chamados nem propõe escalonamento", async () => {
    const { tickets, reads } = countingTickets();
    const h = createHarness(
      [
        toolCall("consultar_chamado", { id: "CH-101" }, "call-1"),
        toolCall(
          "propor_escalonamento",
          {
            chamadoId: "CH-101",
            resumo: "Erro no login",
            justificativa: "Prioridade alta",
          },
          "call-2",
        ),
        reply("Não tenho acesso a chamados."),
      ],
      { deps: { tickets } },
    );

    const events = await chat(h, "travel", randomUUID(), "Escalone o CH-101");

    expect(toolResults(events).map((r) => [r.name, r.error?.code])).toEqual([
      ["consultar_chamado", "UNKNOWN_TOOL"],
      ["propor_escalonamento", "UNKNOWN_TOOL"],
    ]);
    expect(reads.count).toBe(0);
    expect(outcomeOf(events).status).toBe("completed");
    expect(await h.deps.escalations.list()).toHaveLength(0);
  });

  it("suporte não consulta o RAG", async () => {
    const h = createHarness([
      toolCall("call_rag", {
        pergunta: "Documentos para a França",
        destino: "França",
      }),
      reply("Não tenho acesso à base de viagens."),
    ]);

    const events = await chat(
      h,
      "support",
      randomUUID(),
      "Quais documentos preciso para a França?",
    );

    expect(toolResults(events)).toEqual([
      expect.objectContaining({
        name: "call_rag",
        status: "error",
        error: expect.objectContaining({ code: "UNKNOWN_TOOL" }),
      }),
    ]);
    // The model saw only the refusal, never an excerpt of the base.
    expect(lastToolResult(h.model.calls[1]!).ok).toBe(false);
  });

  it("rejeita assistente desconhecido", async () => {
    const h = createHarness([]);
    const response = await handleChat(
      post({ sessionId: randomUUID(), assistantId: "admin", message: "Oi" }),
      h.service,
    );
    expect(response.status).toBe(400);
  });
});

describe("Histórico separado por assistente e sessão", () => {
  it("a mesma sessão não compartilha contexto entre assistentes", async () => {
    const h = createHarness([
      toolCall("consultar_chamado", { id: "CH-103" }),
      reply("CH-103: Integração de pedidos parada"),
      reply("Não há perguntas anteriores nesta conversa."),
    ]);
    const sessionId = randomUUID();

    await chat(h, "support", sessionId, "Consulte o CH-103");
    await chat(h, "travel", sessionId, "O que eu perguntei antes?");

    const travelSaw = h.model.calls[2]!.map((m) => m.text).join("\n");
    expect(travelSaw).not.toContain("CH-103");
    expect(travelSaw).not.toContain("Integração de pedidos parada");

    const view = async (assistantId: AssistantId) =>
      (await (
        await handleGetSession(sessionId, h.service, assistantId)
      ).json()) as { entries: { type: string; text?: string }[] };
    const supportTexts = (await view("support")).entries.map((e) => e.text);
    const travelTexts = (await view("travel")).entries.map((e) => e.text);
    expect(supportTexts).toContain("Consulte o CH-103");
    expect(supportTexts).not.toContain("O que eu perguntei antes?");
    expect(travelTexts).toContain("O que eu perguntei antes?");
    expect(travelTexts).not.toContain("Consulte o CH-103");
  });
});
