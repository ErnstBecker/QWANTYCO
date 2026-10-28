import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, SystemMessage } from "@langchain/core/messages";
import {
  END,
  START,
  StateGraph,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import type { TicketDeps } from "../tickets/operations";
import { executeToolCalls } from "./executor";
import { SUPPORT_SYSTEM_PROMPT } from "./prompt";
import { AgentState, type AgentStateValue } from "./state";
import { READ_TOOLS, toToolDefinition, type AgentTool } from "./tools";

export type AgentGraphOptions = {
  model: BaseChatModel;
  deps: TicketDeps;
  checkpointer: BaseCheckpointSaver;
  tools?: readonly AgentTool[];
  systemPrompt?: string;
};

function lastAIMessage(state: AgentStateValue): AIMessage | undefined {
  const last = state.messages.at(-1);
  return last && AIMessage.isInstance(last) ? last : undefined;
}

export function buildAgentGraph(options: AgentGraphOptions) {
  const tools = options.tools ?? READ_TOOLS;
  const systemPrompt = options.systemPrompt ?? SUPPORT_SYSTEM_PROMPT;

  if (!options.model.bindTools) {
    throw new Error("The configured model does not support tool calling");
  }
  const model = options.model.bindTools(tools.map(toToolDefinition));

  const agent = async (state: AgentStateValue) => {
    const response = await model.invoke([
      new SystemMessage(systemPrompt),
      ...state.messages,
    ]);
    return { messages: [response] };
  };

  const executor = async (state: AgentStateValue) => {
    const calls = lastAIMessage(state)?.tool_calls ?? [];
    return {
      messages: await executeToolCalls(calls, { tools, deps: options.deps }),
    };
  };

  const route = (state: AgentStateValue) =>
    lastAIMessage(state)?.tool_calls?.length ? "executor" : END;

  return new StateGraph(AgentState)
    .addNode("agent", agent)
    .addNode("executor", executor)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", route, ["executor", END])
    .addEdge("executor", "agent")
    .compile({ checkpointer: options.checkpointer });
}

export type AgentGraph = ReturnType<typeof buildAgentGraph>;
