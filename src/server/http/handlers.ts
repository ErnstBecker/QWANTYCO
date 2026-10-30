import { traceable } from "langsmith/traceable";
import type { ApiError, StreamEvent } from "@/lib/stream-events";
import { DEFAULT_ASSISTANT } from "../agent/assistants";
import {
  APP_TAG,
  type DecisionOutcome,
  type SupportService,
} from "../agent/support-service";
import type { DomainError, ErrorCode } from "../shared/result";

const STATUS: Partial<Record<ErrorCode, number>> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  NO_PENDING_PROPOSAL: 404,
  APPROVAL_PENDING: 409,
  PROPOSAL_MISMATCH: 409,
  PROPOSAL_ALREADY_DECIDED: 409,
};

export function errorResponse(
  error: DomainError | ApiError["error"],
  status?: number,
) {
  const body: ApiError = {
    error: { code: error.code, message: error.message },
  };
  return Response.json(body, {
    status: status ?? STATUS[error.code as ErrorCode] ?? 500,
  });
}

/** Server-Sent Events response; the release callback runs when the stream ends. */
export function sseResponse(
  events: AsyncIterable<StreamEvent>,
  release: () => void,
  runId?: string,
) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of events) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        }
      } catch {
        const failure: StreamEvent = {
          type: "done",
          outcome: {
            status: "failed",
            reply:
              "Ocorreu um erro inesperado. Nenhuma operação adicional foi realizada.",
            error: { code: "INTERNAL_ERROR", message: "Falha no stream" },
          },
        };
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(failure)}\n\n`),
        );
      } finally {
        release();
        controller.close();
      }
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Root run of this request in LangSmith, for correlating logs and traces.
      ...(runId && { "X-Run-Id": runId }),
    },
  });
}

async function readJson(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object"
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const invalidBody = () =>
  errorResponse({ code: "INVALID_INPUT", message: "Corpo JSON inválido" });

export async function handleChat(request: Request, service: SupportService) {
  const body = await readJson(request);
  if (!body) return invalidBody();
  const sessionId = String(body.sessionId ?? "");

  // The lock covers validation and the whole stream, so requests in the same
  // session cannot interleave (e.g. two tabs).
  const release = await service.lock.acquire(sessionId);
  const prepared = await service
    .prepareMessage(sessionId, body.message, body.assistantId)
    .catch(() => null);
  if (!prepared?.ok) {
    release();
    return prepared ? errorResponse(prepared.error) : invalidBody();
  }
  return sseResponse(
    service.stream(prepared.data, request.signal),
    release,
    prepared.data.config.runId,
  );
}

export async function handleApproval(
  request: Request,
  service: SupportService,
) {
  const body = await readJson(request);
  if (!body) return invalidBody();
  const sessionId = String(body.sessionId ?? "");

  const release = await service.lock.acquire(sessionId);
  const prepared = await service
    .prepareDecision(
      sessionId,
      { proposalId: body.proposalId, decision: body.decision },
      body.assistantId,
    )
    .catch(() => null);
  if (!prepared?.ok) {
    release();
    return prepared ? errorResponse(prepared.error) : invalidBody();
  }
  if (prepared.data.kind === "replay") {
    // A repeated decision does not run the graph, but is still traced.
    const outcome = await traceable(
      async (replay: {
        proposalId: unknown;
        decision: unknown;
        outcome: DecisionOutcome;
      }) => replay.outcome,
      {
        name: "decision",
        run_type: "chain",
        tags: [APP_TAG, "decision", "replay"],
        metadata: {
          session_id: sessionId,
          assistant: body.assistantId ?? DEFAULT_ASSISTANT,
        },
      },
    )({
      proposalId: body.proposalId,
      decision: body.decision,
      outcome: prepared.data.outcome,
    });
    return sseResponse(
      (async function* () {
        yield { type: "done", outcome } satisfies StreamEvent;
      })(),
      release,
    );
  }
  return sseResponse(
    service.stream(prepared.data, request.signal),
    release,
    prepared.data.config.runId,
  );
}

/** The assistant of a session comes from the `assistant` query parameter. */
export const assistantParam = (request: Request) =>
  new URL(request.url).searchParams.get("assistant") ?? undefined;

export async function handleGetSession(
  sessionId: string,
  service: SupportService,
  assistantId?: string,
) {
  const result = await service.getSession(sessionId, assistantId);
  return result.ok ? Response.json(result.data) : errorResponse(result.error);
}

export async function handleDeleteSession(
  sessionId: string,
  service: SupportService,
  assistantId?: string,
) {
  const result = await service.deleteSession(sessionId, assistantId);
  return result.ok
    ? new Response(null, { status: 204 })
    : errorResponse(result.error);
}

/** Configuration problems (e.g. MODEL_PROVIDER unset) become a 503 without details. */
export async function withRuntime(
  load: () => { service: SupportService },
  handler: (service: SupportService) => Promise<Response>,
) {
  let service: SupportService;
  try {
    service = load().service;
  } catch (error) {
    return errorResponse(
      {
        code: "CONFIG_ERROR",
        message:
          error instanceof Error ? error.message : "Configuração inválida",
      },
      503,
    );
  }
  return handler(service);
}
