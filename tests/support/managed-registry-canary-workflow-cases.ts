import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse as parseYaml } from "yaml";

type WorkflowInput = {
  readonly description: unknown;
  readonly required: unknown;
  readonly type: unknown;
};
type CanaryWorkflow = {
  readonly on: {
    readonly workflow_dispatch: { readonly inputs: Readonly<Record<string, WorkflowInput>> };
  };
  readonly permissions: Readonly<Record<string, unknown>>;
  readonly jobs: {
    readonly qualify: {
      readonly if: string;
      readonly steps: readonly [
        { readonly with: { readonly ref: string; readonly "fetch-depth": unknown } },
        ...unknown[],
      ];
    };
  };
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function assertCanaryWorkflow(value: unknown): asserts value is CanaryWorkflow {
  assert.ok(isRecord(value));
  assert.ok(isRecord(value.on));
  assert.ok(isRecord(value.on.workflow_dispatch));
  assert.ok(isRecord(value.on.workflow_dispatch.inputs));
  for (const input of Object.values(value.on.workflow_dispatch.inputs)) {
    assert.ok(isRecord(input));
    assert.ok("description" in input && "required" in input && "type" in input);
  }
  assert.ok(isRecord(value.permissions));
  assert.ok(isRecord(value.jobs));
  assert.ok(isRecord(value.jobs.qualify));
  assert.equal(typeof value.jobs.qualify.if, "string");
  assert.ok(Array.isArray(value.jobs.qualify.steps));
  const first = value.jobs.qualify.steps[0];
  assert.ok(isRecord(first));
  assert.ok(isRecord(first.with));
  assert.equal(typeof first.with.ref, "string");
  assert.ok("fetch-depth" in first.with);
}

test("workflow is manual and capture plus digest precede the earliest installed import", async () => {
  const source = await readFile(
    new URL("../../.github/workflows/public-managed-registry-canary.yml", import.meta.url),
    "utf8",
  );
  const runnerSource = await readFile(
    new URL("../../scripts/public-managed-registry-canary.mjs", import.meta.url),
    "utf8",
  );
  const mcpRunnerSource = await readFile(
    new URL("../../scripts/public-managed-registry-canary-mcp.mjs", import.meta.url),
    "utf8",
  );
  const workflow: unknown = parseYaml(source);
  assertCanaryWorkflow(workflow);
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs).toSorted(), [
    "authority_revision",
    "cohort_id",
    "expected_commit",
  ]);
  for (const input of Object.values(workflow.on.workflow_dispatch.inputs)) {
    assert.deepEqual(Object.keys(input).toSorted(), ["description", "required", "type"]);
    assert.equal(input.required, true);
    assert.equal(input.type, "string");
  }
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.match(
    workflow.jobs.qualify.if,
    /github\.ref == 'refs\/heads\/main' && github\.sha == inputs\.expected_commit/u,
  );
  assert.match(workflow.jobs.qualify.steps[0].with.ref, /inputs\.expected_commit/u);
  assert.equal(workflow.jobs.qualify.steps[0].with["fetch-depth"], 0);
  assert.equal(JSON.stringify(workflow).includes("secrets."), false);
  assert.doesNotMatch(source, /npm\s+(?:publish|unpublish|deprecate|dist-tag)|pnpm\s+publish/u);
  assert.match(source, /node tools\/dev\.mts --profile node install/u);
  assert.match(source, /node tools\/dev\.mts --profile node build/u);
  assert.match(source, /PUBLIC_CANARY_NODE_EXECUTABLE/u);
  assert.match(
    source,
    /pnpm\/setup@703c52620218391530e48b9e8870d5c0082e1b9b[\s\S]*?version: "11\.20\.0"/u,
  );
  assert.doesNotMatch(
    source,
    /node-version: \$\{\{ steps\.select-cohort-runtime\.outputs\.node \}\}\s*\n\s+cache: pnpm/u,
  );
  assert.match(source, /Run read-only six-package public managed registry canary/u);
  const qualificationSource = await readFile(
    new URL("../../scripts/public-managed-registry-canary-qualification.mts", import.meta.url),
    "utf8",
  );
  const capture = runnerSource.indexOf("const lockfile = await readFile");
  const copy = runnerSource.indexOf("const lockfileBytes = Buffer.from(lockfile)", capture);
  const digestCapture = runnerSource.indexOf("const lockfileDigest = sha256(lockfileBytes)", copy);
  const rootInstalledImport = runnerSource.indexOf(
    "await import(${JSON.stringify(coordinate.name)})",
  );
  assert.ok(
    capture >= 0 && copy > capture && digestCapture > copy && rootInstalledImport > digestCapture,
  );
  assert.doesNotMatch(
    runnerSource.slice(rootInstalledImport - 300, rootInstalledImport),
    /readFile\('pnpm-lock\.yaml'\)/u,
  );
  assert.match(runnerSource, /GITHUB_REPOSITORY_ID/u);
  const qualificationCapture = qualificationSource.indexOf(
    "const capturedLockfileBytes = Buffer.from(",
  );
  const qualificationDigest = qualificationSource.indexOf(
    "createHash('sha256').update(capturedLockfileBytes)",
    qualificationCapture,
  );
  const qualificationCopy = qualificationSource.indexOf(
    "const exactLockfileBytes = () => Buffer.from(capturedLockfileBytes)",
    qualificationDigest,
  );
  const qualificationPackageImport = qualificationSource.indexOf(
    "await import('@agent-teams/docs-protocol-agent-teams')",
  );
  const qualificationEntryPointImport = qualificationSource.indexOf(
    "await import('@agent-teams/docs-protocol-agent-teams/qualification')",
  );
  assert.ok(qualificationPackageImport >= 0 && qualificationEntryPointImport >= 0);
  const earliestQualificationImport = Math.min(
    qualificationPackageImport,
    qualificationEntryPointImport,
  );
  assert.ok(
    qualificationCapture >= 0 &&
      qualificationDigest > qualificationCapture &&
      qualificationCopy > qualificationDigest &&
      earliestQualificationImport > qualificationCopy,
  );
  assert.doesNotMatch(
    qualificationSource.slice(qualificationCopy, earliestQualificationImport),
    /readFile\('(?:pnpm-lock\.yaml|package-lock\.json)'\)/u,
  );
  assert.match(qualificationSource, /lockfileBytes: exactLockfileBytes\(\)/u);
  const supportingInstall = mcpRunnerSource.indexOf("async function installSupportingMcp");
  const supportingCapture = mcpRunnerSource.indexOf(
    "const lockfile = await readFile",
    supportingInstall,
  );
  const supportingCopy = mcpRunnerSource.indexOf(
    "const lockfileBytes = Buffer.from(lockfile)",
    supportingCapture,
  );
  const supportingDigest = mcpRunnerSource.indexOf(
    "const lockfileDigest = sha256(lockfileBytes)",
    supportingCopy,
  );
  const supportingLockValidation = mcpRunnerSource.indexOf(
    "assertSupportingMcpNpmLockCoordinates",
    supportingDigest,
  );
  const supportingQualification = mcpRunnerSource.indexOf("async function qualifySupportingMcp");
  const supportingSignature = mcpRunnerSource.indexOf(
    "const signatureEvidence = await npmSignatureEvidence",
    supportingQualification,
  );
  const supportingInventory = mcpRunnerSource.indexOf(
    "const inventory = await packInventory",
    supportingSignature,
  );
  const supportingProvenance = mcpRunnerSource.indexOf(
    "const provenance = verifiedProvenanceFromNpmAudit",
    supportingInventory,
  );
  const supportingExecution = mcpRunnerSource.indexOf(
    "await verifyRegistryDocsProtocolMcp",
    supportingProvenance,
  );
  assert.ok(
    supportingInstall >= 0 &&
      supportingCapture > supportingInstall &&
      supportingCopy > supportingCapture &&
      supportingDigest > supportingCopy &&
      supportingLockValidation > supportingDigest &&
      supportingQualification >= 0 &&
      supportingSignature > supportingQualification &&
      supportingInventory > supportingSignature &&
      supportingProvenance > supportingInventory &&
      supportingExecution > supportingProvenance,
  );
  assert.match(runnerSource, /6 exact release packages \(5 Cohort \+ supporting MCP\)/u);
});
