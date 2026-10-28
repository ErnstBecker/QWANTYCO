import { beforeEach, describe, expect, it } from "vitest";
import { CHAMADOS_SEED } from "./data";
import {
  consultarChamado,
  listarChamados,
  registrarEscalonamento,
  type TicketDeps,
} from "./operations";
import { chamadoSchema } from "./schemas";
import { createEscalationStore, createTicketRepository } from "./store";

const FIXED_NOW = new Date("2026-10-28T12:00:00.000Z");

let deps: TicketDeps;

beforeEach(() => {
  deps = {
    tickets: createTicketRepository(),
    escalations: createEscalationStore(),
    now: () => FIXED_NOW,
  };
});

const escalation = {
  chamadoId: "CH-101",
  resumo: "Erro 500 no login do portal para a filial Norte",
  justificativa: "Impacto alto e sem solução há 7 dias",
};

describe("mock data", () => {
  it("is valid and contains the required tickets", () => {
    for (const chamado of CHAMADOS_SEED) {
      expect(chamadoSchema.safeParse(chamado).success).toBe(true);
    }
    const situacao = Object.fromEntries(
      CHAMADOS_SEED.map((c) => [c.id, c.situacao]),
    );
    expect(situacao).toMatchObject({
      "CH-101": "aberto",
      "CH-102": "resolvido",
      "CH-103": "aberto",
    });
  });
});

describe("listarChamados", () => {
  it("filters open tickets exactly", async () => {
    const result = await listarChamados(deps, { situacao: "aberto" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.chamados.map((c) => c.id)).toEqual(["CH-101", "CH-103"]);
    expect(result.data.total).toBe(2);
  });

  it("lists everything without a filter", async () => {
    const result = await listarChamados(deps, {});
    expect(result.ok && result.data.total).toBe(CHAMADOS_SEED.length);
  });

  it.each([
    { situacao: "pendente" },
    { situacao: "aberto", extra: true },
    "aberto",
  ])("rejects invalid input %j", async (input) => {
    const result = await listarChamados(deps, input);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  });
});

describe("consultarChamado", () => {
  it("returns the ticket", async () => {
    const result = await consultarChamado(deps, { id: "CH-102" });
    expect(result.ok && result.data.chamado.situacao).toBe("resolvido");
  });

  it("normalizes the identifier", async () => {
    const result = await consultarChamado(deps, { id: " ch-101 " });
    expect(result.ok && result.data.chamado.id).toBe("CH-101");
  });

  it("reports unknown tickets", async () => {
    const result = await consultarChamado(deps, { id: "CH-999" });
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("rejects malformed identifiers", async () => {
    const result = await consultarChamado(deps, { id: "101" });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  });
});

describe("registrarEscalonamento", () => {
  it("registers an open ticket", async () => {
    const result = await registrarEscalonamento(deps, escalation, "proposal-1");
    expect(result).toMatchObject({
      ok: true,
      data: {
        alreadyProcessed: false,
        escalonamento: {
          id: "ESC-0001",
          chamadoId: "CH-101",
          registradoEm: FIXED_NOW.toISOString(),
        },
      },
    });
    expect(await deps.escalations.list()).toHaveLength(1);
  });

  it("refuses resolved tickets", async () => {
    const result = await registrarEscalonamento(
      deps,
      { ...escalation, chamadoId: "CH-102" },
      "proposal-1",
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "NOT_ESCALATABLE" },
    });
    expect(await deps.escalations.list()).toHaveLength(0);
  });

  it("refuses unknown tickets", async () => {
    const result = await registrarEscalonamento(
      deps,
      { ...escalation, chamadoId: "CH-999" },
      "proposal-1",
    );
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await deps.escalations.list()).toHaveLength(0);
  });

  it("does not duplicate a repeated approval", async () => {
    const first = await registrarEscalonamento(deps, escalation, "proposal-1");
    const second = await registrarEscalonamento(deps, escalation, "proposal-1");
    expect(second).toMatchObject({
      ok: true,
      data: { alreadyProcessed: true },
    });
    expect(first.ok && second.ok && second.data.escalonamento).toEqual(
      first.ok && first.data.escalonamento,
    );
    expect(await deps.escalations.list()).toHaveLength(1);
  });

  it("does not duplicate concurrent approvals", async () => {
    const results = await Promise.all([
      registrarEscalonamento(deps, escalation, "proposal-1"),
      registrarEscalonamento(deps, escalation, "proposal-1"),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await deps.escalations.list()).toHaveLength(1);
  });

  it("rejects reusing an approval for another operation", async () => {
    await registrarEscalonamento(deps, escalation, "proposal-1");
    const result = await registrarEscalonamento(
      deps,
      { ...escalation, chamadoId: "CH-103" },
      "proposal-1",
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });
    expect(await deps.escalations.list()).toHaveLength(1);
  });

  it("rejects empty summary or justification", async () => {
    const result = await registrarEscalonamento(
      deps,
      { ...escalation, resumo: "  " },
      "proposal-1",
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  });
});
