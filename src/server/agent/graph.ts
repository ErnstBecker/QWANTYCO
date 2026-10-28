import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import {
  Command,
  END,
  START,
  StateGraph,
  interrupt,
  isCommand,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import { limitsSchema, type Limits } from "../config/env";
import { withDeadline } from "../shared/deadline";
import { fail, type ErrorCode, type Result } from "../shared/result";
import {
  canEscalate,
  registrarEscalonamento,
  type TicketDeps,
} from "../tickets/operations";
import {
  registrarEscalonamentoInputSchema,
  registrarEscalonamentoOutputSchema,
} from "../tickets/schemas";
import { executeToolCalls } from "./executor";
import {
  decisionSchema,
  type ApprovalRequest,
  type Decision,
  type Proposal,
} from "./proposal";
import { SUPPORT_SYSTEM_PROMPT } from "./prompt";
import {
  AgentState,
  type AgentStateUpdate,
  type AgentStateValue,
} from "./state";
import {
  READ_TOOLS,
  registrarEscalonamentoTool,
  toToolDefinition,
  type AgentTool,
  type ApprovalTool,
} from "./tools";

export type AgentGraphOptions = {
  model: BaseChatModel;
  deps: TicketDeps;
  checkpointer: BaseCheckpointSaver;
  tools?: readonly AgentTool[];
  approvalTool?: ApprovalTool;
  systemPrompt?: string;
  limits?: Partial<Limits>;
};

const toolResultMessage = (call: ToolCall, result: Result<unknown>) =>
  new ToolMessage({
    tool_call_id: call.id!,
    name: call.name,
    status: result.ok ? "success" : "error",
    content: JSON.stringify(result),
  });

function lastAIMessage(messages: BaseMessage[]): AIMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message && AIMessage.isInstance(message)) return message;
  }
  return undefined;
}

/** Tool calls of the last model turn that have no result yet. */
function unansweredCalls(messages: BaseMessage[]): ToolCall[] {
  const answered = new Set(
    messages.filter(ToolMessage.isInstance).map((m) => m.tool_call_id),
  );
  return (lastAIMessage(messages)?.tool_calls ?? []).filter(
    (call) => !answered.has(call.id!),
  );
}

const USER_MESSAGES: Partial<Record<ErrorCode, string>> = {
  LIMIT_EXCEEDED:
    "Execução interrompida: o limite de execução foi atingido. Nenhuma operação adicional foi realizada.",
  MODEL_ERROR:
    "Não foi possível obter resposta do modelo agora. Nenhuma operação foi realizada; tente novamente.",
  INVALID_MODEL_OUTPUT:
    "O modelo produziu uma chamada de ferramenta inválida e a execução foi encerrada. Nenhuma operação foi realizada.",
  INTERNAL_ERROR:
    "Ocorreu um erro inesperado e a execução foi encerrada. Nenhuma operação adicional foi realizada.",
};

/**
 * Ends the turn with a controlled error: pending tool calls get an error
 * result (so the history stays valid) and the user gets a fixed message.
 */
export function endTurnWithError(
  messages: BaseMessage[],
  code: ErrorCode,
  detail: string,
): AgentStateUpdate {
  const closing = unansweredCalls(messages).map((call) =>
    toolResultMessage(call, fail(code, detail)),
  );
  return {
    messages: [...closing, new AIMessage(USER_MESSAGES[code] ?? detail)],
    proposal: null,
    error: { code, message: detail },
  };
}

