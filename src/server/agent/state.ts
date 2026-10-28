import { MessagesValue, ReducedValue, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import { proposalSchema, resolutionSchema } from "./proposal";

const resolutionsSchema = z.record(z.string(), resolutionSchema);

export const turnSchema = z.object({
  /** Time spent running nodes in this user turn; waiting for a human is not counted. */
  activeMs: z.number().nonnegative(),
  /** Nodes executed in this user turn. */
  steps: z.number().int().nonnegative(),
});
export type Turn = z.infer<typeof turnSchema>;
export const NEW_TURN: Turn = { activeMs: 0, steps: 0 };

export const turnErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type TurnError = z.infer<typeof turnErrorSchema>;

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
  turn: turnSchema.default(() => ({ ...NEW_TURN })),
  /** Set when the turn ended with a controlled error. */
  error: turnErrorSchema.nullable().default(null),
});

export type AgentStateValue = typeof AgentState.State;
export type AgentStateUpdate = typeof AgentState.Update;
