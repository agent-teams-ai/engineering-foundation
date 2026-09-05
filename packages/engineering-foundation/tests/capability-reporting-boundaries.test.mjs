import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CapabilityInputError, FoundationError } from "../dist/features/validation-reporting/api.js";
import { FilesystemPackageScriptCatalogReader } from "../dist/capabilities/quality-gate-runner/adapters/outbound/filesystem/filesystem-package-script-catalog-reader.js";
import { createQualityGateCliCommand } from "../dist/capabilities/quality-gate-runner/adapters/inbound/cli/quality-gate-cli-command.js";
import { FilesystemEffectiveInstructionsReader } from "../dist/capabilities/repository-agent-workflow/adapters/outbound/filesystem/filesystem-effective-instructions-reader.js";
import { FilesystemRepositoryAgentWorkflowReader } from "../dist/capabilities/repository-agent-workflow/adapters/outbound/filesystem/filesystem-repository-agent-workflow-reader.js";
import { GitRepositoryChangesReader } from "../dist/capabilities/repository-agent-workflow/adapters/outbound/git/git-repository-changes-reader.js";
import { FilesystemRepositorySecurityReader } from "../dist/capabilities/repository-security-baseline/adapters/outbound/filesystem/filesystem-repository-security-reader.js";
import { FilesystemArchitectureDecisionBaselineRepository } from "../dist/capabilities/governance-architecture-decisions/adapters/outbound/filesystem/filesystem-architecture-decision-baseline-repository.js";
import { FilesystemBufBreakingQualificationEvidence } from "../dist/capabilities/contract-protobuf-evolution/adapters/outbound/qualification/filesystem-buf-breaking-qualification-evidence.js";

const cancellationProblem = {
  code: "EXECUTION_CANCELLED",
  message: "Foundation check was cancelled.",
  phase: "execution",
  retryable: false
};

function inputProblem(problem) {
  return (error) => {
    assert.ok(error instanceof CapabilityInputError);
    assert.equal(error.name, "CapabilityInputError");
    assert.equal(error.message, problem.message);
    assert.deepEqual(error.problem, { ...problem, retryable: false });
    return true;
  };
}

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "foundation-reporting-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("catalog diagnostics and frozen script data retain exact public behavior", async (context) => {
  const root = await fixture(context);
  const reader = new FilesystemPackageScriptCatalogReader();
  for (const [source, message] of [
    ["null", "The consumer root package.json must be an object."],
    ['{"scripts":[]}', "The consumer root package.json must declare a scripts object."],
    ['{"scripts":{"check":3}}', "package.json script check must be a string."]
  ]) {
    await writeFile(join(root, "package.json"), source);
    await assert.rejects(reader.read(root), inputProblem({
      code: "QUALITY_GATE_RUNNER_PACKAGE_INVALID",
      message,
      phase: "quality-gate-runner-package-catalog"
    }));
    assert.equal(await readFile(join(root, "package.json"), "utf8"), source);
  }
  const source = '{"scripts":{"check":"node check.js","__proto__":"literal"}}\n';
  await writeFile(join(root, "package.json"), source);
  const result = await reader.read(root);
  assert.equal(Object.getPrototypeOf(result.scripts), null);
  assert.deepEqual(Object.entries(result.scripts), [["check", "node check.js"], ["__proto__", "literal"]]);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.scripts));
  assert.equal(await readFile(join(root, "package.json"), "utf8"), source);
});

test("all reporting consumers preserve canonical cancellation before IO", async (context) => {
  const root = await fixture(context);
  const missing = join(root, "not-created");
  const signal = AbortSignal.abort(new Error("operator reason is not the report"));
  const invocations = [
    () => new FilesystemPackageScriptCatalogReader().read(missing, signal),
    () => new FilesystemEffectiveInstructionsReader().discover({ consumerRoot: missing, targetPath: "file.ts", signal }),
    () => new FilesystemEffectiveInstructionsReader().readDirectory({ consumerRoot: missing, directory: ".", readSelectedBytes: true, signal }),
    () => new FilesystemRepositoryAgentWorkflowReader().read(missing, {}, signal),
    () => new FilesystemRepositorySecurityReader().read(missing, {}, signal),
    () => new FilesystemArchitectureDecisionBaselineRepository().read({ consumerRoot: missing, path: "baseline.json", signal }),
    () => new FilesystemArchitectureDecisionBaselineRepository().write({ consumerRoot: missing, path: "baseline.json", signal }),
    () => new FilesystemBufBreakingQualificationEvidence(() => assert.fail("schema validation after cancellation")).read({ consumerRoot: missing, signal })
  ];
  for (const invoke of invocations) {
    await assert.rejects(invoke(), inputProblem(cancellationProblem));
  }
});

