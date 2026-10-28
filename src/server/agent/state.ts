import { MessagesValue, ReducedValue, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import { proposalSchema, resolutionSchema } from "./proposal";

const resolutionsSchema = z.record(z.string(), resolutionSchema);

export const AgentState = new StateSchema({
  messages: MessagesValue,
  /** Escalation waiting for a human decision; null when nothing is pending. */
  proposal: proposalSchema.nullable().default(null),
  /** Outcome of every decided proposal in this session, by proposal id. */
  resolutions: new ReducedValue(
    resolutionsSchema.default(() => ({})),
    {
      inputSchema: resolutionsSchema,
      reducer: (current, next) => ({ ...current, ...next }),
    },
  ),
});

export type AgentStateValue = typeof AgentState.State;
export type AgentStateUpdate = typeof AgentState.Update;
