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
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import { fail, type Result } from "../shared/result";
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
import { AgentState, type AgentStateValue } from "./state";
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

export function buildAgentGraph(options: AgentGraphOptions) {
  const tools = options.tools ?? READ_TOOLS;
  const approvalTool = options.approvalTool ?? registrarEscalonamentoTool;
  const systemPrompt = options.systemPrompt ?? SUPPORT_SYSTEM_PROMPT;
  const { deps } = options;

  if (!options.model.bindTools) {
    throw new Error("The configured model does not support tool calling");
  }
  const model = options.model.bindTools(
    [...tools, approvalTool].map(toToolDefinition),
  );

  /** The approval call of the last model turn that has no result yet. */
  const pendingApprovalCall = (state: AgentStateValue) => {
    const ai = lastAIMessage(state.messages);
    const answered = new Set(
      state.messages.filter(ToolMessage.isInstance).map((m) => m.tool_call_id),
    );
    return ai?.tool_calls?.find(
      (call) => call.name === approvalTool.name && !answered.has(call.id!),
    );
  };

  const agent = async (state: AgentStateValue) => {
    const response = await model.invoke([
      new SystemMessage(systemPrompt),
      ...state.messages,
    ]);
    // Some providers omit tool call ids; results must reference them.
    for (const call of response.tool_calls ?? []) call.id ??= randomUUID();
    return { messages: [response] };
  };

  const executor = async (state: AgentStateValue) => {
    const calls = lastAIMessage(state.messages)?.tool_calls ?? [];
    const approvalCalls = calls.filter((c) => c.name === approvalTool.name);
    const regular = calls.filter((c) => c.name !== approvalTool.name);

    const messages = await executeToolCalls(regular, { tools, deps });
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

  const register = async (state: AgentStateValue) => {
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
    return {
      messages: [toolResultMessage(call, result)],
      proposal: null,
      resolutions: { [proposal.id]: "approved" as const },
    };
  };

  return new StateGraph(AgentState)
    .addNode("agent", agent)
    .addNode("executor", executor)
    .addNode("propose", propose, { ends: ["agent", "approval"] })
    .addNode("approval", approval, { ends: ["register", END] })
    .addNode("register", register)
    .addEdge(START, "agent")
    .addConditionalEdges(
      "agent",
      (state) =>
        lastAIMessage(state.messages)?.tool_calls?.length ? "executor" : END,
      ["executor", END],
    )
    .addConditionalEdges(
      "executor",
      (state) => (pendingApprovalCall(state) ? "propose" : "agent"),
      ["propose", "agent"],
    )
    .addEdge("register", "agent")
    .compile({ checkpointer: options.checkpointer });
}

export type AgentGraph = ReturnType<typeof buildAgentGraph>;
