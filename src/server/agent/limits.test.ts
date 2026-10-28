import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { Limits } from "../config/env";
import {
  ScriptedChatModel,
  reply,
  toolCall,
  type ScriptStep,
} from "../testing/scripted-model";
import {
  createEscalationStore,
  createTicketRepository,
} from "../tickets/store";
import { parseFaultPlan, withFaults, type FaultPlan } from "./faults";
import { buildAgentGraph } from "./graph";
import { createSupportService } from "./support-service";
import { READ_TOOLS } from "./tools";

const FAST: Partial<Limits> = {
  toolTimeoutMs: 50,
  toolMaxAttempts: 3,
  toolBackoffMs: 1,
  modelTimeoutMs: 1000,
  activeBudgetMs: 5000,
  recursionLimit: 15,
};

function setup(
  steps: ScriptStep[],
  {
    faults = {},
    limits = {},
    serviceRecursionLimit,
  }: {
    faults?: FaultPlan;
    limits?: Partial<Limits>;
    serviceRecursionLimit?: number;
  } = {},
) {
  const deps = {
    tickets: createTicketRepository(),
    escalations: createEscalationStore(),
  };
  const mergedLimits = { ...FAST, ...limits };
  const graph = buildAgentGraph({
    model: new ScriptedChatModel(steps),
    deps,
    checkpointer: new MemorySaver(),
    tools: withFaults(READ_TOOLS, faults),
    limits: mergedLimits,
  });
  const service = createSupportService(graph, deps, {
    recursionLimit: serviceRecursionLimit ?? mergedLimits.recursionLimit,
  });
  const sessionId = randomUUID();
  const config = { configurable: { thread_id: sessionId } };
  const messages = async () =>
    ((await graph.getState(config)).values.messages ?? []) as BaseMessage[];
  return { deps, graph, service, sessionId, messages };
}

const toolResults = (messages: BaseMessage[]) =>
  messages.filter(ToolMessage.isInstance).map((m) => ({
    status: m.status,
    attempts: (m.artifact as { attempts: number } | undefined)?.attempts,
    body: JSON.parse(m.text),
  }));

/** Every tool call in the history has a result, so the session stays usable. */
function expectNoDanglingCalls(messages: BaseMessage[]) {
  const answered = new Set(
    messages.filter(ToolMessage.isInstance).map((m) => m.tool_call_id),
  );
  for (const message of messages.filter(AIMessage.isInstance)) {
    for (const call of message.tool_calls ?? []) {
      expect(answered.has(call.id!)).toBe(true);
    }
  }
}

const consult = toolCall("consultar_chamado", { id: "CH-101" });
const done = reply("ok");

describe("tool failures", () => {
  it("recovers from transient failures within the attempt limit", async () => {
    const ctx = setup([consult, done], {
      faults: { consultar_chamado: ["transient", "transient"] },
    });

    const result = await ctx.service.sendMessage(
      ctx.sessionId,
      "Consulte o CH-101",
    );

    expect(result).toMatchObject({ ok: true, data: { status: "completed" } });
    expect(toolResults(await ctx.messages())).toEqual([
      expect.objectContaining({
        status: "success",
        attempts: 3,
        body: expect.objectContaining({ ok: true }),
      }),
    ]);
  });

  it("gives up after the last attempt with a controlled error", async () => {
    const ctx = setup([consult, reply("Serviço indisponível no momento.")], {
      faults: { consultar_chamado: ["transient", "transient", "transient"] },
    });

    await ctx.service.sendMessage(ctx.sessionId, "Consulte o CH-101");

    expect(toolResults(await ctx.messages())).toEqual([
      {
        status: "error",
        attempts: 3,
        body: expect.objectContaining({
          error: expect.objectContaining({ code: "TOOL_UNAVAILABLE" }),
        }),
      },
    ]);
  });

  it("times out a hanging tool and retries", async () => {
    const ctx = setup([consult, done], {
      faults: { consultar_chamado: ["hang"] },
    });

    await ctx.service.sendMessage(ctx.sessionId, "Consulte o CH-101");

    expect(toolResults(await ctx.messages())[0]).toMatchObject({
      status: "success",
      attempts: 2,
    });
  });

  it.each([
    ["invalid_output", "INVALID_OUTPUT"],
    ["crash", "TOOL_ERROR"],
  ] as const)("does not retry %s", async (fault, code) => {
    const ctx = setup([consult, done], {
      faults: { consultar_chamado: [fault] },
    });

    await ctx.service.sendMessage(ctx.sessionId, "Consulte o CH-101");

    expect(toolResults(await ctx.messages())[0]).toMatchObject({
      status: "error",
      attempts: 1,
      body: { error: { code } },
    });
  });

  it("rejects malformed fault plans", () => {
    expect(parseFaultPlan(undefined)).toEqual({});
    expect(parseFaultPlan('{"consultar_chamado":["transient"]}')).toEqual({
      consultar_chamado: ["transient"],
    });
    expect(() => parseFaultPlan('{"consultar_chamado":["explode"]}')).toThrow();
  });
});

