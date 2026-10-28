import { MessagesValue, StateSchema } from "@langchain/langgraph";

export const AgentState = new StateSchema({
  messages: MessagesValue,
});

export type AgentStateValue = typeof AgentState.State;
