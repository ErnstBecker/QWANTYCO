"use client";

import { useEffect, useState } from "react";
import { ChatPanel } from "./chat-panel";

type SessionItem = { id: string; title: string };

const STORAGE_KEY = "aurora.sessions";

function loadSessions(): SessionItem[] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "[]",
    );
    return Array.isArray(parsed) ? (parsed as SessionItem[]) : [];
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

const newSession = (): SessionItem => ({
  id: crypto.randomUUID(),
  title: "Nova conversa",
});

export function SupportApp() {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    // Restored after mount: localStorage only exists in the browser.
    const stored = loadSessions();
    const initial = stored.length > 0 ? stored : [newSession()];
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSessions(initial);
    setActiveId(initial[0]!.id);
  }, []);

  const update = (next: SessionItem[]) => {
    setSessions(next);
    saveSessions(next);
  };

  const create = () => {
    const session = newSession();
    update([session, ...sessions]);
    setActiveId(session.id);
  };

  const rename = (id: string, text: string) => {
    const title = text.length > 40 ? `${text.slice(0, 40)}…` : text;
    update(sessions.map((s) => (s.id === id ? { ...s, title } : s)));
  };

  return (
    <div className="flex h-dvh flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col gap-2 border-b border-zinc-200 p-3 md:w-64 md:border-r md:border-b-0 dark:border-zinc-800">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-semibold">Aurora Support</h1>
          <button
            type="button"
            onClick={create}
            className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Nova sessão
          </button>
        </div>
        <nav
          aria-label="Sessões"
          className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible"
        >
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => setActiveId(session.id)}
              aria-current={session.id === activeId ? "page" : undefined}
              className={`shrink-0 truncate rounded-md px-2 py-1.5 text-left text-sm ${
                session.id === activeId
                  ? "bg-zinc-200 dark:bg-zinc-800"
                  : "hover:bg-zinc-100 dark:hover:bg-zinc-900"
              }`}
            >
              {session.title}
            </button>
          ))}
        </nav>
      </aside>

      <main className="flex min-h-0 flex-1 flex-col">
        {activeId ? (
          <ChatPanel
            key={activeId}
            sessionId={activeId}
            onFirstMessage={(text) => rename(activeId, text)}
          />
        ) : null}
      </main>
    </div>
  );
}
