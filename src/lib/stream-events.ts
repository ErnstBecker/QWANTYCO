// Shared between the API (server) and the UI (client): events sent over SSE.

export type ProposalView = {
  id: string;
  chamadoId: string;
  resumo: string;
  justificativa: string;
  chamado: { id: string; titulo: string; situacao: string; prioridade: string };
};

export type TurnError = { code: string; message: string };

export type Outcome =
  | { status: "awaiting_approval"; proposal: ProposalView }
  | { status: "completed"; reply: string }
  | { status: "failed"; reply: string; error: TurnError }
  | {
      status: "already_processed";
      resolution: "approved";
      escalonamento: { id: string };
    }
  | { status: "already_processed"; resolution: "rejected" };

export type StreamEvent =
  | { type: "step"; node: string }
  | { type: "token"; text: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      id: string;
      name: string;
      status: "success" | "error";
      attempts?: number;
      error?: TurnError;
    }
  | { type: "done"; outcome: Outcome };

/** A tool call the model emitted, or what the executor returned for it. */
export type ActivityItem =
  | { kind: "call"; id: string; name: string; args: Record<string, unknown> }
  | {
      kind: "result";
      id: string;
      name: string;
      status: "success" | "error";
      attempts?: number;
      error?: TurnError;
    };

type ToolEvent = Extract<StreamEvent, { type: "tool_call" | "tool_result" }>;

export function toActivityItem(event: ToolEvent): ActivityItem {
  return event.type === "tool_call"
    ? { kind: "call", id: event.id, name: event.name, args: event.args }
    : {
        kind: "result",
        id: event.id,
        name: event.name,
        status: event.status,
        attempts: event.attempts,
        error: event.error,
      };
}

/** Persisted conversation, in order, as shown after a reload. */
export type HistoryEntry =
  | { type: "user"; text: string }
  | { type: "assistant"; text: string }
  | { type: "activity"; items: ActivityItem[] };

export type SessionView = {
  sessionId: string;
  entries: HistoryEntry[];
  proposal: ProposalView | null;
};

export type ApiError = { error: TurnError };