describe("execution limits", () => {
  const loop: ScriptStep = () =>
    toolCall("listar_chamados", { situacao: "aberto" }, randomUUID());

  it("stops a model that never finishes at the step limit", async () => {
    const ctx = setup(Array(20).fill(loop), { limits: { recursionLimit: 8 } });

    const result = await ctx.service.sendMessage(ctx.sessionId, "Liste");

    expect(result).toMatchObject({
      ok: true,
      data: { status: "failed", error: { code: "LIMIT_EXCEEDED" } },
    });
    expectNoDanglingCalls(await ctx.messages());
  });

  it("stops when the active time budget is spent", async () => {
    const ctx = setup([consult, done], {
      faults: { consultar_chamado: ["hang", "hang", "hang"] },
      limits: { toolTimeoutMs: 1000, activeBudgetMs: 60 },
    });

    const result = await ctx.service.sendMessage(
      ctx.sessionId,
      "Consulte o CH-101",
    );

    expect(result).toMatchObject({
      ok: true,
      data: { status: "failed", error: { code: "LIMIT_EXCEEDED" } },
    });
    expectNoDanglingCalls(await ctx.messages());
  });

  it("does not count the time waiting for a human decision", async () => {
    const ctx = setup(
      [
        consult,
        toolCall("propor_escalonamento", {
          chamadoId: "CH-101",
          resumo: "Erro 500 no login",
          justificativa: "Prioridade alta",
        }),
      ],
      { limits: { activeBudgetMs: 150 } },
    );

    const proposed = await ctx.service.sendMessage(
      ctx.sessionId,
      "Escalone o CH-101",
    );
    if (!proposed.ok || proposed.data.status !== "awaiting_approval") {
      throw new Error(`expected a proposal: ${JSON.stringify(proposed)}`);
    }
    await sleep(300); // longer than the whole active budget

    const result = await ctx.service.decide(ctx.sessionId, {
      proposalId: proposed.data.proposal.id,
      decision: "approve",
    });

    expect(result).toMatchObject({ ok: true, data: { status: "completed" } });
    expect(await ctx.deps.escalations.list()).toHaveLength(1);
  });

  it("starts a fresh budget for each user message", async () => {
    const ctx = setup([reply("um"), reply("dois")], {
      limits: { recursionLimit: 4 },
    });

    await ctx.service.sendMessage(ctx.sessionId, "primeira");
    const second = await ctx.service.sendMessage(ctx.sessionId, "segunda");

    expect(second).toMatchObject({
      ok: true,
      data: { status: "completed", reply: "dois" },
    });
  });

  it("ends with a controlled error when the graph recursion limit is hit", async () => {
    const ctx = setup([...Array(20).fill(loop)], {
      limits: { recursionLimit: 50 },
      serviceRecursionLimit: 4,
    });

    const result = await ctx.service.sendMessage(ctx.sessionId, "Liste");

    expect(result).toMatchObject({
      ok: true,
      data: { status: "failed", error: { code: "LIMIT_EXCEEDED" } },
    });
    expectNoDanglingCalls(await ctx.messages());
  });
});

describe("model failures", () => {
  it("ends with a controlled error when the model fails", async () => {
    const ctx = setup([
      () => {
        throw new Error("connection refused");
      },
    ]);

    const result = await ctx.service.sendMessage(ctx.sessionId, "Olá");

    expect(result).toMatchObject({
      ok: true,
      data: { status: "failed", error: { code: "MODEL_ERROR" } },
    });
  });

  it("times out a slow model", async () => {
    const ctx = setup(
      [
        async () => {
          await sleep(500);
          return reply("tarde demais");
        },
      ],
      { limits: { modelTimeoutMs: 30 } },
    );

    const result = await ctx.service.sendMessage(ctx.sessionId, "Olá");

    expect(result).toMatchObject({
      ok: true,
      data: { status: "failed", error: { code: "MODEL_ERROR" } },
    });
  });

  it("does not execute malformed tool calls", async () => {
    const ctx = setup([
      new AIMessage({
        content: "",
        invalid_tool_calls: [
          {
            id: "bad-1",
            name: "consultar_chamado",
            args: "{id: CH-101",
            error: "Malformed JSON",
            type: "invalid_tool_call",
          },
        ],
      }),
    ]);

    const result = await ctx.service.sendMessage(ctx.sessionId, "Consulte");

    expect(result).toMatchObject({
      ok: true,
      data: { status: "failed", error: { code: "INVALID_MODEL_OUTPUT" } },
    });
    expect(toolResults(await ctx.messages())).toEqual([]);
  });

  it("keeps the session usable after a failed turn", async () => {
    const ctx = setup([
      () => {
        throw new Error("down");
      },
      reply("de volta"),
    ]);

    await ctx.service.sendMessage(ctx.sessionId, "Olá");
    const next = await ctx.service.sendMessage(ctx.sessionId, "Olá de novo");

    expect(next).toMatchObject({
      ok: true,
      data: { status: "completed", reply: "de volta" },
    });
  });
});