export function buildAgentGraph(options: AgentGraphOptions) {
  const tools = options.tools ?? READ_TOOLS;
  const approvalTool = options.approvalTool ?? registrarEscalonamentoTool;
  const systemPrompt = options.systemPrompt ?? SUPPORT_SYSTEM_PROMPT;
  const limits = limitsSchema.parse(options.limits ?? {});
  const { deps } = options;

  if (!options.model.bindTools) {
    throw new Error("The configured model does not support tool calling");
  }
  const model = options.model.bindTools(
    [...tools, approvalTool].map(toToolDefinition),
  );

  const remainingMs = (state: AgentStateValue) =>
    limits.activeBudgetMs - state.turn.activeMs;

  /** Stops the turn when the active time or step budget is spent. */
  const budgetExceeded = (state: AgentStateValue) => {
    if (remainingMs(state) <= 0) {
      return endTurnWithError(
        state.messages,
        "LIMIT_EXCEEDED",
        "Tempo de execução ativa esgotado",
      );
    }
    // Leaves room for this node and the end of the turn within recursionLimit.
    if (state.turn.steps >= limits.recursionLimit - 2) {
      return endTurnWithError(
        state.messages,
        "LIMIT_EXCEEDED",
        "Número máximo de passos atingido",
      );
    }
    return undefined;
  };

  /**
   * Adds the node's run time and a step to the turn budget. Waiting on an
   * interrupt throws before returning, so human review time is never counted.
   */
  const tracked =
    (node: (state: AgentStateValue) => Promise<AgentStateUpdate | Command>) =>
    async (state: AgentStateValue) => {
      const startedAt = performance.now();
      const out = await node(state);
      const turn = {
        activeMs: state.turn.activeMs + (performance.now() - startedAt),
        steps: state.turn.steps + 1,
      };
      if (isCommand(out)) {
        return new Command({
          update: { ...(out.update as AgentStateUpdate | undefined), turn },
          goto: out.goto,
        });
      }
      return { ...out, turn };
    };

  const pendingApprovalCall = (state: AgentStateValue) =>
    unansweredCalls(state.messages).find(
      (call) => call.name === approvalTool.name,
    );

  const agent = async (state: AgentStateValue): Promise<AgentStateUpdate> => {
    const exceeded = budgetExceeded(state);
    if (exceeded) return exceeded;

    let response: AIMessage;
    try {
      response = await withDeadline(
        (signal) =>
          model.invoke([new SystemMessage(systemPrompt), ...state.messages], {
            signal,
          }),
        Math.min(limits.modelTimeoutMs, remainingMs(state)),
      );
    } catch {
      return endTurnWithError(
        state.messages,
        "MODEL_ERROR",
        "Falha ou tempo esgotado na chamada ao modelo",
      );
    }
    if (!response.tool_calls?.length && response.invalid_tool_calls?.length) {
      return endTurnWithError(
        state.messages,
        "INVALID_MODEL_OUTPUT",
        "Chamada de ferramenta com argumentos malformados",
      );
    }
    // Some providers omit tool call ids; results must reference them.
    for (const call of response.tool_calls ?? []) call.id ??= randomUUID();
    return { messages: [response] };
  };

  const executor = async (
    state: AgentStateValue,
  ): Promise<AgentStateUpdate> => {
    const exceeded = budgetExceeded(state);
    if (exceeded) return exceeded;

    const calls = lastAIMessage(state.messages)?.tool_calls ?? [];
    const approvalCalls = calls.filter((c) => c.name === approvalTool.name);
    const regular = calls.filter((c) => c.name !== approvalTool.name);

    const messages = await executeToolCalls(regular, {
      tools,
      deps,
      limits,
      remainingMs: remainingMs(state),
    });
    // Only one escalation can be under review at a time.
    for (const extra of approvalCalls.slice(1)) {
      messages.push(
        toolResultMessage(
          extra,
          fail("INVALID_INPUT", "Proponha um escalonamento por vez"),
        ),
      );
    }
    return { messages };
  };

  const propose = async (state: AgentStateValue) => {
    const call = pendingApprovalCall(state)!;
    const reject = (result: Result<unknown>) =>
      new Command({
        update: { messages: [toolResultMessage(call, result)] },
        goto: "agent",
      });

    const input = registrarEscalonamentoInputSchema.safeParse(call.args);
    if (!input.success) {
      return reject(
        fail("INVALID_INPUT", "Proposta de escalonamento inválida"),
      );
    }
    const chamado = await deps.tickets.findById(input.data.chamadoId);
    if (!chamado) {
      return reject(
        fail("NOT_FOUND", `Chamado ${input.data.chamadoId} não encontrado`),
      );
    }
    if (!canEscalate(chamado)) {
      return reject(
        fail(
          "NOT_ESCALATABLE",
          `Chamado ${chamado.id} está ${chamado.situacao}; somente chamados abertos podem ser escalonados`,
        ),
      );
    }

    const proposal: Proposal = {
      id: randomUUID(),
      toolCallId: call.id!,
      ...input.data,
      chamado: {
        id: chamado.id,
        titulo: chamado.titulo,
        situacao: chamado.situacao,
        prioridade: chamado.prioridade,
      },
    };
    return new Command({ update: { proposal }, goto: "approval" });
  };

  const approval = async (state: AgentStateValue) => {
    const proposal = state.proposal!;
    let decision: Decision;
    // Resume values that do not match this proposal are ignored and the graph
    // pauses again, so an approval can only apply to the proposal it was shown.
    for (;;) {
      const parsed = decisionSchema.safeParse(
        interrupt<ApprovalRequest, unknown>({
          type: "escalation_approval",
          proposal,
        }),
      );
      if (parsed.success && parsed.data.proposalId === proposal.id) {
        decision = parsed.data;
        break;
      }
    }

    if (decision.decision === "approve")
      return new Command({ goto: "register" });

    const call: ToolCall = {
      id: proposal.toolCallId,
      name: approvalTool.name,
      args: {},
    };
    return new Command({
      update: {
        messages: [
          toolResultMessage(
            call,
            fail("REJECTED", "Escalonamento rejeitado; nada foi registrado"),
          ),
          new AIMessage(
            `Escalonamento do ${proposal.chamadoId} rejeitado. Nada foi registrado.`,
          ),
        ],
        proposal: null,
        resolutions: { [proposal.id]: "rejected" as const },
      },
      goto: END,
    });
  };

  const register = async (
    state: AgentStateValue,
  ): Promise<AgentStateUpdate> => {
    const proposal = state.proposal!;
    const { chamadoId, resumo, justificativa } = proposal;
    // Executes exactly the proposal that was approved, keyed by its id.
    let result = await registrarEscalonamento(
      deps,
      { chamadoId, resumo, justificativa },
      proposal.id,
    );
    if (
      result.ok &&
      !registrarEscalonamentoOutputSchema.safeParse(result.data).success
    ) {
      result = fail(
        "INVALID_OUTPUT",
        "Saída inválida do registro de escalonamento",
      );
    }
    const call: ToolCall = {
      id: proposal.toolCallId,
      name: approvalTool.name,
      args: {},
    };
    // The outcome is reported from the actual write result, not by the model,
    // so the reply can never confirm a registration that did not happen.
    const outcome = result.ok
      ? `Escalonamento ${result.data.escalonamento.id} registrado para o ${chamadoId}.`
      : `Não foi possível registrar o escalonamento do ${chamadoId}: ${result.error.message}. Nada foi registrado.`;
    return {
      messages: [toolResultMessage(call, result), new AIMessage(outcome)],
      proposal: null,
      resolutions: { [proposal.id]: "approved" as const },
    };
  };

  return new StateGraph(AgentState)
    .addNode("agent", tracked(agent))
    .addNode("executor", tracked(executor))
    .addNode("propose", tracked(propose), { ends: ["agent", "approval"] })
    .addNode("approval", tracked(approval), { ends: ["register", END] })
    .addNode("register", tracked(register))
    .addEdge(START, "agent")
    .addConditionalEdges(
      "agent",
      (state) =>
        !state.error && unansweredCalls(state.messages).length
          ? "executor"
          : END,
      ["executor", END],
    )
    .addConditionalEdges(
      "executor",
      (state) =>
        state.error ? END : pendingApprovalCall(state) ? "propose" : "agent",
      ["propose", "agent", END],
    )
    .addEdge("register", END)
    .compile({ checkpointer: options.checkpointer });
}

export type AgentGraph = ReturnType<typeof buildAgentGraph>;
