import type { ToolCall } from "@langchain/core/messages/tool";
import { ToolMessage } from "@langchain/core/messages";
import { randomUUID } from "node:crypto";
import { fail, ok, type Result } from "../shared/result";
import type { TicketDeps } from "../tickets/operations";
import type { AgentTool } from "./tools";

export type ExecutorContext = {
  /** Allowlist: only these tools can run, whatever the model asks for. */
  tools: readonly AgentTool[];
  deps: TicketDeps;
};

async function runTool(
  call: ToolCall,
  ctx: ExecutorContext,
): Promise<Result<unknown>> {
  const tool = ctx.tools.find((t) => t.name === call.name);
  if (!tool) {
    return fail(
      "UNKNOWN_TOOL",
      `Ferramenta '${call.name}' não está disponível`,
    );
  }

  let result: Result<unknown>;
  try {
    result = await tool.run(ctx.deps, call.args);
  } catch {
    return fail("TOOL_ERROR", `Falha ao executar '${call.name}'`);
  }
  if (!result.ok) return result;

  const output = tool.outputSchema.safeParse(result.data);
  if (!output.success) {
    return fail("INVALID_OUTPUT", `Saída inválida de '${call.name}'`);
  }
  return ok(output.data);
}

/** Validates and runs each tool call, returning one ToolMessage per call. */
export async function executeToolCalls(
  calls: readonly ToolCall[],
  ctx: ExecutorContext,
): Promise<ToolMessage[]> {
  const messages: ToolMessage[] = [];
  for (const call of calls) {
    const result = await runTool(call, ctx);
    messages.push(
      new ToolMessage({
        tool_call_id: call.id ?? randomUUID(),
        name: call.name,
        status: result.ok ? "success" : "error",
        content: JSON.stringify(result),
      }),
    );
  }
  return messages;
}
