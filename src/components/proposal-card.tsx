import type { ProposalView } from "@/lib/stream-events";

type Props = {
  proposal: ProposalView;
  busy: boolean;
  onDecide: (decision: "approve" | "reject") => void;
};

/** Shows exactly what will be registered if the person approves. */
export function ProposalCard({ proposal, busy, onDecide }: Props) {
  const { chamado } = proposal;
  return (
    <section
      aria-labelledby="proposal-title"
      className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950/40"
    >
      <h2 id="proposal-title" className="text-sm font-semibold">
        Escalonamento aguardando sua decisão
      </h2>
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
        Nada foi registrado ainda. Aprovar registra exatamente o conteúdo
        abaixo.
      </p>

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
        <dt className="font-medium">Chamado</dt>
        <dd>
          {chamado.id} — {chamado.titulo}
          <span className="ml-2 text-xs text-zinc-600 dark:text-zinc-400">
            {chamado.situacao} · prioridade {chamado.prioridade}
          </span>
        </dd>
        <dt className="font-medium">Resumo</dt>
        <dd className="whitespace-pre-wrap">{proposal.resumo}</dd>
        <dt className="font-medium">Justificativa</dt>
        <dd className="whitespace-pre-wrap">{proposal.justificativa}</dd>
      </dl>

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onDecide("approve")}
          className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
        >
          Aprovar
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onDecide("reject")}
          className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Rejeitar
        </button>
      </div>
      <p className="mt-2 font-mono text-[10px] text-zinc-500">
        proposta {proposal.id}
      </p>
    </section>
  );
}
