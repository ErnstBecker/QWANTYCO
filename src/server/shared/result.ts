import type { z } from "zod";

export type ErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "NOT_ESCALATABLE"
  | "IDEMPOTENCY_CONFLICT"
  | "UNKNOWN_TOOL"
  | "INVALID_OUTPUT"
  | "TOOL_ERROR"
  | "REJECTED"
  | "APPROVAL_PENDING"
  | "NO_PENDING_PROPOSAL"
  | "PROPOSAL_MISMATCH"
  | "PROPOSAL_ALREADY_DECIDED"
  | "TOOL_UNAVAILABLE"
  | "LIMIT_EXCEEDED"
  | "MODEL_ERROR"
  | "INVALID_MODEL_OUTPUT"
  | "INTERNAL_ERROR";

export type DomainError = { code: ErrorCode; message: string };

export type Result<T> =
  { ok: true; data: T } | { ok: false; error: DomainError };

export const ok = <T>(data: T): Result<T> => ({ ok: true, data });

export const fail = <T = never>(
  code: ErrorCode,
  message: string,
): Result<T> => ({
  ok: false,
  error: { code, message },
});

/** Parses a tool input, turning schema issues into a readable INVALID_INPUT. */
export function parseInput<S extends z.ZodType>(
  schema: S,
  input: unknown,
): Result<z.infer<S>> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return ok(parsed.data);
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
    .join("; ");
  return fail("INVALID_INPUT", `Entrada inválida (${detail})`);
}
