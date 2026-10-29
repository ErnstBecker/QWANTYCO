import type { ActivityItem } from "@/hooks/use-support-session";

const TOOL_LABELS: Record<string, string> = {
  listar_chamados: "Listar chamados",
  consultar_chamado: "Consultar chamado",
  propor_escalonamento: "Escalonamento",
};

const label = (name: string) => TOOL_LABELS[name] ?? name;

/** Tool calls the model emitted and what the executor returned. */
export function ActivityLog({ items }: { items: ActivityItem[] }) {
  return (
    <ul className="w-fit max-w-full space-y-1 [overflow-wrap:anywhere] rounded-md border border-zinc-200 bg-zinc-50 p-2 font-mono text-xs dark:border-zinc-800 dark:bg-zinc-900">
      {items.map((item, index) =>
        item.kind === "call" ? (
          <li
            key={`${item.id}-call-${index}`}
            className="text-zinc-600 dark:text-zinc-400"
          >
            <span aria-hidden>→ </span>
            {label(item.name)}{" "}
            <span className="text-zinc-500">{JSON.stringify(item.args)}</span>
          </li>
        ) : (
          <li
            key={`${item.id}-result-${index}`}
            className={
              item.status === "success"
                ? "text-emerald-700 dark:text-emerald-400"
                : "text-red-700 dark:text-red-400"
            }
          >
            <span aria-hidden>{item.status === "success" ? "✓ " : "✗ "}</span>
            {label(item.name)}
            {item.status === "success"
              ? " ok"
              : ` ${item.error?.code ?? "erro"}`}
            {item.attempts && item.attempts > 1
              ? ` (${item.attempts} tentativas)`
              : ""}
            {item.error ? (
              <span className="text-zinc-500"> · {item.error.message}</span>
            ) : null}
          </li>
        ),
      )}
    </ul>
  );
}
