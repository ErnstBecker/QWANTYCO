import type { ApiError, StreamEvent } from "@/lib/stream-events";
import type { SupportService } from "../agent/support-service";
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
    .prepareMessage(sessionId, body.message)
    .catch(() => null);
  if (!prepared?.ok) {
    release();
    return prepared ? errorResponse(prepared.error) : invalidBody();
  }
  return sseResponse(service.stream(prepared.data, request.signal), release);
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
    .prepareDecision(sessionId, {
      proposalId: body.proposalId,
      decision: body.decision,
    })
    .catch(() => null);
  if (!prepared?.ok) {
    release();
    return prepared ? errorResponse(prepared.error) : invalidBody();
  }
  if (prepared.data.kind === "replay") {
    const outcome = prepared.data.outcome;
    return sseResponse(
      (async function* () {
        yield { type: "done", outcome } satisfies StreamEvent;
      })(),
      release,
    );
  }
  return sseResponse(service.stream(prepared.data, request.signal), release);
}

export async function handleGetSession(
  sessionId: string,
  service: SupportService,
) {
  const result = await service.getSession(sessionId);
  return result.ok ? Response.json(result.data) : errorResponse(result.error);
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
