/**
 * Acceptance suite: one block per scenario of the challenge table. Every test
 * goes through the HTTP handlers, the real graph and executor; only the model
 * is a scripted double, so the suite runs offline.
 */
import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handleApproval, handleChat } from "./http/handlers";
import { reply, toolCall, type ScriptStep } from "./testing/scripted-model";
import {
  createHarness,
  outcomeOf,
  post,
  readEvents,
  toolCalls,
  toolResults,
} from "./testing/http";
import type { TicketRepository } from "./tickets/store";
import { createTicketRepository } from "./mocks/stores";

type Harness = ReturnType<typeof createHarness>;

const chat = async (h: Harness, sessionId: string, message: string) =>
  readEvents(await handleChat(post({ sessionId, message }), h.service));

const decide = async (
  h: Harness,
  sessionId: string,
  proposalId: string,
  decision: "approve" | "reject",
) =>
  readEvents(
    await handleApproval(post({ sessionId, proposalId, decision }), h.service),
  );

/** Answers only from the last tool result, as a grounded model would. */
const answerFromTool: ScriptStep = (messages: BaseMessage[]) => {
  const last = messages.filter(ToolMessage.isInstance).at(-1);
  const result = last && JSON.parse(last.text);
  if (!result?.ok) return reply(`Não foi possível: ${result?.error.code}`);
  if (result.data.chamados) {
    return reply(
      result.data.chamados.map((c: { id: string }) => c.id).join(", "),
    );
  }
  return reply(`${result.data.chamado.id}: ${result.data.chamado.titulo}`);
};

const proposeSteps = (chamadoId: string): ScriptStep[] => [
  toolCall("consultar_chamado", { id: chamadoId }, "call-1"),
  toolCall(
    "propor_escalonamento",
    {
      chamadoId,
      resumo: `Resumo do ${chamadoId}`,
      justificativa: "Prioridade alta e cliente impactado",
    },
    "call-2",
  ),
  answerFromTool,
];

async function proposeFor(h: Harness, sessionId: string, chamadoId = "CH-101") {
  const outcome = outcomeOf(
    await chat(h, sessionId, `Escalone o ${chamadoId}`),
  );
  if (outcome.status !== "awaiting_approval") {
    throw new Error(`expected a proposal, got ${JSON.stringify(outcome)}`);
  }
  return outcome.proposal;
}

describe("Cenário: consulta e listagem", () => {
  it("lista abertos executando a tool com argumentos e respondendo com seu retorno", async () => {
    const h = createHarness([
      toolCall("listar_chamados", { situacao: "aberto" }),
      answerFromTool,
    ]);

    const events = await chat(
      h,
      randomUUID(),
      "Liste todos os chamados abertos.",
    );

    expect(toolCalls(events)).toEqual([
      { name: "listar_chamados", args: { situacao: "aberto" } },
    ]);
    expect(toolResults(events)).toMatchObject([{ status: "success" }]);
    expect(outcomeOf(events)).toEqual({
      status: "completed",
      reply: "CH-101, CH-103",
    });
  });

  it("consulta um chamado pelo identificador", async () => {
    const h = createHarness([
      toolCall("consultar_chamado", { id: "CH-101" }),
      answerFromTool,
    ]);

    const events = await chat(h, randomUUID(), "Consulte o CH-101");

    expect(outcomeOf(events)).toEqual({
      status: "completed",
      reply: "CH-101: Falha no login do portal do cliente",
    });
  });

  it("trata identificador inexistente sem inventar dados", async () => {
    const h = createHarness([
      toolCall("consultar_chamado", { id: "CH-999" }),
      answerFromTool,
    ]);

    const events = await chat(h, randomUUID(), "Consulte o CH-999");

    expect(toolResults(events)).toMatchObject([
      { status: "error", error: { code: "NOT_FOUND" } },
    ]);
    expect(outcomeOf(events)).toEqual({
      status: "completed",
      reply: "Não foi possível: NOT_FOUND",
    });
  });
});

