import { readSSE } from "./sse-client";
import type {
  ApiError,
  AssistantId,
  SessionView,
  StreamEvent,
  TurnError,
} from "./stream-events";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly error: TurnError,
  ) {
    super(error.message);
    this.name = "ApiRequestError";
  }
}

async function failure(response: Response): Promise<ApiRequestError> {
  try {
    const body = (await response.json()) as ApiError;
    return new ApiRequestError(response.status, body.error);
  } catch {
    return new ApiRequestError(response.status, {
      code: "HTTP_ERROR",
      message: `Falha na requisição (${response.status})`,
    });
  }
}

async function postStream(
  url: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<AsyncGenerator<StreamEvent>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) throw await failure(response);
  return readSSE<StreamEvent>(response.body);
}

const sessionUrl = (sessionId: string, assistantId: AssistantId) =>
  `/api/sessions/${sessionId}?assistant=${assistantId}`;

export const api = {
  sendMessage: (
    sessionId: string,
    assistantId: AssistantId,
    message: string,
    signal?: AbortSignal,
  ) => postStream("/api/chat", { sessionId, assistantId, message }, signal),

  decide: (
    sessionId: string,
    assistantId: AssistantId,
    proposalId: string,
    decision: "approve" | "reject",
    signal?: AbortSignal,
  ) =>
    postStream(
      "/api/approval",
      { sessionId, assistantId, proposalId, decision },
      signal,
    ),

  async getSession(
    sessionId: string,
    assistantId: AssistantId,
  ): Promise<SessionView> {
    const response = await fetch(sessionUrl(sessionId, assistantId), {
      cache: "no-store",
    });
    if (!response.ok) throw await failure(response);
    return (await response.json()) as SessionView;
  },

  async deleteSession(
    sessionId: string,
    assistantId: AssistantId,
  ): Promise<void> {
    const response = await fetch(sessionUrl(sessionId, assistantId), {
      method: "DELETE",
    });
    if (!response.ok) throw await failure(response);
  },
};
