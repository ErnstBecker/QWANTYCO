import { ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { Command, MemorySaver } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
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
import { buildAgentGraph } from "./graph";
import type { Proposal } from "./proposal";
import { createSupportService } from "./support-service";

const escalation = {
  chamadoId: "CH-101",
  resumo: "Erro 500 no login do portal da filial Norte",
  justificativa: "Prioridade alta e sem solução há 7 dias",
};

/** Replies with the outcome of the last tool result, like a grounded model. */
const replyFromLastTool = (messages: BaseMessage[]) => {
  const last = messages.filter(ToolMessage.isInstance).at(-1);
  const result = last ? JSON.parse(last.text) : undefined;
  return reply(
    result?.ok
      ? `Escalonamento ${result.data.escalonamento.id} registrado.`
      : `Não foi possível: ${result?.error.code}`,
  );
};

function setup(steps: ScriptStep[]) {
  const deps = {
    tickets: createTicketRepository(),
    escalations: createEscalationStore(),
  };
  const graph = buildAgentGraph({
    model: new ScriptedChatModel(steps),
    deps,
    checkpointer: new MemorySaver(),
  });
  return {
    deps,
    graph,
    service: createSupportService(graph, deps),
    sessionId: randomUUID(),
  };
}

const escalationScript = (args = escalation): ScriptStep[] => [
  toolCall("consultar_chamado", { id: args.chamadoId }, "call-1"),
  toolCall("registrar_escalonamento", args, "call-2"),
  replyFromLastTool,
];

async function proposeEscalation(ctx: ReturnType<typeof setup>) {
  const result = await ctx.service.sendMessage(
    ctx.sessionId,
    "Consulte o CH-101 e prepare um escalonamento se ele estiver aberto.",
  );
  if (!result.ok || result.data.status !== "awaiting_approval") {
    throw new Error(`Expected a proposal, got ${JSON.stringify(result)}`);
  }
  return result.data.proposal;
}

describe("escalation approval", () => {
  it("pauses with the exact proposal and writes nothing before approval", async () => {
    const ctx = setup(escalationScript());

    const proposal = await proposeEscalation(ctx);

    expect(proposal).toMatchObject({
      ...escalation,
      toolCallId: "call-2",
      chamado: { id: "CH-101", situacao: "aberto" },
    });
    expect(await ctx.deps.escalations.list()).toHaveLength(0);
  });

  it("approving executes exactly the proposal shown", async () => {
    const ctx = setup(escalationScript());
    const proposal = await proposeEscalation(ctx);

    const result = await ctx.service.decide(ctx.sessionId, {
      proposalId: proposal.id,
      decision: "approve",
    });

    expect(result).toEqual({
      ok: true,
      data: {
        status: "completed",
        reply: "Escalonamento ESC-0001 registrado.",
      },
    });
    const records = await ctx.deps.escalations.list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      ...escalation,
      idempotencyKey: proposal.id,
    });
  });

  it("rejecting ends without writing", async () => {
    const ctx = setup(escalationScript());
    const proposal = await proposeEscalation(ctx);

    const result = await ctx.service.decide(ctx.sessionId, {
      proposalId: proposal.id,
      decision: "reject",
    });

    expect(result).toMatchObject({
      ok: true,
      data: { status: "completed", reply: expect.stringMatching(/rejeitado/) },
    });
    expect(await ctx.deps.escalations.list()).toHaveLength(0);
  });

  it("a repeated approval does not create another record", async () => {
    const ctx = setup(escalationScript());
    const proposal = await proposeEscalation(ctx);
    const decision = { proposalId: proposal.id, decision: "approve" };

    await ctx.service.decide(ctx.sessionId, decision);
    const again = await ctx.service.decide(ctx.sessionId, decision);

    expect(again).toMatchObject({
      ok: true,
      data: {
        status: "already_processed",
        resolution: "approved",
        escalonamento: { id: "ESC-0001" },
      },
    });
    expect(await ctx.deps.escalations.list()).toHaveLength(1);
  });

  it("concurrent approvals create a single record", async () => {
    const ctx = setup(escalationScript());
    const proposal = await proposeEscalation(ctx);
    const decision = { proposalId: proposal.id, decision: "approve" };

    const results = await Promise.all([
      ctx.service.decide(ctx.sessionId, decision),
      ctx.service.decide(ctx.sessionId, decision),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    expect(await ctx.deps.escalations.list()).toHaveLength(1);
  });

  it("refuses a decision bound to another proposal", async () => {
    const ctx = setup(escalationScript());
    const proposal = await proposeEscalation(ctx);

    const wrong = await ctx.service.decide(ctx.sessionId, {
      proposalId: randomUUID(),
      decision: "approve",
    });

    expect(wrong).toMatchObject({
      ok: false,
      error: { code: "PROPOSAL_MISMATCH" },
    });
    expect(await ctx.deps.escalations.list()).toHaveLength(0);
    const right = await ctx.service.decide(ctx.sessionId, {
      proposalId: proposal.id,
      decision: "approve",
    });
    expect(right.ok).toBe(true);
    expect(await ctx.deps.escalations.list()).toHaveLength(1);
  });

  it("the graph ignores a resume for another proposal even without the service", async () => {
    const ctx = setup(escalationScript());
    const proposal = await proposeEscalation(ctx);
    const config = { configurable: { thread_id: ctx.sessionId } };

    const state = await ctx.graph.invoke(
      new Command({
        resume: { proposalId: randomUUID(), decision: "approve" },
      }),
      config,
    );

    expect((state.proposal as Proposal | null)?.id).toBe(proposal.id);
    expect(await ctx.deps.escalations.list()).toHaveLength(0);

    // The proposal is still pending and the right decision still applies.
    const approved = await ctx.service.decide(ctx.sessionId, {
      proposalId: proposal.id,
      decision: "approve",
    });
    expect(approved).toMatchObject({ ok: true, data: { status: "completed" } });
    expect(await ctx.deps.escalations.list()).toHaveLength(1);
  });

  it("cannot approve after rejecting", async () => {
    const ctx = setup(escalationScript());
    const proposal = await proposeEscalation(ctx);
    await ctx.service.decide(ctx.sessionId, {
      proposalId: proposal.id,
      decision: "reject",
    });

    const result = await ctx.service.decide(ctx.sessionId, {
      proposalId: proposal.id,
      decision: "approve",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "PROPOSAL_ALREADY_DECIDED" },
    });
    expect(await ctx.deps.escalations.list()).toHaveLength(0);
  });

  it("blocks new messages while a decision is pending", async () => {
    const ctx = setup(escalationScript());
    await proposeEscalation(ctx);

    const result = await ctx.service.sendMessage(ctx.sessionId, "Olá");

    expect(result).toMatchObject({
      ok: false,
      error: { code: "APPROVAL_PENDING" },
    });
  });

  it("never proposes escalating a resolved ticket", async () => {
    const ctx = setup(escalationScript({ ...escalation, chamadoId: "CH-102" }));

    const result = await ctx.service.sendMessage(
      ctx.sessionId,
      "Escalone o CH-102",
    );

    expect(result).toEqual({
      ok: true,
      data: { status: "completed", reply: "Não foi possível: NOT_ESCALATABLE" },
    });
    expect(await ctx.deps.escalations.list()).toHaveLength(0);
  });

  it("rejects invalid sessions and decisions", async () => {
    const ctx = setup([]);

    expect(await ctx.service.sendMessage("not-a-uuid", "Olá")).toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
    expect(
      await ctx.service.decide(ctx.sessionId, {
        proposalId: "x",
        decision: "maybe",
      }),
    ).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect(
      await ctx.service.decide(ctx.sessionId, {
        proposalId: randomUUID(),
        decision: "approve",
      }),
    ).toMatchObject({ error: { code: "NO_PENDING_PROPOSAL" } });
  });
});
