import { HumanMessage } from "@langchain/core/messages";
import { Command, GraphRecursionError } from "@langchain/langgraph";
import { z } from "zod";
import { fail, ok, type Result } from "../shared/result";
import type { Escalonamento } from "../tickets/schemas";
import type { TicketDeps } from "../tickets/operations";
import { endTurnWithError, type AgentGraph } from "./graph";
import { decisionSchema, type Proposal } from "./proposal";
import { NEW_TURN, type AgentStateValue, type TurnError } from "./state";

const sessionIdSchema = z.uuid();
const messageSchema = z.string().trim().min(1).max(4000);

export type TurnOutcome =
  | { status: "awaiting_approval"; proposal: Proposal }
  | { status: "completed"; reply: string }
  | { status: "failed"; reply: string; error: TurnError };

export type DecisionOutcome =
  | TurnOutcome
  | {
      status: "already_processed";
      resolution: "approved";
      escalonamento: Escalonamento;
    }
  | { status: "already_processed"; resolution: "rejected" };

type RunConfig = {
  configurable: { thread_id: string };
  recursionLimit: number;
};

/** What the caller must run next: a graph input (invoke or stream) or a stored outcome. */
export type PreparedTurn = { kind: "run"; input: unknown; config: RunConfig };
export type PreparedDecision =
  PreparedTurn | { kind: "replay"; outcome: DecisionOutcome };

export function toTurnOutcome(state: AgentStateValue): TurnOutcome {
  if (state.proposal)
    return { status: "awaiting_approval", proposal: state.proposal };
  const reply = state.messages.at(-1)?.text ?? "";
  if (state.error) return { status: "failed", reply, error: state.error };
  return { status: "completed", reply };
}

export type SupportServiceOptions = { recursionLimit?: number };

export function createSupportService(
  graph: AgentGraph,
  deps: TicketDeps,
  options: SupportServiceOptions = {},
) {
  const recursionLimit = options.recursionLimit ?? 15;
  const locks = new Map<string, Promise<unknown>>();

  /** Serializes work per session so concurrent requests cannot interleave. */
  async function withSessionLock<T>(sessionId: string, task: () => Promise<T>) {
    const previous = locks.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    locks.set(sessionId, current);
    try {
      return await current;
    } finally {
      if (locks.get(sessionId) === current) locks.delete(sessionId);
    }
  }

  const configFor = (sessionId: string): RunConfig => ({
    configurable: { thread_id: sessionId },
    recursionLimit,
  });

  async function readState(sessionId: string) {
    const snapshot = await graph.getState(configFor(sessionId));
    return snapshot.values as Partial<AgentStateValue>;
  }

  async function prepareMessage(
    sessionId: string,
    text: unknown,
  ): Promise<Result<PreparedTurn>> {
    if (!sessionIdSchema.safeParse(sessionId).success) {
      return fail("INVALID_INPUT", "Sessão inválida");
    }
    const message = messageSchema.safeParse(text);
    if (!message.success) return fail("INVALID_INPUT", "Mensagem inválida");

    const state = await readState(sessionId);
    if (state.proposal) {
      return fail(
        "APPROVAL_PENDING",
        "Há um escalonamento aguardando decisão nesta sessão",
      );
    }
    return ok({
      kind: "run",
      // Each user message starts a fresh active-time and step budget.
      input: {
        messages: [new HumanMessage(message.data)],
        turn: { ...NEW_TURN },
        error: null,
      },
      config: configFor(sessionId),
    });
  }

  async function prepareDecision(
    sessionId: string,
    body: unknown,
  ): Promise<Result<PreparedDecision>> {
    if (!sessionIdSchema.safeParse(sessionId).success) {
      return fail("INVALID_INPUT", "Sessão inválida");
    }
    const parsed = decisionSchema.safeParse(body);
    if (!parsed.success) return fail("INVALID_INPUT", "Decisão inválida");
    const { proposalId, decision } = parsed.data;

    const state = await readState(sessionId);
    if (state.proposal?.id === proposalId) {
      return ok({
        kind: "run",
        input: new Command({ resume: parsed.data }),
        config: configFor(sessionId),
      });
    }

    const resolution = state.resolutions?.[proposalId];
    if (resolution === "approved" && decision === "approve") {
      const escalonamento =
        await deps.escalations.findByIdempotencyKey(proposalId);
      if (!escalonamento) {
        return fail("NOT_FOUND", "A aprovação anterior não gerou registro");
      }
      return ok({
        kind: "replay",
        outcome: { status: "already_processed", resolution, escalonamento },
      });
    }
    if (resolution === "rejected" && decision === "reject") {
      return ok({
        kind: "replay",
        outcome: { status: "already_processed", resolution },
      });
    }
    if (resolution) {
      return fail(
        "PROPOSAL_ALREADY_DECIDED",
        `Esta proposta já foi ${resolution === "approved" ? "aprovada" : "rejeitada"}`,
      );
    }
    return state.proposal
      ? fail(
          "PROPOSAL_MISMATCH",
          "A decisão não corresponde à proposta pendente",
        )
      : fail(
          "NO_PENDING_PROPOSAL",
          "Não há proposta pendente com este identificador",
        );
  }

  /**
   * Last-resort guard: if the graph throws (e.g. recursion limit), the turn is
   * closed with a controlled error so the session stays usable.
   */
  async function recover(config: RunConfig, error: unknown) {
    const snapshot = await graph.getState(config);
    const messages =
      (snapshot.values as Partial<AgentStateValue>).messages ?? [];
    const update =
      error instanceof GraphRecursionError
        ? endTurnWithError(
            messages,
            "LIMIT_EXCEEDED",
            "Limite de passos do grafo atingido",
          )
        : endTurnWithError(
            messages,
            "INTERNAL_ERROR",
            "Erro inesperado na execução",
          );
    await graph.updateState(config, update, "agent");
    return (await graph.getState(config)).values as AgentStateValue;
  }

  async function run(prepared: PreparedTurn): Promise<TurnOutcome> {
    let state: AgentStateValue;
    try {
      state = await graph.invoke(prepared.input as never, prepared.config);
    } catch (error) {
      state = await recover(prepared.config, error);
    }
    return toTurnOutcome(state);
  }

  return {
    withSessionLock,
    recover,
    prepareMessage,
    prepareDecision,

    sendMessage(
      sessionId: string,
      text: unknown,
    ): Promise<Result<TurnOutcome>> {
      return withSessionLock(sessionId, async () => {
        const prepared = await prepareMessage(sessionId, text);
        if (!prepared.ok) return prepared;
        return ok(await run(prepared.data));
      });
    },

    decide(sessionId: string, body: unknown): Promise<Result<DecisionOutcome>> {
      return withSessionLock(sessionId, async () => {
        const prepared = await prepareDecision(sessionId, body);
        if (!prepared.ok) return prepared;
        if (prepared.data.kind === "replay") return ok(prepared.data.outcome);
        return ok(await run(prepared.data));
      });
    },
  };
}

export type SupportService = ReturnType<typeof createSupportService>;
