import { z } from "zod";
import { TransientToolError } from "../agent/executor";
import type { AgentTool } from "../agent/tools";
import { ok } from "../shared/result";

export const faultSchema = z.enum([
  "transient", // throws a retryable error
  "hang", // never resolves, so the call times out
  "invalid_output", // returns data that breaks the output contract
  "crash", // throws a non-retryable error
]);
export type Fault = z.infer<typeof faultSchema>;

/** Faults to inject per tool, consumed in order: one entry per call. */
export const faultPlanSchema = z.record(z.string(), z.array(faultSchema));
export type FaultPlan = z.infer<typeof faultPlanSchema>;

export function parseFaultPlan(raw: string | undefined): FaultPlan {
  if (!raw?.trim()) return {};
  const parsed = faultPlanSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error("Invalid FAULT_PLAN");
  return parsed.data;
}

/** Wraps tools so their next calls fail as described by the plan. */
export function withFaults(
  tools: readonly AgentTool[],
  plan: FaultPlan,
): AgentTool[] {
  return tools.map((tool) => {
    const queue = [...(plan[tool.name] ?? [])];
    if (queue.length === 0) return tool;
    return {
      ...tool,
      run: async (deps, input) => {
        switch (queue.shift()) {
          case "transient":
            throw new TransientToolError();
          case "hang":
            return new Promise<never>(() => {});
          case "invalid_output":
            return ok({ unexpected: true });
          case "crash":
            throw new Error("Falha simulada");
          default:
            return tool.run(deps, input);
        }
      },
    };
  });
}
