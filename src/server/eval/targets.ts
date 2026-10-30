import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { MemorySaver } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import type { Limits } from "../config/env";
import { threadIdFor } from "../agent/assistants";
import { buildAgentGraph } from "../agent/graph";
import type { AgentStateValue } from "../agent/state";
import { createSupportService, toTurnOutcome } from "../agent/support-service";
import { listarChamados } from "../tickets/operations";
import { createEscalationStore, createTicketRepository } from "../mocks/stores";
import type { EvalInputs } from "./dataset";
import { toolSteps, type AgentRunOutput } from "./trajectory";

export type Target = (inputs: EvalInputs) => Promise<AgentRunOutput>;

/**
 * Runs the real graph and executor for one example, in an isolated session
 * with fresh data, and returns the reply plus the executed trajectory.
 */
export function agentTarget(model: BaseChatModel, limits?: Limits): Target {
  return async ({ message }) => {
    const deps = {
      tickets: createTicketRepository(),
      escalations: createEscalationStore(),
    };
    const graph = buildAgentGraph({
      model,
      deps,
      checkpointer: new MemorySaver(),
      limits,
    });
    const service = createSupportService(graph, deps, {
      recursionLimit: limits?.recursionLimit,
    });
    const sessionId = randomUUID();
    await service.sendMessage(sessionId, message);

    const state = (
      await graph.getState({
        configurable: { thread_id: threadIdFor("support", sessionId) },
      })
    ).values as AgentStateValue;
    const outcome = toTurnOutcome(state);
    return {
      reply: outcome.status === "awaiting_approval" ? "" : outcome.reply,
      status: outcome.status,
      steps: toolSteps(state.messages),
      escalationsRegistered: (await deps.escalations.list()).length,
    };
  };
}

/**
 * Deliberately wrong targets, used to show the evaluators reject them.
 * Neither calls the model.
 */
export const SABOTAGED_TARGETS: Record<string, Target> = {
  // Answers with the right ids without ever querying the tickets.
  "skips-tool": async () => ({
    reply: "Os chamados abertos são CH-101 e CH-103.",
    status: "completed",
    steps: [],
    escalationsRegistered: 0,
  }),
  // Runs the real query but adds a ticket that does not exist.
  "invents-ticket": async () => {
    const deps = {
      tickets: createTicketRepository(),
      escalations: createEscalationStore(),
    };
    const data = await listarChamados(deps, { situacao: "aberto" });
    return {
      reply: "Os chamados abertos são CH-101, CH-103 e CH-999.",
      status: "completed",
      steps: [
        {
          name: "listar_chamados",
          args: { situacao: "aberto" },
          executed: true,
          ok: data.ok,
          data: data.ok ? data.data : undefined,
        },
      ],
      escalationsRegistered: 0,
    };
  },
};
