import { describe, expect, it } from "vitest";
import { loadLimits, loadModelConfig } from "./env";

describe("loadModelConfig", () => {
  it("defaults the Ollama base URL", () => {
    expect(
      loadModelConfig({
        MODEL_PROVIDER: "ollama",
        MODEL_NAME: "qwen2.5:7b-instruct",
      }),
    ).toEqual({
      provider: "ollama",
      model: "qwen2.5:7b-instruct",
      baseUrl: "http://localhost:11434",
    });
  });

  it("requires a provider", () => {
    expect(() => loadModelConfig({ MODEL_PROVIDER: "" })).toThrow(
      /MODEL_PROVIDER/,
    );
  });

  it("requires the key of the chosen provider", () => {
    expect(() =>
      loadModelConfig({
        MODEL_PROVIDER: "anthropic",
        MODEL_NAME: "claude-haiku-5-5",
      }),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("never echoes secrets in errors", () => {
    const secret = "sk-test-should-not-leak";
    let message = "";
    try {
      loadModelConfig({
        MODEL_PROVIDER: "openai",
        MODEL_NAME: "",
        OPENAI_API_KEY: secret,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/model/);
    expect(message).not.toContain(secret);
  });
});

describe("loadLimits", () => {
  it("uses defaults for blank values and parses overrides", () => {
    expect(
      loadLimits({ TOOL_TIMEOUT_MS: "", GRAPH_RECURSION_LIMIT: "8" }),
    ).toMatchObject({
      toolTimeoutMs: 2000,
      recursionLimit: 8,
    });
  });

  it("rejects invalid numbers", () => {
    expect(() => loadLimits({ TOOL_MAX_ATTEMPTS: "0" })).toThrow();
  });
});
