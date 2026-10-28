export type ErrorCode =
  "INVALID_INPUT" | "NOT_FOUND" | "NOT_ESCALATABLE" | "IDEMPOTENCY_CONFLICT";

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
