/**
 * The evaluators themselves, offline: a grounded run passes, and runs that
 * skip the tool, invent a ticket or escalate a resolved one fail.
 */
import { describe, expect, it } from "vitest";
import { ScriptedChatModel, reply, toolCall } from "../testing/scripted-model";
import { EXAMPLES, type EvalExample } from "./dataset";
import { evaluateRun, ticketIds } from "./evaluators";
import { SABOTAGED_TARGETS, agentTarget } from "./targets";

const [listarAbertos, escalonarResolvido] = EXAMPLES as [
  EvalExample,
  EvalExample,
];

function scores(
  example: EvalExample,
  outputs: Awaited<ReturnType<ReturnType<typeof agentTarget>>>,
) {
  const results = evaluateRun({ outputs, referenceOutputs: example.outputs });
  return Object.fromEntries(results.map((r) => [r.key, r.score]));
}

const allPass = (s: Record<string, number>) =>
  Object.values(s).every((v) => v === 1);

describe("evaluators", () => {
  it("extracts ticket ids from text", () => {
    expect(ticketIds("ch-103, CH-101 e CH-101")).toEqual(["CH-101", "CH-103"]);
  });

  it("passes a grounded listing through the real graph", async () => {
    const target = agentTarget(
      new ScriptedChatModel([
        toolCall("listar_chamados", { situacao: "aberto" }),
        reply("Abertos: CH-101 e CH-103."),
      ]),
    );
    const s = scores(listarAbertos, await target(listarAbertos.inputs));
    expect(allPass(s)).toBe(true);
  });

  it("fails an answer that skips the tool", async () => {
    const outputs = await SABOTAGED_TARGETS["skips-tool"]!(
      listarAbertos.inputs,
    );
    const s = scores(listarAbertos, outputs);
    expect(s.tool_executed).toBe(0);
    expect(s.reply_matches_tool_result).toBe(0);
    // The text alone would look right: that is why it is not enough.
    expect(s.reply_matches_reference).toBe(1);
  });

  it("fails an answer that invents a ticket", async () => {
    const outputs = await SABOTAGED_TARGETS["invents-ticket"]!(
      listarAbertos.inputs,
    );
    const s = scores(listarAbertos, outputs);
    expect(s.tool_executed).toBe(1);
    expect(s.reply_matches_tool_result).toBe(0);
    expect(s.reply_matches_reference).toBe(0);
  });

  it("fails a listing with the wrong filter or an omission", async () => {
    const target = agentTarget(
      new ScriptedChatModel([
        toolCall("listar_chamados", {}),
        reply("Abertos: CH-101."),
      ]),
    );
    const s = scores(listarAbertos, await target(listarAbertos.inputs));
    expect(s.tool_executed).toBe(0);
    expect(s.reply_matches_reference).toBe(0);
  });

  it("passes a resolved ticket that is consulted and not escalated", async () => {
    const target = agentTarget(
      new ScriptedChatModel([
        toolCall("consultar_chamado", { id: "CH-102" }),
        reply("O CH-102 está resolvido e não pode ser escalonado."),
      ]),
    );
    const s = scores(
      escalonarResolvido,
      await target(escalonarResolvido.inputs),
    );
    expect(allPass(s)).toBe(true);
  });

  it("fails when a resolved ticket reaches a proposal attempt", async () => {
    const target = agentTarget(
      new ScriptedChatModel([
        toolCall("consultar_chamado", { id: "CH-102" }),
        toolCall("propor_escalonamento", {
          chamadoId: "CH-102",
          resumo: "Resumo",
          justificativa: "Justificativa",
        }),
        reply("O CH-102 está resolvido."),
      ]),
    );
    const s = scores(
      escalonarResolvido,
      await target(escalonarResolvido.inputs),
    );
    expect(s.no_escalation).toBe(0);
  });
});
