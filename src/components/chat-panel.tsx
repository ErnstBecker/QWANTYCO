"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSupportSession, type Entry } from "@/hooks/use-support-session";
import { ActivityLog } from "./activity-log";
import { Markdown } from "./markdown";
import { ProposalCard } from "./proposal-card";

const SUGGESTIONS = [
  "Liste todos os chamados abertos.",
  "Consulte o CH-101 e prepare um escalonamento se ele estiver aberto.",
  "Escalone o CH-102.",
];

function EntryView({ entry }: { entry: Entry }) {
  switch (entry.type) {
    case "user":
      return (
        <div className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-lg [overflow-wrap:anywhere] bg-zinc-900 px-3 py-2 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900">
          {entry.text}
        </div>
      );
    case "assistant":
      return (
        <div className="w-fit max-w-[85%] min-w-0 rounded-lg [overflow-wrap:anywhere] bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-800">
          <Markdown text={entry.text} />
          {entry.streaming ? <span className="animate-pulse">▍</span> : null}
        </div>
      );
    case "activity":
      return <ActivityLog items={entry.items} />;
    case "notice":
      return <p className="text-center text-xs text-zinc-500">{entry.text}</p>;
    case "error":
      return (
        <div
          role="alert"
          className="w-fit max-w-[85%] rounded-lg [overflow-wrap:anywhere] border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
        >
          {entry.text}
        </div>
      );
  }
}

export function ChatPanel({
  sessionId,
  onFirstMessage,
}: {
  sessionId: string;
  onFirstMessage: (text: string) => void;
}) {
  const { entries, proposal, status, banner, send, decide } =
    useSupportSession(sessionId);
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const busy = status !== "idle";
  const blocked = busy || proposal !== null;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [entries, proposal]);

  const submit = (text: string) => {
    const message = text.trim();
    if (!message || blocked) return;
    if (!entries.some((e) => e.type === "user")) onFirstMessage(message);
    setDraft("");
    void send(message);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit(draft);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        className="flex-1 space-y-3 overflow-x-hidden overflow-y-auto p-4"
        aria-live="polite"
      >
        {status === "loading" ? (
          <p className="text-sm text-zinc-500">Carregando sessão…</p>
        ) : entries.length === 0 ? (
          <div className="space-y-2">
            <p className="text-sm text-zinc-500">Experimente:</p>
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => submit(suggestion)}
                className="block rounded-md border border-zinc-200 px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
              >
                {suggestion}
              </button>
            ))}
          </div>
        ) : (
          entries.map((entry, index) => <EntryView key={index} entry={entry} />)
        )}
        {status === "streaming" ? (
          <p className="text-xs text-zinc-500">Processando…</p>
        ) : null}
        {proposal ? (
          <ProposalCard
            proposal={proposal}
            busy={busy}
            onDecide={(d) => void decide(d)}
          />
        ) : null}
        <div ref={endRef} />
      </div>

      {banner ? (
        <p
          role="alert"
          className="mx-4 mb-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-300"
        >
          {banner}
        </p>
      ) : null}

      <form
        onSubmit={onSubmit}
        className="flex gap-2 border-t border-zinc-200 p-4 dark:border-zinc-800"
      >
        <label htmlFor="message" className="sr-only">
          Mensagem
        </label>
        <input
          id="message"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={blocked}
          maxLength={4000}
          placeholder={
            proposal
              ? "Decida sobre a proposta antes de continuar"
              : "Pergunte sobre os chamados…"
          }
          className="flex-1 rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm disabled:opacity-60 dark:border-zinc-700"
        />
        <button
          type="submit"
          disabled={blocked || !draft.trim()}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          Enviar
        </button>
      </form>
    </div>
  );
}
