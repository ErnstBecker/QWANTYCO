import { MemorySaver } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import type { Outcome, StreamEvent } from "@/lib/stream-events";
import type { Limits } from "../config/env";
import { withFaults, type FaultPlan } from "../agent/faults";
import { buildAgentGraph } from "../agent/graph";
import { createSupportService } from "../agent/support-service";
import { READ_TOOLS } from "../agent/tools";
import type { TicketDeps } from "../tickets/operations";
import {
  createEscalationStore,
  createTicketRepository,
} from "../tickets/store";
import { ScriptedChatModel, type ScriptStep } from "./scripted-model";

export type HarnessOptions = {
  faults?: FaultPlan;
  limits?: Partial<Limits>;
  deps?: Partial<TicketDeps>;
};

/** Real graph, executor and service, driven by a scripted model. */
export function createHarness(
  steps: ScriptStep[],
  options: HarnessOptions = {},
) {
  const deps: TicketDeps = {
    tickets: options.deps?.tickets ?? createTicketRepository(),
    escalations: options.deps?.escalations ?? createEscalationStore(),
  };
  const model = new ScriptedChatModel(steps);
  const graph = buildAgentGraph({
    model,
    deps,
    checkpointer: new MemorySaver(),
    tools: withFaults(READ_TOOLS, options.faults ?? {}),
    limits: options.limits,
  });
  const service = createSupportService(graph, deps, {
    recursionLimit: options.limits?.recursionLimit,
  });
  return { deps, model, graph, service, newSession: () => randomUUID() };
}

export const post = (body: unknown, signal?: AbortSignal) =>
  new Request("http://test/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal,
  });

export async function readEvents(response: Response): Promise<StreamEvent[]> {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new Error(
      `Expected SSE, got ${response.status}: ${await response.text()}`,
    );
  }
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => JSON.parse(block.slice("data: ".length)) as StreamEvent);
}

export function outcomeOf(events: StreamEvent[]): Outcome {
  const done = events.at(-1);
  if (done?.type !== "done") throw new Error("stream did not finish with done");
  return done.outcome;
}

export const toolCalls = (events: StreamEvent[]) =>
  events.flatMap((e) =>
    e.type === "tool_call" ? [{ name: e.name, args: e.args }] : [],
  );

export const toolResults = (events: StreamEvent[]) =>
  events.flatMap((e) => (e.type === "tool_result" ? [e] : []));
