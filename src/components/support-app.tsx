"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import type { AssistantId } from "@/lib/stream-events";
import { ChatPanel } from "./chat-panel";

type SessionItem = { id: string; title: string; assistantId: AssistantId };

const ASSISTANTS: { id: AssistantId; label: string }[] = [
  { id: "support", label: "Suporte" },
  { id: "travel", label: "Viagens" },
];

const STORAGE_KEY = "aurora.sessions";

function loadSessions(): SessionItem[] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "[]",
    );
    if (!Array.isArray(parsed)) return [];
    // Sessions saved before assistants existed belong to support.
    return (parsed as Partial<SessionItem>[]).map((s) => ({
      ...(s as SessionItem),
      assistantId: s.assistantId ?? "support",
    }));
  } catch {
    return [];
  }
}

function saveSessions(sessions: SessionItem[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    // Storage may be unavailable (private mode); sessions still work in memory.
  }
}

const NEW_TITLE = "Nova conversa";

const newSession = (assistantId: AssistantId): SessionItem => ({
  id: crypto.randomUUID(),
  title: NEW_TITLE,
  assistantId,
});

/** A conversation keeps the default title until its first message. */
const isEmpty = (session: SessionItem) => session.title === NEW_TITLE;

export function SupportApp() {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [assistantId, setAssistantId] = useState<AssistantId>("support");
  const [activeId, setActiveId] = useState<string | null>(null);
  const visible = sessions.filter((s) => s.assistantId === assistantId);
  const active = visible.find((s) => s.id === activeId);

  useEffect(() => {
    // Restored after mount: localStorage only exists in the browser.
    const stored = loadSessions();
    const first = stored.find((s) => s.assistantId === "support");
    const initial = first ? stored : [newSession("support"), ...stored];
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSessions(initial);
    setActiveId((first ?? initial[0]!).id);
  }, []);

  const update = (next: SessionItem[]) => {
    setSessions(next);
    saveSessions(next);
  };

  /** Opens a conversation of the assistant, reusing an unused one if any. */
  const open = (target: AssistantId, list: SessionItem[] = sessions) => {
    const empty = list.find((s) => s.assistantId === target && isEmpty(s));
    if (empty) {
      setActiveId(empty.id);
      if (list !== sessions) update(list);
      return;
    }
    const session = newSession(target);
    update([session, ...list]);
    setActiveId(session.id);
  };

  const create = () => open(assistantId);

  const switchTo = (target: AssistantId) => {
    if (target === assistantId) return;
    setAssistantId(target);
    const latest = sessions.find((s) => s.assistantId === target);
    if (latest) setActiveId(latest.id);
    else open(target);
  };

  const remove = async (session: SessionItem) => {
    if (
      !window.confirm(`Excluir "${session.title}"? O histórico será apagado.`)
    )
      return;
    try {
      // Waits on the server for a running turn of this session to finish.
      await api.deleteSession(session.id, session.assistantId);
    } catch {
      window.alert("Não foi possível excluir a conversa.");
      return;
    }
    const rest = sessions.filter((s) => s.id !== session.id);
    const sameAssistant = rest.find((s) => s.assistantId === assistantId);
    if (sameAssistant) {
      update(rest);
      if (session.id === activeId) setActiveId(sameAssistant.id);
    } else {
      open(assistantId, rest);
    }
  };

  const rename = (id: string, text: string) => {
    const title = text.length > 40 ? `${text.slice(0, 40)}…` : text;
    update(sessions.map((s) => (s.id === id ? { ...s, title } : s)));
  };

  return (
    <div className="flex h-dvh flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col gap-2 border-b border-zinc-200 p-3 md:w-64 md:border-r md:border-b-0 dark:border-zinc-800">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-semibold">Aurora</h1>
          <button
            type="button"
            onClick={create}
            className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Nova sessão
          </button>
        </div>
        <div
          role="radiogroup"
          aria-label="Assistente"
          className="grid grid-cols-2 gap-1 rounded-md bg-zinc-100 p-1 dark:bg-zinc-900"
        >
          {ASSISTANTS.map((assistant) => (
            <button
              key={assistant.id}
              type="button"
              role="radio"
              aria-checked={assistant.id === assistantId}
              onClick={() => switchTo(assistant.id)}
              className={`rounded px-2 py-1 text-sm ${
                assistant.id === assistantId
                  ? "bg-white font-medium shadow-sm dark:bg-zinc-700"
                  : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              }`}
            >
              {assistant.label}
            </button>
          ))}
        </div>
        <nav
          aria-label="Sessões"
          className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible"
        >
          {visible.map((session) => (
            <div
              key={session.id}
              className={`flex shrink-0 items-center rounded-md ${
                session.id === activeId
                  ? "bg-zinc-200 dark:bg-zinc-800"
                  : "hover:bg-zinc-100 dark:hover:bg-zinc-900"
              }`}
            >
              <button
                type="button"
                onClick={() => setActiveId(session.id)}
                aria-current={session.id === activeId ? "page" : undefined}
                className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm"
              >
                {session.title}
              </button>
              {session.id === activeId ? (
                <button
                  type="button"
                  onClick={() => void remove(session)}
                  aria-label={`Excluir conversa: ${session.title}`}
                  title="Excluir conversa"
                  className="mr-1 rounded px-2 text-zinc-500 hover:bg-zinc-300 hover:text-red-700 dark:hover:bg-zinc-700 dark:hover:text-red-400"
                >
                  <span aria-hidden>×</span>
                </button>
              ) : null}
            </div>
          ))}
        </nav>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {active ? (
          <ChatPanel
            key={active.id}
            sessionId={active.id}
            assistantId={active.assistantId}
            onFirstMessage={(text) => rename(active.id, text)}
          />
        ) : null}
      </main>
    </div>
  );
}
