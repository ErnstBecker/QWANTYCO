import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOllama } from "@langchain/ollama";
import { ChatOpenAI } from "@langchain/openai";
import type { Limits, ModelConfig } from "../config/env";

type ModelLimits = Pick<Limits, "modelTimeoutMs" | "modelMaxRetries">;

/** The only place that knows about concrete providers; the graph sees a BaseChatModel. */
export function createChatModel(
  config: ModelConfig,
  limits: ModelLimits,
): BaseChatModel {
  const common = { temperature: 0, maxRetries: limits.modelMaxRetries };

  switch (config.provider) {
    case "ollama":
      return new ChatOllama({
        ...common,
        model: config.model,
        baseUrl: config.baseUrl,
      });
    case "openai":
      return new ChatOpenAI({
        ...common,
        model: config.model,
        apiKey: config.apiKey,
        timeout: limits.modelTimeoutMs,
      });
    case "anthropic":
      return new ChatAnthropic({
        ...common,
        model: config.model,
        apiKey: config.apiKey,
        clientOptions: { timeout: limits.modelTimeoutMs },
      });
  }
}
