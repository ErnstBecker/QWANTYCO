import { MemorySaver } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { Outcome, StreamEvent } from "@/lib/stream-events";
import { buildAgentGraph } from "../agent/graph";
import { createSupportService } from "../agent/support-service";
import {
  ScriptedChatModel,
  reply,
  toolCall,
  type ScriptStep,
} from "../testing/scripted-model";
import { createEscalationStore, createTicketRepository } from "../mocks/stores";
import {
  handleApproval,
  handleChat,
  handleDeleteSession,
  handleGetSession,
  withRuntime,
} from "./handlers";

function setup(steps: ScriptStep[]) {
  const deps = {
    tickets: createTicketRepository(),
    escalations: createEscalationStore(),
  };
  const graph = buildAgentGraph({
    model: new ScriptedChatModel(steps),
    deps,
    checkpointer: new MemorySaver(),
  });
  return {
    deps,
    service: createSupportService(graph, deps),
    sessionId: randomUUID(),
  };
}

const post = (body: unknown, signal?: AbortSignal) =>
  new Request("http://test/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal,
  });

async function readEvents(response: Response): Promise<StreamEvent[]> {
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => JSON.parse(block.slice("data: ".length)) as StreamEvent);
}

const outcomeOf = (events: StreamEvent[]): Outcome => {
  const done = events.at(-1);
  if (done?.type !== "done") throw new Error("stream did not finish with done");
  return done.outcome;
};

const escalationSteps: ScriptStep[] = [
  toolCall("consultar_chamado", { id: "CH-101" }, "call-1"),
  toolCall(
    "propor_escalonamento",
    {
      chamadoId: "CH-101",
      resumo: "Erro 500 no login",
      justificativa: "Prioridade alta",
    },
    "call-2",
  ),
];

describe("POST /api/chat", () => {
  it("streams tool activity, tokens and the final outcome", async () => {
    const ctx = setup([
      toolCall("listar_chamados", { situacao: "aberto" }, "call-1"),
      reply("Abertos: CH-101, CH-103"),
    ]);

    const events = await readEvents(
      await handleChat(
        post({ sessionId: ctx.sessionId, message: "Liste os abertos" }),
        ctx.service,
      ),
    );

    expect(events).toContainEqual({
      type: "tool_call",
      id: "call-1",
      name: "listar_chamados",
      args: { situacao: "aberto" },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        id: "call-1",
        status: "success",
        attempts: 1,
      }),
    );
    expect(events).toContainEqual({ type: "step", node: "executor" });
    expect(events).toContainEqual({
      type: "token",
      text: "Abertos: CH-101, CH-103",
    });
    expect(outcomeOf(events)).toEqual({
      status: "completed",
      reply: "Abertos: CH-101, CH-103",
    });
  });

  it.each([
    ["invalid JSON", "{nope"],
    ["invalid session", { sessionId: "abc", message: "oi" }],
    ["empty message", { sessionId: randomUUID(), message: "   " }],
  ])("rejects %s with 400", async (_label, body) => {
    const ctx = setup([]);
    const response = await handleChat(post(body), ctx.service);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
  });

  it("returns 409 while a decision is pending", async () => {
    const ctx = setup(escalationSteps);
    await readEvents(
      await handleChat(
        post({ sessionId: ctx.sessionId, message: "Escalone o CH-101" }),
        ctx.service,
      ),
    );

    const response = await handleChat(
      post({ sessionId: ctx.sessionId, message: "Olá" }),
      ctx.service,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "APPROVAL_PENDING" },
    });
  });

  it("serializes concurrent requests of the same session", async () => {
    const ctx = setup([
      async () => {
        await sleep(30);
        return reply("primeira");
      },
      reply("segunda"),
    ]);

    const [first, second] = await Promise.all([
      handleChat(
        post({ sessionId: ctx.sessionId, message: "1" }),
        ctx.service,
      ).then(readEvents),
      handleChat(
        post({ sessionId: ctx.sessionId, message: "2" }),
        ctx.service,
      ).then(readEvents),
    ]);

    expect(outcomeOf(first)).toMatchObject({ reply: "primeira" });
    expect(outcomeOf(second)).toMatchObject({ reply: "segunda" });
    const session = await (
      await handleGetSession(ctx.sessionId, ctx.service)
    ).json();
    expect(session.entries.map((e: { text: string }) => e.text)).toEqual([
      "1",
      "primeira",
      "2",
      "segunda",
    ]);
  });

  it("keeps the session usable after the client disconnects", async () => {
    const ctx = setup([
      async () => {
        await sleep(200);
        return reply("tarde");
      },
      reply("de volta"),
    ]);
    const controller = new AbortController();

    const pending = handleChat(
      post({ sessionId: ctx.sessionId, message: "1" }, controller.signal),
      ctx.service,
    ).then(readEvents);
    await sleep(20);
    controller.abort();
    await pending;

    const next = await readEvents(
      await handleChat(
        post({ sessionId: ctx.sessionId, message: "2" }),
        ctx.service,
      ),
    );
    expect(outcomeOf(next)).toMatchObject({
      status: "completed",
      reply: "de volta",
    });
  });
});

