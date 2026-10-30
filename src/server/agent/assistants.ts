import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { z } from "zod";
import { DOCUMENTOS_VIAGEM } from "../mocks/viagens";
import { createTravelRetriever } from "../travel/rag";
import { SUPPORT_SYSTEM_PROMPT, TRAVEL_SYSTEM_PROMPT } from "./prompt";
import { READ_TOOLS, createCallRagTool, type AgentTool } from "./tools";

export const ASSISTANT_IDS = ["support", "travel"] as const;
export const assistantIdSchema = z.enum(ASSISTANT_IDS);
export type AssistantId = z.infer<typeof assistantIdSchema>;
export const DEFAULT_ASSISTANT: AssistantId = "support";

/**
 * One configuration of the shared graph: what the model is told, which tools
 * it sees and which the executor accepts. Nothing else differs per assistant.
 */
export type Assistant = {
  id: AssistantId;
  systemPrompt: string;
  /** Allowlist for this assistant; any other tool call is refused. */
  tools: readonly AgentTool[];
  /** Whether the escalation proposal (human approval) is available. */
  escalation: boolean;
};

export type Assistants = Readonly<Record<AssistantId, Assistant>>;

export const ASSISTANTS: Assistants = {
  support: {
    id: "support",
    systemPrompt: SUPPORT_SYSTEM_PROMPT,
    tools: READ_TOOLS,
    escalation: true,
  },
  travel: {
    id: "travel",
    systemPrompt: TRAVEL_SYSTEM_PROMPT,
    tools: [createCallRagTool(createTravelRetriever(DOCUMENTOS_VIAGEM))],
    escalation: false,
  },
};

/** Same assistants with their tools transformed, e.g. to inject faults. */
export function mapAssistantTools(
  assistants: Assistants,
  transform: (tools: readonly AgentTool[]) => readonly AgentTool[],
): Assistants {
  return Object.fromEntries(
    Object.entries(assistants).map(([id, assistant]) => [
      id,
      { ...assistant, tools: transform(assistant.tools) },
    ]),
  ) as Assistants;
}

/** Assistant selected for a run through `configurable.assistant_id`. */
export function assistantFor(
  assistants: Assistants,
  config: LangGraphRunnableConfig | undefined,
): Assistant {
  const id = assistantIdSchema.parse(
    config?.configurable?.assistant_id ?? DEFAULT_ASSISTANT,
  );
  return assistants[id];
}

/** Checkpoint thread of a conversation: history never crosses assistants. */
export const threadIdFor = (assistantId: AssistantId, sessionId: string) =>
  `${assistantId}:${sessionId}`;
