import {
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import {
  ScriptedChatModel,
  reply,
  toolCall,
  type ScriptStep,
} from "../testing/scripted-model";
import { createEscalationStore, createTicketRepository } from "../mocks/stores";
import { buildAgentGraph } from "./graph";

function setup(steps: ScriptStep[]) {
  const model = new ScriptedChatModel(steps);
  const deps = {
    tickets: createTicketRepository(),
    escalations: createEscalationStore(),
  };
  const graph = buildAgentGraph({
    model,
    deps,
    checkpointer: new MemorySaver(),
  });
  const ask = (text: string, threadId = "session-a") =>
    graph.invoke(
      { messages: [new HumanMessage(text)] },
      { configurable: { thread_id: threadId } },
    );
  return { model, graph, ask, deps };
}

const toolMessages = (messages: BaseMessage[]) =>
  messages.filter(ToolMessage.isInstance);
const parse = (message: ToolMessage) => JSON.parse(message.text);

/** Builds the reply from the last tool result, like a model grounded on it. */
const replyWithIds = (messages: BaseMessage[]) => {
  const last = toolMessages(messages).at(-1);
  const ids: string[] = last
    ? parse(last).data.chamados.map((c: { id: string }) => c.id)
    : [];
  return reply(`Chamados abertos: ${ids.join(", ")}`);
};

describe("agent graph", () => {
  it("lists open tickets through the tool and answers from its result", async () => {
    const { ask, model } = setup([
      toolCall("listar_chamados", { situacao: "aberto" }),
      replyWithIds,
    ]);

    const state = await ask("Liste todos os chamados abertos.");

    const [toolResult] = toolMessages(state.messages);
    expect(toolResult?.name).toBe("listar_chamados");
    expect(toolResult?.status).toBe("success");
    expect(
      parse(toolResult!).data.chamados.map((c: { id: string }) => c.id),
    ).toEqual(["CH-101", "CH-103"]);
    expect(state.messages.at(-1)?.text).toBe(
      "Chamados abertos: CH-101, CH-103",
    );
    // The model saw the tool result before answering.
    expect(model.calls[1]?.some(ToolMessage.isInstance)).toBe(true);
  });

  it("binds only the allowed tools to the model", () => {
    const { model } = setup([]);
    const names = model.boundTools.map(
      (tool) => (tool as { function: { name: string } }).function.name,
    );
    expect(names).toEqual([
      "listar_chamados",
      "consultar_chamado",
      "propor_escalonamento",
    ]);
  });

  it("consults a ticket and reports unknown identifiers", async () => {
    const { ask } = setup([
      toolCall("consultar_chamado", { id: "CH-999" }),
      reply("O chamado CH-999 não foi encontrado."),
    ]);

    const state = await ask("Consulte o CH-999");

    const [toolResult] = toolMessages(state.messages);
    expect(toolResult?.status).toBe("error");
    expect(parse(toolResult!)).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });

  it("returns invalid arguments to the model as an error", async () => {
    const { ask } = setup([
      toolCall("listar_chamados", { situacao: "pendente" }),
      reply("Não consegui filtrar por essa situação."),
    ]);

    const state = await ask("Liste os pendentes");

    expect(parse(toolMessages(state.messages)[0]!)).toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
  });

  it("never executes a tool outside the allowlist", async () => {
    const { ask, deps } = setup([
      toolCall("apagar_chamado", { id: "CH-101" }),
      reply("Não posso apagar chamados."),
    ]);

    const state = await ask("Apague o CH-101");

    expect(parse(toolMessages(state.messages)[0]!)).toMatchObject({
      error: { code: "UNKNOWN_TOOL" },
    });
    expect(await deps.escalations.list()).toHaveLength(0);
  });

  it("keeps context within a session and isolates other sessions", async () => {
    const { ask, model } = setup([
      reply("Olá, Ana."),
      reply("Seu nome é Ana."),
      reply("Não sei seu nome."),
    ]);

    await ask("Meu nome é Ana", "session-a");
    const same = await ask("Qual é o meu nome?", "session-a");
    const other = await ask("Qual é o meu nome?", "session-b");

    expect(same.messages).toHaveLength(4);
    expect(other.messages).toHaveLength(2);
    const otherInput = model.calls[2]!.map((m) => m.text).join("\n");
    expect(otherInput).not.toContain("Ana");
  });
});
