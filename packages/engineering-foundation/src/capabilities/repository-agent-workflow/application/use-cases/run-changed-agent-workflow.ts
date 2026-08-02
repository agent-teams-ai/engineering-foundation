import type {
  AgentWorkflowChangedReport,
  AgentWorkflowInvocation,
  AgentWorkflowStepReport,
  RepositoryChanges,
  ScriptExecutionResult
} from "../model/changed-workflow.js";
import type {
  PackageScriptRunner,
  RepositoryChangesReader
} from "../ports/changed-workflow.js";

const MAX_PATH_ARGUMENTS = 200;
const MAX_PATH_ARGUMENT_BYTES = 24 * 1024;
const MAX_STEP_OUTPUT_CHARS = 128 * 1024;

function pathMatchesExtension(path: string, extension: string): boolean {
  return path.toLowerCase().endsWith(extension.toLowerCase());
}

function pathMatchesTrigger(path: string, trigger: string): boolean {
  return path === trigger || path.startsWith(`${trigger}/`);
}

function exceedsArgumentBudget(paths: readonly string[]): boolean {
  return (
    paths.length > MAX_PATH_ARGUMENTS ||
    paths.reduce((total, path) => total + Buffer.byteLength(path) + 1, 0) >
      MAX_PATH_ARGUMENT_BYTES
  );
}

function output(result: ScriptExecutionResult): string {
  const combined = [result.stdout.trim(), result.stderr.trim()]
    .filter((value) => value.length > 0)
    .join("\n");
  return combined.length <= MAX_STEP_OUTPUT_CHARS
    ? combined
    : combined.slice(combined.length - MAX_STEP_OUTPUT_CHARS);
}

async function executeStep(
  input: AgentWorkflowInvocation,
  runner: PackageScriptRunner,
  id: string,
  script: string,
  paths: readonly string[]
): Promise<AgentWorkflowStepReport> {
  const result = await runner.run({
    consumerRoot: input.consumerRoot,
    script,
    paths,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  return Object.freeze({
    id,
    script,
    paths: Object.freeze([...paths]),
    outcome: result.exitCode === 0 ? "passed" : "violations",
    output: output(result)
  });
}

function shouldRunFastFull(
  input: AgentWorkflowInvocation,
  changes: RepositoryChanges
): boolean {
  return (
    changes.changedPaths.some((path) =>
      input.policy.fullScanPaths.some((trigger) => pathMatchesTrigger(path, trigger))
    ) ||
    changes.deletedPaths.length > 0 ||
    changes.changedPaths.length !== changes.existingPaths.length ||
    exceedsArgumentBudget(changes.existingPaths)
  );
}

async function changedSteps(
  input: AgentWorkflowInvocation,
  changes: RepositoryChanges,
  runner: PackageScriptRunner
): Promise<readonly AgentWorkflowStepReport[]> {
  const steps: AgentWorkflowStepReport[] = [];
  for (const check of input.policy.changedChecks) {
    const paths = changes.existingPaths.filter((path) =>
      check.extensions.some((extension) => pathMatchesExtension(path, extension))
    );
    if (paths.length === 0) {
      continue;
    }
    steps.push(
      await executeStep(
        input,
        runner,
        check.id,
        check.script,
        check.passPaths ? paths : []
      )
    );
  }
  return Object.freeze(steps);
}

export async function runChangedAgentWorkflow(
  input: AgentWorkflowInvocation,
  changesReader: RepositoryChangesReader,
  scriptRunner: PackageScriptRunner
): Promise<AgentWorkflowChangedReport> {
  const changes = await changesReader.collect({
    consumerRoot: input.consumerRoot,
    ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  const fastFull = shouldRunFastFull(input, changes);
  const steps = fastFull
    ? Object.freeze([
        await executeStep(
          input,
          scriptRunner,
          "fast-full",
          input.policy.scripts.fast,
          []
        )
      ])
    : await changedSteps(input, changes, scriptRunner);
  return Object.freeze({
    reportSchemaVersion: 1,
    outcome: steps.some(({ outcome }) => outcome === "violations")
      ? "violations"
      : "passed",
    coverage: fastFull ? "fast-full" : "changed",
    baselineRef: changes.baselineRef,
    baselineCommit: changes.baselineCommit,
    changedPaths: changes.changedPaths,
    steps
  });
}
