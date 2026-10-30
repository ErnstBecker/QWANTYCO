import { z } from "zod";

export const FINALIDADES = [
  "turismo",
  "negocios",
  "estudo",
  "trabalho",
] as const;
export const finalidadeSchema = z.enum(FINALIDADES);
export type Finalidade = z.infer<typeof finalidadeSchema>;

export const documentoViagemSchema = z.object({
  /** Source id cited in answers, e.g. FR-BR-TURISMO. */
  id: z.string().min(1),
  titulo: z.string().min(1),
  destino: z.string().min(1),
  nacionalidade: z.string().min(1),
  finalidade: finalidadeSchema,
  /** Stay length the document applies to; maxDias null means no upper bound. */
  duracao: z.object({
    minDias: z.number().int().nonnegative(),
    maxDias: z.number().int().positive().nullable(),
  }),
  conteudo: z.string().min(1),
});
export type DocumentoViagem = z.infer<typeof documentoViagemSchema>;

// Tool contracts

export const callRagInputSchema = z
  .object({
    pergunta: z
      .string()
      .trim()
      .min(3)
      .max(500)
      .describe("Pergunta do usuário, em linguagem natural."),
    destino: z
      .string()
      .trim()
      .min(2)
      .max(60)
      .describe("País de destino informado pelo usuário (ex.: França)."),
    nacionalidade: z
      .string()
      .trim()
      .min(2)
      .max(60)
      .optional()
      .describe(
        "Nacionalidade do passaporte, somente se o usuário informou (ex.: brasileira).",
      ),
    finalidade: finalidadeSchema
      .optional()
      .describe("Finalidade da viagem, somente se o usuário informou."),
    duracaoDias: z
      .number()
      .int()
      .positive()
      .max(3650)
      .optional()
      .describe("Duração da estadia em dias, somente se o usuário informou."),
  })
  .strict();
export type CallRagInput = z.infer<typeof callRagInputSchema>;

export const trechoSchema = z.object({
  fonte: z.string(),
  titulo: z.string(),
  aplicaSe: z.object({
    destino: z.string(),
    nacionalidade: z.string(),
    finalidade: finalidadeSchema,
    duracao: z.string(),
  }),
  texto: z.string(),
});
export type Trecho = z.infer<typeof trechoSchema>;

export const callRagOutputSchema = z.object({
  /** The knowledge base is fictitious; answers must say so. */
  simulacao: z.literal(true),
  /** Empty when the base has no evidence for the question. */
  trechos: z.array(trechoSchema),
});
export type CallRagOutput = z.infer<typeof callRagOutputSchema>;
