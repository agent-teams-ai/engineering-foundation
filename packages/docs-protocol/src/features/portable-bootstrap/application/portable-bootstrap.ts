import { portableBootstrapDesiredFiles } from "./portable-bootstrap-assets.js";
import { assertInput, planCreateOnlyFile, planAgentsFile, portablePlanDigest } from "./bootstrap-policy.js";
import type { PortableBootstrapInput, ApplyPortableBootstrapInput, PortableBootstrapPlan, PortableBootstrapExecution, PortableBootstrapPorts, BootstrapOperation, PortableBootstrapFilePlan, PortableBootstrapIssue } from "./bootstrap-model.js";

export async function compilePortableBootstrap(input: PortableBootstrapInput, ports: PortableBootstrapPorts): Promise<PortableBootstrapPlan> {
  assertInput(input);
  const root = await ports.repository.canonicalRoot(input.consumerRoot);
  const desired = portableBootstrapDesiredFiles(input.projectId, input.ownerId);
  const operations: BootstrapOperation[] = [];
  const files: PortableBootstrapFilePlan[] = [];
  const issues: PortableBootstrapIssue[] = [];

  for (const file of desired) {
    const planned = planCreateOnlyFile(file, await ports.repository.observe(root, file.path));
    files.push(planned.file);
    if (planned.operation !== undefined) {operations.push(planned.operation);}
    if (planned.issue !== undefined) {issues.push(planned.issue);}
  }

  const agents = planAgentsFile(await ports.repository.observe(root, "AGENTS.md"));
  files.push(agents.file);
  if (agents.operation !== undefined) {operations.push(agents.operation);}
  if (agents.issue !== undefined) {issues.push(agents.issue);}

  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  issues.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const transactionPlan = issues.length === 0
    ? ports.transactions.compile(operations)
    : undefined;
  const mutationRequired = files.some(({ writeState }) => writeState === "create" || writeState === "replace");
  const outcome = issues.length > 0 ? "blocked" : mutationRequired ? "change-required" : "current";
  const frozenFiles = Object.freeze(files.map((file) => Object.freeze(file)));
  const frozenIssues = Object.freeze(issues.map((issue) => Object.freeze(issue)));
  return Object.freeze({
    schemaVersion: 1,
    protocol: "agent-teams.docs-protocol.portable-bootstrap/v1",
    mode: input.mode,
    outcome,
    planDigest: portablePlanDigest({
      desired,
      transactionPlan,
      projectId: input.projectId,
      ownerId: input.ownerId,
      files: frozenFiles,
      issues: frozenIssues
    }),
    files: frozenFiles,
    issues: frozenIssues,
    ...(transactionPlan === undefined ? {} : { transactionPlan })
  });
}

export async function applyPortableBootstrap(input: ApplyPortableBootstrapInput, ports: PortableBootstrapPorts): Promise<PortableBootstrapExecution> {
  if (typeof input.expectedPlanDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(input.expectedPlanDigest)) {
    throw new TypeError("expectedPlanDigest must be the exact digest returned by dry-run.");
  }
  const compiled = await compilePortableBootstrap(input, ports);
  if (compiled.outcome === "blocked" || compiled.transactionPlan === undefined) {
    throw new Error("Portable bootstrap is blocked by conflicting repository files.");
  }
  if (input.expectedPlanDigest !== compiled.planDigest) {
    throw new Error(`Portable bootstrap Plan is stale: expected ${input.expectedPlanDigest}, observed ${compiled.planDigest}.`);
  }
  const receipt = await ports.transactions.apply({
    consumerRoot: input.consumerRoot,
    plan: compiled.transactionPlan
  });
  return Object.freeze({
    outcome: receipt.outcome === "applied" ? "applied" : "current",
    plan: compiled,
    receipt
  });
}
