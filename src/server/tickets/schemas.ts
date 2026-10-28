import { z } from "zod";

export const SITUACOES = ["aberto", "resolvido"] as const;
export const situacaoSchema = z.enum(SITUACOES);
export type Situacao = z.infer<typeof situacaoSchema>;

export const prioridadeSchema = z.enum(["baixa", "media", "alta", "critica"]);

export const chamadoIdSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^CH-\d{3,}$/, "Identificador deve seguir o formato CH-000");

export const chamadoSchema = z.object({
  id: chamadoIdSchema,
  titulo: z.string().min(1),
  descricao: z.string().min(1),
  cliente: z.string().min(1),
  prioridade: prioridadeSchema,
  situacao: situacaoSchema,
  criadoEm: z.iso.datetime(),
  atualizadoEm: z.iso.datetime(),
});
export type Chamado = z.infer<typeof chamadoSchema>;

export const escalonamentoSchema = z.object({
  id: z.string().regex(/^ESC-\d{4,}$/),
  chamadoId: chamadoIdSchema,
  resumo: z.string().min(1),
  justificativa: z.string().min(1),
  idempotencyKey: z.string().min(1),
  registradoEm: z.iso.datetime(),
});
export type Escalonamento = z.infer<typeof escalonamentoSchema>;

// Tool contracts

export const listarChamadosInputSchema = z
  .object({ situacao: situacaoSchema.optional() })
  .strict();
export const listarChamadosOutputSchema = z.object({
  chamados: z.array(chamadoSchema),
  total: z.number().int().nonnegative(),
});

export const consultarChamadoInputSchema = z
  .object({ id: chamadoIdSchema })
  .strict();
export const consultarChamadoOutputSchema = z.object({
  chamado: chamadoSchema,
});

export const registrarEscalonamentoInputSchema = z
  .object({
    chamadoId: chamadoIdSchema,
    resumo: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe(
        "Resumo do problema em 1-2 frases, usando apenas título e descrição do chamado consultado.",
      ),
    justificativa: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .describe(
        "Por que escalonar, citando dados do chamado (prioridade, cliente, impacto, datas). Texto completo, sem referências como 'acima'.",
      ),
  })
  .strict();
export const registrarEscalonamentoOutputSchema = z.object({
  escalonamento: escalonamentoSchema,
  alreadyProcessed: z.boolean(),
});

export type ListarChamadosInput = z.input<typeof listarChamadosInputSchema>;
export type ListarChamadosOutput = z.infer<typeof listarChamadosOutputSchema>;
export type ConsultarChamadoInput = z.input<typeof consultarChamadoInputSchema>;
export type ConsultarChamadoOutput = z.infer<
  typeof consultarChamadoOutputSchema
>;
export type RegistrarEscalonamentoInput = z.input<
  typeof registrarEscalonamentoInputSchema
>;
export type RegistrarEscalonamentoOutput = z.infer<
  typeof registrarEscalonamentoOutputSchema
>;