describe("POST /api/approval", () => {
  async function propose(ctx: ReturnType<typeof setup>) {
    const events = await readEvents(
      await handleChat(
        post({ sessionId: ctx.sessionId, message: "Escalone o CH-101" }),
        ctx.service,
      ),
    );
    const outcome = outcomeOf(events);
    if (outcome.status !== "awaiting_approval")
      throw new Error("expected a proposal");
    return outcome.proposal;
  }

  it("approves the proposal shown and replays a repeated approval", async () => {
    const ctx = setup(escalationSteps);
    const proposal = await propose(ctx);
    const body = {
      sessionId: ctx.sessionId,
      proposalId: proposal.id,
      decision: "approve",
    };

    const first = outcomeOf(
      await readEvents(await handleApproval(post(body), ctx.service)),
    );
    const again = outcomeOf(
      await readEvents(await handleApproval(post(body), ctx.service)),
    );

    expect(first).toEqual({
      status: "completed",
      reply: "Escalonamento ESC-0001 registrado para o CH-101.",
    });
    expect(again).toMatchObject({
      status: "already_processed",
      resolution: "approved",
      escalonamento: { id: "ESC-0001" },
    });
    expect(await ctx.deps.escalations.list()).toHaveLength(1);
  });

  it("rejects without writing", async () => {
    const ctx = setup(escalationSteps);
    const proposal = await propose(ctx);

    const outcome = outcomeOf(
      await readEvents(
        await handleApproval(
          post({
            sessionId: ctx.sessionId,
            proposalId: proposal.id,
            decision: "reject",
          }),
          ctx.service,
        ),
      ),
    );

    expect(outcome).toMatchObject({
      status: "completed",
      reply: expect.stringMatching(/rejeitado/),
    });
    expect(await ctx.deps.escalations.list()).toHaveLength(0);
  });

  it("maps decision errors to HTTP status codes", async () => {
    const ctx = setup(escalationSteps);

    const none = await handleApproval(
      post({
        sessionId: ctx.sessionId,
        proposalId: randomUUID(),
        decision: "approve",
      }),
      ctx.service,
    );
    expect(none.status).toBe(404);

    await propose(ctx);
    const mismatch = await handleApproval(
      post({
        sessionId: ctx.sessionId,
        proposalId: randomUUID(),
        decision: "approve",
      }),
      ctx.service,
    );
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({
      error: { code: "PROPOSAL_MISMATCH" },
    });

    const invalid = await handleApproval(
      post({ sessionId: ctx.sessionId, proposalId: "x", decision: "maybe" }),
      ctx.service,
    );
    expect(invalid.status).toBe(400);
    expect(await ctx.deps.escalations.list()).toHaveLength(0);
  });
});

describe("GET /api/sessions/:id", () => {
  it("returns history with tool activity and the pending proposal", async () => {
    const ctx = setup(escalationSteps);
    await readEvents(
      await handleChat(
        post({ sessionId: ctx.sessionId, message: "Escalone o CH-101" }),
        ctx.service,
      ),
    );

    const session = await (
      await handleGetSession(ctx.sessionId, ctx.service)
    ).json();

    expect(session).toMatchObject({
      sessionId: ctx.sessionId,
      entries: [
        { type: "user", text: "Escalone o CH-101" },
        {
          type: "activity",
          items: [
            { kind: "call", name: "consultar_chamado", args: { id: "CH-101" } },
            { kind: "result", name: "consultar_chamado", status: "success" },
            { kind: "call", name: "propor_escalonamento" },
          ],
        },
      ],
      proposal: { chamadoId: "CH-101", resumo: "Erro 500 no login" },
    });
  });

  it("returns an empty view for a new session and 400 for an invalid id", async () => {
    const ctx = setup([]);
    expect(
      await (await handleGetSession(ctx.sessionId, ctx.service)).json(),
    ).toEqual({
      sessionId: ctx.sessionId,
      entries: [],
      proposal: null,
    });
    expect((await handleGetSession("nope", ctx.service)).status).toBe(400);
  });
});

describe("DELETE /api/sessions/:id", () => {
  it("removes history and pending proposal, keeping registered escalations", async () => {
    const ctx = setup([...escalationSteps, ...escalationSteps]);
    const escalate = async (sessionId: string) => {
      await readEvents(
        await handleChat(
          post({ sessionId, message: "Escalone o CH-101" }),
          ctx.service,
        ),
      );
      return (await (await handleGetSession(sessionId, ctx.service)).json())
        .proposal.id as string;
    };
    const approve = (sessionId: string, proposalId: string) =>
      handleApproval(
        post({ sessionId, proposalId, decision: "approve" }),
        ctx.service,
      );

    // Session A: approved and registered.
    const approved = await escalate(ctx.sessionId);
    await readEvents(await approve(ctx.sessionId, approved));
    // Session B: proposal still pending.
    const other = randomUUID();
    const pending = await escalate(other);

    for (const id of [ctx.sessionId, other]) {
      expect((await handleDeleteSession(id, ctx.service)).status).toBe(204);
      expect(await (await handleGetSession(id, ctx.service)).json()).toEqual({
        sessionId: id,
        entries: [],
        proposal: null,
      });
    }
    expect(await ctx.deps.escalations.list()).toHaveLength(1);
    // The deleted proposal can no longer be approved.
    expect((await approve(other, pending)).status).toBe(404);
    expect(await ctx.deps.escalations.list()).toHaveLength(1);
  });

  it("answers 400 for an invalid id", async () => {
    const ctx = setup([]);
    expect((await handleDeleteSession("nope", ctx.service)).status).toBe(400);
  });
});

describe("runtime configuration", () => {
  it("answers 503 without leaking secrets when the runtime cannot start", async () => {
    const secret = "sk-should-not-leak";
    const response = await withRuntime(
      () => {
        throw new Error("Invalid model configuration (model: required)");
      },
      async () => new Response("unreachable"),
    );

    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain("CONFIG_ERROR");
    expect(body).not.toContain(secret);
  });
});
