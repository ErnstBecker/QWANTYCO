"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError, api } from "@/lib/api-client";
import {
  toActivityItem,
  type ActivityItem,
  type AssistantId,
  type ProposalView,
  type StreamEvent,
} from "@/lib/stream-events";

export type { ActivityItem };

export type Entry =
  | { type: "user"; text: string }
  | { type: "assistant"; text: string; streaming?: boolean }
  | { type: "activity"; items: ActivityItem[] }
  | { type: "notice"; text: string }
  | { type: "error"; text: string };

type Status = "loading" | "idle" | "streaming";

/** Folds one stream event into the visible conversation. */
export function applyEvent(entries: Entry[], event: StreamEvent): Entry[] {
  const next = [...entries];
  const last = next.at(-1);
  const closeStreaming = () => {
    if (last?.type === "assistant" && last.streaming) {
      next[next.length - 1] = { ...last, streaming: false };
    }
  };

  switch (event.type) {
    case "token":
      if (last?.type === "assistant" && last.streaming) {
        next[next.length - 1] = { ...last, text: last.text + event.text };
      } else {
        next.push({ type: "assistant", text: event.text, streaming: true });
      }
      return next;
    case "tool_call":
    case "tool_result": {
      closeStreaming();
      const item = toActivityItem(event);
      const tail = next.at(-1);
      if (tail?.type === "activity") {
        next[next.length - 1] = { ...tail, items: [...tail.items, item] };
      } else {
        next.push({ type: "activity", items: [item] });
      }
      return next;
    }
    case "done": {
      closeStreaming();
      const outcome = event.outcome;
      const lastText = [...next]
        .reverse()
        .find((e) => e.type === "assistant")?.text;
      if (
        outcome.status === "completed" &&
        outcome.reply &&
        outcome.reply !== lastText
      ) {
        next.push({ type: "assistant", text: outcome.reply });
      } else if (outcome.status === "failed") {
        next.push({ type: "error", text: outcome.reply });
      } else if (outcome.status === "already_processed") {
        next.push({
          type: "notice",
          text:
            outcome.resolution === "approved"
              ? `Esta proposta já havia sido aprovada (${outcome.escalonamento.id}). Nenhum registro novo foi criado.`
              : "Esta proposta já havia sido rejeitada. Nada foi registrado.",
        });
      }
      return next;
    }
    default:
      return next;
  }
}

export function useSupportSession(sessionId: string, assistantId: AssistantId) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [proposal, setProposal] = useState<ProposalView | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [banner, setBanner] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // The panel is remounted per session (keyed by id), so state starts clean here.
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;

    api
      .getSession(sessionId, assistantId)
      .then((view) => {
        if (controller.signal.aborted) return;
        setEntries(view.entries);
        setProposal(view.proposal);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setBanner("Não foi possível carregar a sessão.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setStatus("idle");
      });

    return () => controller.abort();
  }, [sessionId, assistantId]);

  const consume = useCallback(
    async (
      start: (signal: AbortSignal) => Promise<AsyncGenerator<StreamEvent>>,
    ) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus("streaming");
      setBanner(null);
      try {
        for await (const event of await start(controller.signal)) {
          setEntries((current) => applyEvent(current, event));
          if (event.type === "done") {
            setProposal(
              event.outcome.status === "awaiting_approval"
                ? event.outcome.proposal
                : null,
            );
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setBanner(
          error instanceof ApiRequestError
            ? error.message
            : "Falha de conexão com o servidor.",
        );
      } finally {
        if (!controller.signal.aborted) setStatus("idle");
      }
    },
    [],
  );

  const send = useCallback(
    (text: string) => {
      setEntries((current) => [...current, { type: "user", text }]);
      return consume((signal) =>
        api.sendMessage(sessionId, assistantId, text, signal),
      );
    },
    [consume, sessionId, assistantId],
  );

  const decide = useCallback(
    (decision: "approve" | "reject") => {
      if (!proposal) return Promise.resolve();
      return consume(async (signal) => {
        const events = await api.decide(
          sessionId,
          assistantId,
          proposal.id,
          decision,
          signal,
        );
        // Only recorded once the server has accepted the decision.
        setEntries((current) => [
          ...current,
          {
            type: "notice",
            text: `Você ${decision === "approve" ? "aprovou" : "rejeitou"} a proposta de escalonamento do ${proposal.chamadoId}.`,
          },
        ]);
        return events;
      });
    },
    [consume, proposal, sessionId, assistantId],
  );

  return { entries, proposal, status, banner, send, decide };
}
