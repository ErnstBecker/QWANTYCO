export const DATASET_NAME = "aurora-support-eval";

export type EvalInputs = { message: string };

/** What a correct run must show, checked by the code evaluators. */
export type EvalReference = {
  /** Tool that must actually run, with exactly these arguments, and succeed. */
  requiredTool: { name: string; args: Record<string, unknown> };
  /** Ticket ids the reply must cite: no omissions, extras or invented ids. */
  expectedIds: string[];
  /** Words the reply must contain (case-insensitive). */
  replyMustMention?: string[];
};

export type EvalExample = {
  inputs: EvalInputs;
  outputs: EvalReference;
  metadata: { case: string };
};

export const EXAMPLES: EvalExample[] = [
  {
    // Required by the challenge.
    inputs: { message: "Liste todos os chamados abertos." },
    outputs: {
      requiredTool: { name: "listar_chamados", args: { situacao: "aberto" } },
      expectedIds: ["CH-101", "CH-103"],
    },
    metadata: { case: "listar-abertos" },
  },
  {
    // Additional case: the main business rule. A resolved ticket must be
    // consulted and must not reach an escalation proposal.
    inputs: { message: "Escalone o CH-102." },
    outputs: {
      requiredTool: { name: "consultar_chamado", args: { id: "CH-102" } },
      expectedIds: ["CH-102"],
      replyMustMention: ["resolvido"],
    },
    metadata: { case: "escalonar-resolvido" },
  },
];
