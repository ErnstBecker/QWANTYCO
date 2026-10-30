import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { Command, GraphRecursionError } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  toActivityItem,
  type HistoryEntry,
  type StreamEvent,
} from "@/lib/stream-events";
import { fail, ok, type Result } from "../shared/result";
import { createSessionLock } from "../shared/session-lock";
import type { Escalonamento } from "../tickets/schemas";
import type { TicketDeps } from "../tickets/operations";
import {
  DEFAULT_ASSISTANT,
  assistantIdSchema,
  threadIdFor,
  type AssistantId,
} from "./assistants";
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
  configurable: { thread_id: string; assistant_id: AssistantId };
  recursionLimit: number;
  /** Tracing: one root run per request, grouped by session in LangSmith. */
  runId?: string;
  runName?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
};

/** Tag on every trace of the app, whatever the assistant. */
export const APP_TAG = "aurora-support";

/** A conversation: one session of one assistant. */
type SessionRef = { sessionId: string; assistantId: AssistantId };

function parseSession(
  sessionId: string,
  assistantId: unknown,
): Result<SessionRef> {
  if (!sessionIdSchema.safeParse(sessionId).success) {
    return fail("INVALID_INPUT", "Sessão inválida");
  }
  const assistant = assistantIdSchema.safeParse(
    assistantId ?? DEFAULT_ASSISTANT,
  );
  if (!assistant.success) return fail("INVALID_INPUT", "Assistente inválido");
  return ok({ sessionId, assistantId: assistant.data });
}

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
  /** Serializes work per session so concurrent requests cannot interleave. */
  const lock = createSessionLock();

  // The assistant picks the graph configuration and is part of the thread id,
  // so the same session id never shares history across assistants.
  const configFor = ({ sessionId, assistantId }: SessionRef): RunConfig => ({
    configurable: {
      thread_id: threadIdFor(assistantId, sessionId),
      assistant_id: assistantId,
    },
    recursionLimit,
  });

  const runConfigFor = (
    ref: SessionRef,
    runName: string,
    metadata: Record<string, unknown> = {},
  ): RunConfig => ({
    ...configFor(ref),
    runId: randomUUID(),
    runName,
    tags: [APP_TAG, ref.assistantId, runName],
    metadata: {
      session_id: ref.sessionId,
      assistant: ref.assistantId,
      ...metadata,
    },
  });

  async function readState(ref: SessionRef) {
    const snapshot = await graph.getState(configFor(ref));
    return snapshot.values as Partial<AgentStateValue>;
  }

  async function prepareMessage(
    sessionId: string,
    text: unknown,
    assistantId?: unknown,
  ): Promise<Result<PreparedTurn>> {
    const ref = parseSession(sessionId, assistantId);
    if (!ref.ok) return ref;
    const message = messageSchema.safeParse(text);
    if (!message.success) return fail("INVALID_INPUT", "Mensagem inválida");

    const state = await readState(ref.data);
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
      config: runConfigFor(ref.data, "message"),
    });
  }

  async function prepareDecision(
    sessionId: string,
    body: unknown,
    assistantId?: unknown,
  ): Promise<Result<PreparedDecision>> {
    const ref = parseSession(sessionId, assistantId);
    if (!ref.ok) return ref;
    const parsed = decisionSchema.safeParse(body);
    if (!parsed.success) return fail("INVALID_INPUT", "Decisão inválida");
    const { proposalId, decision } = parsed.data;

    const state = await readState(ref.data);
    if (state.proposal?.id === proposalId) {
      return ok({
        kind: "run",
        input: new Command({ resume: parsed.data }),
        config: runConfigFor(ref.data, "decision", { proposalId, decision }),
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

  /**
   * Streams a prepared turn as UI events. Errors (including a client abort)
   * end the turn through the same controlled recovery as invoke.
   */
  async function* stream(
    prepared: PreparedTurn,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    let state: AgentStateValue;
    try {
      const events = await graph.stream(prepared.input as never, {
        ...prepared.config,
        streamMode: ["updates", "messages"],
        signal,
      });
      for await (const [mode, chunk] of events as AsyncIterable<
        [string, unknown]
      >) {
        if (mode === "messages") {
          const [message, meta] = chunk as [
            BaseMessage,
            { langgraph_node?: string },
          ];
          if (meta.langgraph_node === "agent" && message.text) {
            yield { type: "token", text: message.text };
          }
          continue;
        }
        for (const [node, update] of Object.entries(
          chunk as Record<string, unknown>,
        )) {
          if (node.startsWith("__")) continue;
          yield { type: "step", node };
          yield* toolEvents(
            (update as { messages?: BaseMessage[] } | null)?.messages ?? [],
          );
        }
      }
      state = (await graph.getState(prepared.config)).values as AgentStateValue;
    } catch (error) {
      state = await recover(prepared.config, error);
    }
    yield { type: "done", outcome: toTurnOutcome(state) };
  }

  /** Visible history of a session: messages and tool activity, in order. */
  async function getSession(sessionId: string, assistantId?: unknown) {
    const ref = parseSession(sessionId, assistantId);
    if (!ref.ok) return ref;
    const state = await readState(ref.data);
    const entries: HistoryEntry[] = [];
    for (const message of state.messages ?? []) {
      if (HumanMessage.isInstance(message)) {
        entries.push({ type: "user", text: message.text });
        continue;
      }
      if (AIMessage.isInstance(message) && message.text) {
        entries.push({ type: "assistant", text: message.text });
      }
      for (const event of toolEvents([message])) {
        if (event.type !== "tool_call" && event.type !== "tool_result")
          continue;
        const last = entries.at(-1);
        if (last?.type === "activity") last.items.push(toActivityItem(event));
        else entries.push({ type: "activity", items: [toActivityItem(event)] });
      }
    }
    return ok({
      sessionId,
      assistantId: ref.data.assistantId,
      entries,
      proposal: state.proposal ?? null,
    });
  }

  /**
   * Deletes the session's history and any pending proposal. Registered
   * escalations are kept: they are records, not conversation state.
   */
  function deleteSession(
    sessionId: string,
    assistantId?: unknown,
  ): Promise<Result<null>> {
    const ref = parseSession(sessionId, assistantId);
    if (!ref.ok) return Promise.resolve(ref);
    // Waits for a running turn of this session to finish first.
    return lock.run(sessionId, async () => {
      const saver = graph.checkpointer;
      if (saver && typeof saver !== "boolean") {
        await saver.deleteThread(configFor(ref.data).configurable.thread_id);
      }
      return ok(null);
    });
  }

  return {
    lock,
    recover,
    stream,
    getSession,
    deleteSession,
    prepareMessage,
    prepareDecision,

    sendMessage(
      sessionId: string,
      text: unknown,
      assistantId?: unknown,
    ): Promise<Result<TurnOutcome>> {
      return lock.run(sessionId, async () => {
        const prepared = await prepareMessage(sessionId, text, assistantId);
        if (!prepared.ok) return prepared;
        return ok(await run(prepared.data));
      });
    },

    decide(
      sessionId: string,
      body: unknown,
      assistantId?: unknown,
    ): Promise<Result<DecisionOutcome>> {
      return lock.run(sessionId, async () => {
        const prepared = await prepareDecision(sessionId, body, assistantId);
        if (!prepared.ok) return prepared;
        if (prepared.data.kind === "replay") return ok(prepared.data.outcome);
        return ok(await run(prepared.data));
      });
    },
  };
}

export type SupportService = ReturnType<typeof createSupportService>;

function* toolEvents(messages: BaseMessage[]): Generator<StreamEvent> {
  for (const message of messages) {
    if (AIMessage.isInstance(message)) {
      for (const call of message.tool_calls ?? []) {
        yield {
          type: "tool_call",
          id: call.id!,
          name: call.name,
          args: call.args,
        };
      }
    } else if (ToolMessage.isInstance(message)) {
      const body = JSON.parse(message.text) as {
        ok: boolean;
        error?: TurnError;
      };
      yield {
        type: "tool_result",
        id: message.tool_call_id,
        name: message.name ?? "",
        status: message.status === "error" ? "error" : "success",
        attempts: (message.artifact as { attempts?: number } | undefined)
          ?.attempts,
        error: body.ok ? undefined : body.error,
      };
    }
  }
}