test("post-read cancellation stays canonical even inside the baseline JSON catch", async (context) => {
  const root = await fixture(context);
  const source = '{"scripts":{"check":"node check.js"}}\n';
  await writeFile(join(root, "package.json"), source);
  await writeFile(join(root, "baseline.json"), source);
  for (const invoke of [
    (signal) => new FilesystemPackageScriptCatalogReader().read(root, signal),
    (signal) => new FilesystemArchitectureDecisionBaselineRepository().read({ consumerRoot: root, path: "baseline.json", signal })
  ]) {
    let checkpoints = 0;
    const signal = { get aborted() { checkpoints += 1; return checkpoints > 1; } };
    await assert.rejects(invoke(signal), inputProblem(cancellationProblem));
    assert.equal(checkpoints, 2);
  }
  assert.equal(await readFile(join(root, "baseline.json"), "utf8"), source);
});

test("effective-instruction errors retain phase and are not recast by the root catch", async (context) => {
  const root = await fixture(context);
  const reader = new FilesystemEffectiveInstructionsReader();
  await assert.rejects(reader.discover({ consumerRoot: root, targetPath: "bad\npath.ts" }), inputProblem({
    code: "REPOSITORY_AGENT_WORKFLOW_TARGET_PATH_INVALID",
    message: "The target path must be a well-formed repository-relative POSIX path in Unicode NFC without control, bidirectional-formatting, or line-separator characters.",
    phase: "repository-agent-workflow-effective-instructions"
  }));
  const file = join(root, "not-directory");
  await writeFile(file, "unchanged");
  await assert.rejects(reader.discover({ consumerRoot: file, targetPath: "file.ts" }), inputProblem({
    code: "REPOSITORY_AGENT_WORKFLOW_ROOT_INVALID",
    message: "The consumer root must be an existing directory.",
    phase: "repository-agent-workflow-effective-instructions"
  }));
  await assert.rejects(new FilesystemRepositoryAgentWorkflowReader().read(root, { instructions: {} }), inputProblem({
    code: "REPOSITORY_AGENT_WORKFLOW_PACKAGE_INVALID",
    message: "package.json must be valid JSON.",
    phase: "repository-agent-workflow-evidence"
  }));
});

test("Git input failures retain FoundationError identity without invoking an executor", async () => {
  const reader = new GitRepositoryChangesReader(() => assert.fail("invalid base must not execute"));
  await assert.rejects(reader.collect({ consumerRoot: ".", baseRef: "--unsafe" }), (error) => {
    assert.ok(error instanceof FoundationError);
    assert.equal(error.code, "CONSUMER_INVALID");
    assert.equal(error.message, "The base ref cannot start with a dash.");
    return true;
  });
});

test("security, baseline-write and Buf observation errors retain exact reporting identity", async (context) => {
  const root = await fixture(context);
  await assert.rejects(new FilesystemRepositorySecurityReader().read(join(root, "missing"), {}), inputProblem({
    code: "CONSUMER_ROOT_UNAVAILABLE",
    message: "Consumer root must be an accessible directory.",
    phase: "repository-security-evidence"
  }));
  await assert.rejects(new FilesystemArchitectureDecisionBaselineRepository().write({ consumerRoot: root, path: "baseline.json", baseline: {}, expected: { kind: "missing" } }), inputProblem({
    code: "ARCHITECTURE_DECISION_BASELINE_WRITE_INVALID_INPUT",
    message: "Accepted-decision baseline does not match the required immutable baseline shape.",
    phase: "architecture-decision-baseline-write"
  }));
  await assert.rejects(new FilesystemBufBreakingQualificationEvidence(() => assert.fail("missing evidence must not validate")).read({ consumerRoot: root, configuration: { qualification: { evidencePath: "missing.yaml" } } }), inputProblem({
    code: "BUF_QUALIFICATION_INPUT_UNAVAILABLE",
    message: "Buf qualification evidence is unavailable, unsafe, or changed while reading: missing.yaml.",
    phase: "protobuf-buf-qualification-evidence"
  }));
});

test("CLI input rejection and unexpected errors preserve identity and release the subscription", async () => {
  let released = 0;
  const unexpected = new Error("loader failure");
  const command = createQualityGateCliCommand({
    cancellationSource: { subscribe() { return () => { released += 1; }; } },
    failureJson: () => assert.fail("unexpected error must escape"),
    commandFactory: () => assert.fail("invalid setup must not run"),
    foundationConfigLoader: async () => { throw unexpected; }
  });
  const parsed = { command: "gate.run", positional: [], consumerRoot: ".", format: "json" };
  await assert.rejects(command(parsed, {}), (error) => {
    assert.ok(error instanceof FoundationError);
    assert.equal(error.code, "CONSUMER_INVALID");
    assert.equal(error.message, "gate run requires a profile ID.");
    return true;
  });
  assert.equal(released, 0);
  await assert.rejects(command({ ...parsed, positional: ["fast"] }, {}), (error) => error === unexpected);
  assert.equal(released, 1);
});
