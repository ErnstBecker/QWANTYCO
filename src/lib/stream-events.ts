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

export type HistoryMessage = { role: "user" | "assistant"; text: string };

export type SessionView = {
  sessionId: string;
  messages: HistoryMessage[];
  proposal: ProposalView | null;
};

export type ApiError = { error: TurnError };
