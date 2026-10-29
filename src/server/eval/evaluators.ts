import { isDeepStrictEqual } from "node:util";
import type { EvalReference } from "./dataset";
import type { AgentRunOutput, ToolStep } from "./trajectory";

export type EvalResult = { key: string; score: number; comment: string };
export type EvaluatorArgs = {
  outputs: Record<string, unknown>;
  referenceOutputs?: Record<string, unknown>;
};

const TICKET_ID = /\bCH-\d+\b/gi;

export const ticketIds = (text: string) =>
  [...new Set(text.match(TICKET_ID) ?? [])]
    .map((id) => id.toUpperCase())
    .sort();

const sameIds = (a: string[], b: string[]) =>
  isDeepStrictEqual([...a].sort(), [...b].sort());

const result = (key: string, pass: boolean, comment: string): EvalResult => ({
  key,
  score: pass ? 1 : 0,
  comment,
});

const unpack = ({ outputs, referenceOutputs }: EvaluatorArgs) => ({
  run: outputs as AgentRunOutput,
  ref: referenceOutputs as EvalReference,
});

/** The required call with exactly the expected arguments. */
function requiredStep(run: AgentRunOutput, ref: EvalReference) {
  return run.steps.find(
    (step) =>
      step.name === ref.requiredTool.name &&
      isDeepStrictEqual(step.args, ref.requiredTool.args),
  );
}

const describe = (steps: ToolStep[]) =>
  steps.length
    ? steps.map((s) => `${s.name}(${JSON.stringify(s.args)})`).join(", ")
    : "nenhuma ferramenta chamada";

/** The tool was really executed by the executor with the expected arguments. */
export function toolExecuted(args: EvaluatorArgs): EvalResult {
  const { run, ref } = unpack(args);
  const step = requiredStep(run, ref);
  const expected = `${ref.requiredTool.name}(${JSON.stringify(ref.requiredTool.args)})`;
  return result(
    "tool_executed",
    !!step?.executed,
    step?.executed
      ? `${expected} executada`
      : `esperado ${expected}; trajetória: ${describe(run.steps)}`,
  );
}

/** The required call returned success. */
export function toolSucceeded(args: EvaluatorArgs): EvalResult {
  const { run, ref } = unpack(args);
  const step = requiredStep(run, ref);
  return result(
    "tool_succeeded",
    !!step?.executed && step.ok,
    !step?.executed
      ? "ferramenta não executada"
      : step.ok
        ? "retorno com sucesso"
        : `erro ${step.error?.code}: ${step.error?.message}`,
  );
}

/** Ids cited in the reply are exactly the ids the tool returned. */
export function replyMatchesToolResult(args: EvaluatorArgs): EvalResult {
  const { run, ref } = unpack(args);
  const step = requiredStep(run, ref);
  if (!step?.executed || !step.ok) {
    return result(
      "reply_matches_tool_result",
      false,
      "sem retorno de sucesso para comparar",
    );
  }
  const returned = ticketIds(JSON.stringify(step.data));
  const cited = ticketIds(run.reply);
  return result(
    "reply_matches_tool_result",
    sameIds(returned, cited),
    `retorno: [${returned.join(", ")}]; resposta: [${cited.join(", ")}]`,
  );
}

/** Ids cited in the reply are the expected ones: no omissions or extras. */
export function replyMatchesReference(args: EvaluatorArgs): EvalResult {
  const { run, ref } = unpack(args);
  const cited = ticketIds(run.reply);
  return result(
    "reply_matches_reference",
    sameIds(ref.expectedIds, cited),
    `esperado: [${ref.expectedIds.join(", ")}]; resposta: [${cited.join(", ")}]`,
  );
}

/** Nothing was proposed or registered: none of these cases may escalate. */
export function noEscalation(args: EvaluatorArgs): EvalResult {
  const { run } = unpack(args);
  const proposed = run.steps.some((s) => s.name === "propor_escalonamento");
  return result(
    "no_escalation",
    !proposed &&
      run.escalationsRegistered === 0 &&
      run.status !== "awaiting_approval",
    proposed
      ? "propor_escalonamento foi chamada"
      : `status ${run.status}, ${run.escalationsRegistered} registro(s)`,
  );
}

/** The reply states what the case requires (e.g. that the ticket is resolved). */
export function replyMentions(args: EvaluatorArgs): EvalResult {
  const { run, ref } = unpack(args);
  const words = ref.replyMustMention ?? [];
  const missing = words.filter(
    (w) => !run.reply.toLowerCase().includes(w.toLowerCase()),
  );
  return result(
    "reply_mentions",
    missing.length === 0,
    words.length === 0
      ? "nada exigido"
      : missing.length
        ? `faltando: ${missing.join(", ")}`
        : `menciona: ${words.join(", ")}`,
  );
}

export const EVALUATORS = [
  toolExecuted,
  toolSucceeded,
  replyMatchesToolResult,
  replyMatchesReference,
  noEscalation,
  replyMentions,
];

export const evaluateRun = (args: EvaluatorArgs) =>
  EVALUATORS.map((evaluator) => evaluator(args));
