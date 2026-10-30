import { fail, ok, parseInput, type Result } from "../shared/result";
import {
  consultarChamadoInputSchema,
  listarChamadosInputSchema,
  registrarEscalonamentoInputSchema,
  type Chamado,
  type ConsultarChamadoOutput,
  type Escalonamento,
  type ListarChamadosOutput,
  type RegistrarEscalonamentoOutput,
} from "./schemas";
import type { EscalationStore, TicketRepository } from "./store";

export type TicketDeps = {
  tickets: TicketRepository;
  escalations: EscalationStore;
  now?: () => Date;
};

export function canEscalate(chamado: Chamado): boolean {
  return chamado.situacao === "aberto";
}

export async function listarChamados(
  deps: TicketDeps,
  input: unknown,
): Promise<Result<ListarChamadosOutput>> {
  const parsed = parseInput(listarChamadosInputSchema, input);
  if (!parsed.ok) return parsed;

  const { situacao } = parsed.data;
  const all = await deps.tickets.list();
  const chamados = situacao ? all.filter((c) => c.situacao === situacao) : all;
  return ok({ chamados, total: chamados.length });
}

export async function consultarChamado(
  deps: TicketDeps,
  input: unknown,
): Promise<Result<ConsultarChamadoOutput>> {
  const parsed = parseInput(consultarChamadoInputSchema, input);
  if (!parsed.ok) return parsed;

  const chamado = await deps.tickets.findById(parsed.data.id);
  if (!chamado) {
    return fail("NOT_FOUND", `Chamado ${parsed.data.id} não encontrado`);
  }
  return ok({ chamado });
}

/**
 * Registers an escalation. Must only be reached after human approval; the
 * idempotency key binds the write to the approved proposal so repeating the
 * approval returns the existing record instead of creating another one.
 */
export async function registrarEscalonamento(
  deps: TicketDeps,
  input: unknown,
  idempotencyKey: string,
): Promise<Result<RegistrarEscalonamentoOutput>> {
  const parsed = parseInput(registrarEscalonamentoInputSchema, input);
  if (!parsed.ok) return parsed;
  const { chamadoId, resumo, justificativa } = parsed.data;

  const replay = (
    existing: Escalonamento,
  ): Result<RegistrarEscalonamentoOutput> => {
    const sameOperation =
      existing.chamadoId === chamadoId &&
      existing.resumo === resumo &&
      existing.justificativa === justificativa;
    return sameOperation
      ? ok({ escalonamento: existing, alreadyProcessed: true })
      : fail(
          "IDEMPOTENCY_CONFLICT",
          "Esta aprovação já foi usada para outra operação",
        );
  };

  const existing = await deps.escalations.findByIdempotencyKey(idempotencyKey);
  if (existing) return replay(existing);

  const chamado = await deps.tickets.findById(chamadoId);
  if (!chamado) {
    return fail("NOT_FOUND", `Chamado ${chamadoId} não encontrado`);
  }
  if (!canEscalate(chamado)) {
    return fail(
      "NOT_ESCALATABLE",
      `Chamado ${chamadoId} está ${chamado.situacao}; somente chamados abertos podem ser escalonados`,
    );
  }

  const now = deps.now?.() ?? new Date();
  const { escalonamento, created } = await deps.escalations.insertOnce({
    chamadoId,
    resumo,
    justificativa,
    idempotencyKey,
    registradoEm: now.toISOString(),
  });
  // A concurrent approval with the same key may have won the race.
  if (!created) return replay(escalonamento);
  return ok({ escalonamento, alreadyProcessed: false });
}
