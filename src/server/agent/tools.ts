import type { ToolDefinition } from "@langchain/core/language_models/base";
import { z } from "zod";
import type { Result } from "../shared/result";
import {
  consultarChamado,
  listarChamados,
  type TicketDeps,
} from "../tickets/operations";
import {
  consultarChamadoInputSchema,
  consultarChamadoOutputSchema,
  listarChamadosInputSchema,
  listarChamadosOutputSchema,
} from "../tickets/schemas";

export type AgentTool = {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  run: (deps: TicketDeps, input: unknown) => Promise<Result<unknown>>;
};

export const listarChamadosTool: AgentTool = {
  name: "listar_chamados",
  description:
    "Lista chamados de suporte. Use o argumento situacao para filtrar ('aberto' ou 'resolvido'); omita para listar todos.",
  inputSchema: listarChamadosInputSchema,
  outputSchema: listarChamadosOutputSchema,
  run: listarChamados,
};

export const consultarChamadoTool: AgentTool = {
  name: "consultar_chamado",
  description:
    "Consulta um chamado de suporte pelo identificador (ex.: CH-101).",
  inputSchema: consultarChamadoInputSchema,
  outputSchema: consultarChamadoOutputSchema,
  run: consultarChamado,
};

export const READ_TOOLS: readonly AgentTool[] = [
  listarChamadosTool,
  consultarChamadoTool,
];

/** Provider-neutral definition sent to the model; execution never goes through it. */
export function toToolDefinition(tool: AgentTool): ToolDefinition {
  // Some providers reject the "$schema" meta key in tool parameters.
  const parameters: Record<string, unknown> = z.toJSONSchema(tool.inputSchema, {
    io: "input",
  });
  delete parameters.$schema;
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters },
  };
}
