import { z } from "zod";
import { chamadoSchema } from "../tickets/schemas";

export const proposalSchema = z.object({
  id: z.uuid(),
  toolCallId: z.string().min(1),
  chamadoId: z.string(),
  resumo: z.string(),
  justificativa: z.string(),
  /** Snapshot shown to the reviewer; the write re-checks the live record. */
  chamado: chamadoSchema.pick({
    id: true,
    titulo: true,
    situacao: true,
    prioridade: true,
  }),
});
export type Proposal = z.infer<typeof proposalSchema>;

export const decisionSchema = z.object({
  proposalId: z.uuid(),
  decision: z.enum(["approve", "reject"]),
});
export type Decision = z.infer<typeof decisionSchema>;

export const resolutionSchema = z.enum(["approved", "rejected"]);
export type Resolution = z.infer<typeof resolutionSchema>;

export type ApprovalRequest = {
  type: "escalation_approval";
  proposal: Proposal;
};
