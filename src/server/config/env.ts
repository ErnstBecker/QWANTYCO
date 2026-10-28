import { z } from "zod";

const positiveInt = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

export const modelConfigSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("ollama"),
    model: z.string().min(1),
    baseUrl: z.url().default("http://localhost:11434"),
  }),
  z.object({
    provider: z.literal("openai"),
    model: z.string().min(1),
    apiKey: z.string().min(1, "OPENAI_API_KEY is required"),
  }),
  z.object({
    provider: z.literal("anthropic"),
    model: z.string().min(1),
    apiKey: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  }),
]);
export type ModelConfig = z.infer<typeof modelConfigSchema>;

export const limitsSchema = z.object({
  toolTimeoutMs: positiveInt(2000),
  toolMaxAttempts: positiveInt(3),
  toolBackoffMs: positiveInt(200),
  modelTimeoutMs: positiveInt(60000),
  modelMaxRetries: z.coerce.number().int().nonnegative().default(1),
  activeBudgetMs: positiveInt(120000),
  recursionLimit: positiveInt(15),
});
export type Limits = z.infer<typeof limitsSchema>;

type Env = Record<string, string | undefined>;

const blankToUndefined = (value: string | undefined) =>
  value === undefined || value.trim() === "" ? undefined : value;

/** Reads the model configuration. Error messages never include secret values. */
export function loadModelConfig(env: Env = process.env): ModelConfig {
  const provider = blankToUndefined(env.MODEL_PROVIDER);
  if (!provider) {
    throw new Error("MODEL_PROVIDER is not set (ollama | openai | anthropic)");
  }
  const apiKey =
    provider === "openai"
      ? env.OPENAI_API_KEY
      : provider === "anthropic"
        ? env.ANTHROPIC_API_KEY
        : undefined;

  const parsed = modelConfigSchema.safeParse({
    provider,
    model: blankToUndefined(env.MODEL_NAME),
    baseUrl: blankToUndefined(env.OLLAMA_BASE_URL),
    apiKey: blankToUndefined(apiKey) ?? "",
  });
  if (!parsed.success) {
    const fields = parsed.error.issues.map(
      (i) => `${i.path.join(".")}: ${i.message}`,
    );
    throw new Error(`Invalid model configuration (${fields.join("; ")})`);
  }
  return parsed.data;
}

export function loadLimits(env: Env = process.env): Limits {
  return limitsSchema.parse({
    toolTimeoutMs: blankToUndefined(env.TOOL_TIMEOUT_MS),
    toolMaxAttempts: blankToUndefined(env.TOOL_MAX_ATTEMPTS),
    toolBackoffMs: blankToUndefined(env.TOOL_BACKOFF_MS),
    modelTimeoutMs: blankToUndefined(env.MODEL_TIMEOUT_MS),
    modelMaxRetries: blankToUndefined(env.MODEL_MAX_RETRIES),
    activeBudgetMs: blankToUndefined(env.ACTIVE_BUDGET_MS),
    recursionLimit: blankToUndefined(env.GRAPH_RECURSION_LIMIT),
  });
}
