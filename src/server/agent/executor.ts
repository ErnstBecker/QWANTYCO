import type { ToolCall } from "@langchain/core/messages/tool";
import { ToolMessage } from "@langchain/core/messages";
import { traceable } from "langsmith/traceable";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { DeadlineError, withDeadline } from "../shared/deadline";
import { fail, ok, type Result } from "../shared/result";
import type { TicketDeps } from "../tickets/operations";
import { TransientToolError } from "./faults";
import type { AgentTool } from "./tools";

export type ToolLimits = {
  toolTimeoutMs: number;
  toolMaxAttempts: number;
  toolBackoffMs: number;
};

export type ExecutorContext = {
  /** Allowlist: only these tools can run, whatever the model asks for. */
  tools: readonly AgentTool[];
  deps: TicketDeps;
  limits: ToolLimits;
  /** Remaining active budget; a call never waits longer than this. */
  remainingMs?: number;
};

type Execution = { result: Result<unknown>; attempts: number };

async function runTool(
  call: ToolCall,
  ctx: ExecutorContext,
): Promise<Execution> {
  const tool = ctx.tools.find((t) => t.name === call.name);
  if (!tool) {
    return {
      result: fail(
        "UNKNOWN_TOOL",
        `Ferramenta '${call.name}' não está disponível`,
      ),
      attempts: 0,
    };
  }

  // Input contract is checked before the function runs at all.
  const input = tool.inputSchema.safeParse(call.args);
  if (!input.success) {
    const detail = input.error.issues
      .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
      .join("; ");
    return {
      result: fail(
        "INVALID_INPUT",
        `Argumentos inválidos para '${call.name}' (${detail})`,
      ),
      attempts: 0,
    };
  }

  const { toolTimeoutMs, toolMaxAttempts, toolBackoffMs } = ctx.limits;
  const startedAt = Date.now();
  for (let attempt = 1; attempt <= toolMaxAttempts; attempt++) {
    const remaining = (ctx.remainingMs ?? Infinity) - (Date.now() - startedAt);
    if (remaining <= 0) {
      return {
        result: fail("LIMIT_EXCEEDED", "Limite de execução atingido"),
        attempts: attempt - 1,
      };
    }
    try {
      // Each attempt is its own span, so retries, timeouts and errors show in the trace.
      const result = await traceable(
        (args: typeof input.data) =>
          withDeadline(
            () => tool.run(ctx.deps, args),
            Math.min(toolTimeoutMs, remaining),
          ),
        {
          name: `${call.name} attempt`,
          run_type: "chain",
          metadata: { attempt },
        },
      )(input.data);
      if (!result.ok) return { result, attempts: attempt };
      const output = tool.outputSchema.safeParse(result.data);
      return {
        result: output.success
          ? ok(output.data)
          : fail("INVALID_OUTPUT", `Saída inválida de '${call.name}'`),
        attempts: attempt,
      };
    } catch (error) {
      const retryable =
        error instanceof TransientToolError || error instanceof DeadlineError;
      if (!retryable) {
        return {
          result: fail("TOOL_ERROR", `Falha ao executar '${call.name}'`),
          attempts: attempt,
        };
      }
      if (attempt < toolMaxAttempts) {
        await sleep(toolBackoffMs * 2 ** (attempt - 1));
      }
    }
  }
  return {
    result: fail(
      "TOOL_UNAVAILABLE",
      `'${call.name}' indisponível após ${toolMaxAttempts} tentativas`,
    ),
    attempts: toolMaxAttempts,
  };
}

/** Validates and runs each tool call, returning one ToolMessage per call. */
export async function executeToolCalls(
  calls: readonly ToolCall[],
  ctx: ExecutorContext,
): Promise<ToolMessage[]> {
  const messages: ToolMessage[] = [];
  const startedAt = Date.now();
  for (const call of calls) {
    const elapsed = Date.now() - startedAt;
    const { result, attempts } = await traceable(
      (args: ToolCall["args"]) =>
        runTool(
          { ...call, args },
          {
            ...ctx,
            remainingMs: (ctx.remainingMs ?? Infinity) - elapsed,
          },
        ),
      {
        name: call.name,
        run_type: "tool",
        metadata: { tool_call_id: call.id },
      },
    )(call.args);
    messages.push(
      new ToolMessage({
        tool_call_id: call.id ?? randomUUID(),
        name: call.name,
        status: result.ok ? "success" : "error",
        content: JSON.stringify(result),
        artifact: { attempts },
      }),
    );
  }
  return messages;
}