describe("Cenário: chamado resolvido", () => {
  it("impede propor o escalonamento de CH-102 no backend", async () => {
    const h = createHarness(proposeSteps("CH-102"));

    const events = await chat(h, randomUUID(), "Escalone o CH-102");

    expect(toolResults(events)).toContainEqual(
      expect.objectContaining({
        name: "propor_escalonamento",
        error: expect.objectContaining({ code: "NOT_ESCALATABLE" }),
      }),
    );
    expect(outcomeOf(events).status).toBe("completed");
    expect(await h.deps.escalations.list()).toHaveLength(0);
  });

  it("revalida na gravação: chamado resolvido após a proposta não é registrado", async () => {
    const base = createTicketRepository();
    let resolvedLater = false;
    const tickets: TicketRepository = {
      list: () => base.list(),
      findById: async (id) => {
        const chamado = await base.findById(id);
        return chamado && resolvedLater
          ? { ...chamado, situacao: "resolvido" }
          : chamado;
      },
    };
    const h = createHarness(proposeSteps("CH-101"), { deps: { tickets } });
    const sessionId = randomUUID();
    const proposal = await proposeFor(h, sessionId);

    resolvedLater = true;
    const outcome = outcomeOf(
      await decide(h, sessionId, proposal.id, "approve"),
    );

    expect(outcome).toEqual({
      status: "completed",
      reply: expect.stringMatching(
        /Não foi possível registrar.*Nada foi registrado/,
      ),
    });
    expect(await h.deps.escalations.list()).toHaveLength(0);
  });
});

describe("Cenário: aprovação e rejeição", () => {
  it("aguarda a decisão sem gravar e bloqueia novas mensagens", async () => {
    const h = createHarness(proposeSteps("CH-101"));
    const sessionId = randomUUID();

    const proposal = await proposeFor(h, sessionId);

    expect(proposal).toMatchObject({
      chamadoId: "CH-101",
      resumo: "Resumo do CH-101",
      justificativa: "Prioridade alta e cliente impactado",
    });
    expect(await h.deps.escalations.list()).toHaveLength(0);
    const blocked = await handleChat(
      post({ sessionId, message: "Olá" }),
      h.service,
    );
    expect(blocked.status).toBe(409);
  });

  it("rejeitar encerra sem escrever", async () => {
    const h = createHarness(proposeSteps("CH-101"));
    const sessionId = randomUUID();
    const proposal = await proposeFor(h, sessionId);

    const outcome = outcomeOf(
      await decide(h, sessionId, proposal.id, "reject"),
    );

    expect(outcome).toMatchObject({
      status: "completed",
      reply: expect.stringMatching(/rejeitado/),
    });
    expect(await h.deps.escalations.list()).toHaveLength(0);
  });

  it("aprovar executa exatamente a proposta exibida", async () => {
    const h = createHarness(proposeSteps("CH-101"));
    const sessionId = randomUUID();
    const proposal = await proposeFor(h, sessionId);

    const outcome = outcomeOf(
      await decide(h, sessionId, proposal.id, "approve"),
    );

    expect(outcome).toEqual({
      status: "completed",
      reply: "Escalonamento ESC-0001 registrado para o CH-101.",
    });
    expect(await h.deps.escalations.list()).toEqual([
      expect.objectContaining({
        chamadoId: proposal.chamadoId,
        resumo: proposal.resumo,
        justificativa: proposal.justificativa,
        idempotencyKey: proposal.id,
      }),
    ]);
  });
});

describe("Cenário: aprovação repetida", () => {
  it("cria apenas um registro para a mesma operação", async () => {
    const h = createHarness(proposeSteps("CH-101"));
    const sessionId = randomUUID();
    const proposal = await proposeFor(h, sessionId);

    const [a, b] = await Promise.all([
      decide(h, sessionId, proposal.id, "approve"),
      decide(h, sessionId, proposal.id, "approve"),
    ]);
    const c = await decide(h, sessionId, proposal.id, "approve");

    expect(
      [outcomeOf(a), outcomeOf(b), outcomeOf(c)].map((o) => o.status).sort(),
    ).toEqual(["already_processed", "already_processed", "completed"]);
    expect(await h.deps.escalations.list()).toHaveLength(1);
  });
});

describe("Cenário: falha transitória", () => {
  it("recupera a consulta dentro do limite de tentativas", async () => {
    const h = createHarness(
      [toolCall("consultar_chamado", { id: "CH-101" }), answerFromTool],
      {
        faults: { consultar_chamado: ["transient", "transient"] },
        limits: { toolBackoffMs: 1 },
      },
    );

    const events = await chat(h, randomUUID(), "Consulte o CH-101");

    expect(toolResults(events)).toMatchObject([
      { status: "success", attempts: 3 },
    ]);
    expect(outcomeOf(events)).toMatchObject({
      reply: "CH-101: Falha no login do portal do cliente",
    });
  });

  it("encerra a consulta com erro controlado quando as tentativas acabam", async () => {
    const h = createHarness(
      [toolCall("consultar_chamado", { id: "CH-101" }), answerFromTool],
      {
        faults: { consultar_chamado: ["transient", "transient", "transient"] },
        limits: { toolBackoffMs: 1 },
      },
    );

    const events = await chat(h, randomUUID(), "Consulte o CH-101");

    expect(toolResults(events)).toMatchObject([
      { status: "error", attempts: 3, error: { code: "TOOL_UNAVAILABLE" } },
    ]);
    expect(outcomeOf(events)).toMatchObject({
      reply: "Não foi possível: TOOL_UNAVAILABLE",
    });
  });
});

