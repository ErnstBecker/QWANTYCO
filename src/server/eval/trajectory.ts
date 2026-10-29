import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { TurnError } from "../agent/state";

/** One tool call of the turn and what the executor actually returned for it. */
export type ToolStep = {
  name: string;
  args: Record<string, unknown>;
  executed: boolean;
  ok: boolean;
  data?: unknown;
  error?: TurnError;
};

/** What the evaluators see: the final reply plus the executed trajectory. */
export type AgentRunOutput = {
  reply: string;
  status: string;
  steps: ToolStep[];
  escalationsRegistered: number;
};

/**
 * Pairs each tool call of the last turn with its ToolMessage. Results come
 * from the executor (checkpointed state), never from the model's text.
 */
export function toolSteps(messages: BaseMessage[]): ToolStep[] {
  const turnStart = messages.findLastIndex((m) => HumanMessage.isInstance(m));
  const turn = messages.slice(turnStart + 1);
  const results = new Map(
    turn.filter(ToolMessage.isInstance).map((m) => [m.tool_call_id, m]),
  );

  return turn.filter(AIMessage.isInstance).flatMap((message) =>
    (message.tool_calls ?? []).map((call): ToolStep => {
      const result = results.get(call.id!);
      if (!result) {
        return { name: call.name, args: call.args, executed: false, ok: false };
      }
      const body = JSON.parse(result.text) as {
        ok: boolean;
        data?: unknown;
        error?: TurnError;
      };
      return {
        name: call.name,
        args: call.args,
        executed: true,
        ok: body.ok,
        data: body.data,
        error: body.error,
      };
    }),
  );
}
