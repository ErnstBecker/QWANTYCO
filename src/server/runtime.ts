import { MemorySaver } from "@langchain/langgraph";
import { buildAgentGraph } from "./agent/graph";
import { parseFaultPlan, withFaults } from "./agent/faults";
import {
  createSupportService,
  type SupportService,
} from "./agent/support-service";
import { READ_TOOLS } from "./agent/tools";
import { loadLimits, loadModelConfig } from "./config/env";
import { createChatModel } from "./model/factory";
import { createEscalationStore, createTicketRepository } from "./tickets/store";

export type Runtime = {
  service: SupportService;
  model: { provider: string; name: string };
};

const globalRef = globalThis as { __auroraRuntime?: Runtime };

/**
 * One in-memory runtime per server process (checkpoints, mock data and the
 * escalation store). Kept on globalThis so dev hot reloads do not reset it.
 */
export function getRuntime(): Runtime {
  globalRef.__auroraRuntime ??= createRuntime();
  return globalRef.__auroraRuntime;
}

function createRuntime(): Runtime {
  const modelConfig = loadModelConfig();
  const limits = loadLimits();
  const deps = {
    tickets: createTicketRepository(),
    escalations: createEscalationStore(),
  };
  const graph = buildAgentGraph({
    model: createChatModel(modelConfig, limits),
    deps,
    checkpointer: new MemorySaver(),
    tools: withFaults(READ_TOOLS, parseFaultPlan(process.env.FAULT_PLAN)),
    limits,
  });
  return {
    service: createSupportService(graph, deps, {
      recursionLimit: limits.recursionLimit,
    }),
    model: { provider: modelConfig.provider, name: modelConfig.model },
  };
}