describe("Cenário: saída inválida e limites", () => {
  it.each([
    [
      "ferramenta desconhecida",
      toolCall("apagar_chamado", { id: "CH-101" }),
      "UNKNOWN_TOOL",
    ],
    [
      "argumentos inválidos",
      toolCall("listar_chamados", { situacao: "pendente" }),
      "INVALID_INPUT",
    ],
  ])("não executa %s", async (_label, step, code) => {
    const h = createHarness([step, answerFromTool]);

    const events = await chat(h, randomUUID(), "Faça algo");

    expect(toolResults(events)).toMatchObject([
      { status: "error", attempts: 0 },
    ]);
    expect(toolResults(events)[0]?.error?.code).toBe(code);
    expect(await h.deps.escalations.list()).toHaveLength(0);
  });

  it("rejeita saída inválida da ferramenta", async () => {
    const h = createHarness(
      [toolCall("consultar_chamado", { id: "CH-101" }), answerFromTool],
      { faults: { consultar_chamado: ["invalid_output"] } },
    );

    const events = await chat(h, randomUUID(), "Consulte o CH-101");

    expect(toolResults(events)).toMatchObject([
      { status: "error", error: { code: "INVALID_OUTPUT" } },
    ]);
  });

  it("não executa chamadas malformadas do modelo", async () => {
    const h = createHarness([
      new AIMessage({
        content: "",
        invalid_tool_calls: [
          {
            id: "x",
            name: "listar_chamados",
            args: "{situacao:",
            error: "bad json",
            type: "invalid_tool_call",
          },
        ],
      }),
    ]);

    const events = await chat(h, randomUUID(), "Liste");

    expect(toolResults(events)).toEqual([]);
    expect(outcomeOf(events)).toMatchObject({
      status: "failed",
      error: { code: "INVALID_MODEL_OUTPUT" },
    });
  });

  it("encerra com erro controlado ao atingir o limite de passos", async () => {
    const loop: ScriptStep = () =>
      toolCall("listar_chamados", {}, randomUUID());
    const h = createHarness(Array(30).fill(loop), {
      limits: { recursionLimit: 10 },
    });

    const events = await chat(h, randomUUID(), "Liste");

    expect(outcomeOf(events)).toMatchObject({
      status: "failed",
      reply: expect.stringMatching(/limite de execução/),
      error: { code: "LIMIT_EXCEEDED" },
    });
  });

  it("encerra com erro controlado ao esgotar o tempo de execução ativa", async () => {
    const h = createHarness(
      [toolCall("consultar_chamado", { id: "CH-101" }), answerFromTool],
      {
        faults: { consultar_chamado: ["hang", "hang", "hang"] },
        limits: { toolTimeoutMs: 1000, activeBudgetMs: 80 },
      },
    );

    const events = await chat(h, randomUUID(), "Consulte o CH-101");

    expect(outcomeOf(events)).toMatchObject({
      status: "failed",
      error: { code: "LIMIT_EXCEEDED" },
    });
  });
});

describe("Cenário: contexto e sessões", () => {
  it("continua a mesma conversa sem misturar outra sessão", async () => {
    const h = createHarness([
      toolCall("consultar_chamado", { id: "CH-103" }),
      answerFromTool,
      reply("Ele é de prioridade crítica."),
      reply("De qual chamado você fala?"),
    ]);
    const a = randomUUID();
    const b = randomUUID();

    await chat(h, a, "Consulte o CH-103");
    await chat(h, a, "Qual a prioridade dele?");
    await chat(h, b, "Qual a prioridade dele?");

    const [, , followUpA, questionB] = h.model.calls;
    const seen = (call: BaseMessage[] | undefined) =>
      (call ?? []).map((m) => m.text).join("\n");
    expect(seen(followUpA)).toContain("Integração de pedidos parada");
    expect(seen(questionB)).not.toContain("CH-103");
    expect(seen(questionB)).not.toContain("Integração de pedidos parada");
  });
});
