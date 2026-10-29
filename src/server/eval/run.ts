/**
 * LangSmith evaluation with a real model (separate from the offline tests).
 *   pnpm eval            dataset sync + experiment with the configured model
 *   pnpm eval:sabotage   experiments with deliberately wrong targets
 */
import { Client, type Example } from "langsmith";
import { evaluate } from "langsmith/evaluation";
import { isDeepStrictEqual } from "node:util";
import { loadLimits, loadModelConfig } from "../config/env";
import { createChatModel } from "../model/factory";
import { DATASET_NAME, EXAMPLES } from "./dataset";
import { EVALUATORS } from "./evaluators";
import { SABOTAGED_TARGETS, agentTarget, type Target } from "./targets";

const client = new Client();

/** Creates the dataset and keeps its examples in sync with EXAMPLES. */
async function syncDataset(): Promise<Example[]> {
  if (!(await client.hasDataset({ datasetName: DATASET_NAME }))) {
    await client.createDataset(DATASET_NAME, {
      description:
        "Aurora: trajetória de ferramentas e respostas fundamentadas",
    });
  }
  const existing: Example[] = [];
  for await (const example of client.listExamples({
    datasetName: DATASET_NAME,
  })) {
    existing.push(example);
  }
  for (const example of EXAMPLES) {
    const found = existing.find(
      (e) => e.inputs.message === example.inputs.message,
    );
    if (!found) {
      await client.createExample({
        dataset_name: DATASET_NAME,
        inputs: example.inputs,
        reference_outputs: example.outputs,
        metadata: example.metadata,
      });
    } else if (!isDeepStrictEqual(found.outputs, example.outputs)) {
      await client.updateExample({
        id: found.id,
        outputs: example.outputs,
        metadata: example.metadata,
      });
    }
  }
  const examples: Example[] = [];
  for await (const example of client.listExamples({
    datasetName: DATASET_NAME,
  })) {
    examples.push(example);
  }
  return examples;
}

async function runExperiment(
  target: Target,
  data: Example[] | string,
  experimentPrefix: string,
  metadata: Record<string, unknown>,
) {
  const results = await evaluate(target, {
    data,
    evaluators: EVALUATORS,
    experimentPrefix,
    metadata,
    maxConcurrency: 1,
    client,
  });
  console.log(`\n${results.experimentName}`);
  let failed = 0;
  for (const row of results.results) {
    const scores = row.evaluationResults.results;
    const passed = scores.every((s) => s.score === 1);
    if (!passed) failed++;
    console.log(
      `  ${passed ? "PASS" : "FAIL"}  ${row.example.metadata?.case ?? row.example.id}`,
    );
    for (const s of scores) {
      console.log(
        `        ${s.score === 1 ? "✓" : "✗"} ${s.key}: ${s.comment}`,
      );
    }
  }
  return failed;
}

async function main() {
  const sabotage = process.argv.includes("--sabotage");
  const examples = await syncDataset();
  console.log(`dataset ${DATASET_NAME}: ${examples.length} exemplos`);

  if (sabotage) {
    // Only the required case: it is what the sabotaged answers try to fake.
    const required = examples.filter(
      (e) => e.metadata?.case === "listar-abertos",
    );
    for (const [name, target] of Object.entries(SABOTAGED_TARGETS)) {
      const failed = await runExperiment(target, required, `sabotage-${name}`, {
        target: name,
      });
      console.log(
        failed
          ? "  -> reprovado, como esperado"
          : "  -> ATENÇÃO: o avaliador aprovou um alvo sabotado",
      );
    }
  } else {
    const config = loadModelConfig();
    const limits = loadLimits();
    const failed = await runExperiment(
      agentTarget(createChatModel(config, limits), limits),
      DATASET_NAME,
      `aurora-${config.provider}-${config.model}`,
      { model_provider: config.provider, model_name: config.model },
    );
    process.exitCode = failed ? 1 : 0;
  }
  await client.awaitPendingTraceBatches();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
