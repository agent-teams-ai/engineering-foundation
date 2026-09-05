const load = (path) => import(`../packages/engineering-foundation/dist/${path}.js`);
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  cliPath,
  withPublicApiFixture
} from "./support/capability-fixtures.mjs";

test("promotes namespace exports with a deterministic non-empty signature", async () => {
  await withPublicApiFixture(async (consumerRoot) => {
    const declarationsRoot = join(consumerRoot, "packages", "library", "dist");
    await writeFile(
      join(declarationsRoot, "index.d.ts"),
      'export * as tools from "./tools.js";\nexport declare function stable(value: string): string;\n',
      "utf8"
    );
    await writeFile(
      join(declarationsRoot, "tools.d.ts"),
      "export declare function inspect(): void;\n",
      "utf8"
    );
    const manifestPath = join(consumerRoot, "packages", "library", "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.version = "1.3.0";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const promotion = spawnSync(
      process.execPath,
      [cliPath, "public-api-promote-release", "--consumer", consumerRoot, "--json"],
      { encoding: "utf8" }
    );
    assert.equal(promotion.status, 0, promotion.stderr);
    const baseline = JSON.parse(
      await readFile(
        join(consumerRoot, "architecture", "public-api", "public-api.json"),
        "utf8"
      )
    );
    const namespace = baseline.entrypoints
      .find(({ exportPath }) => exportPath === ".")
      .items.find(({ kind }) => kind === "Namespace");
    assert.equal(namespace.signature, "namespace tools");
  });
});

test("curated application APIs exclude concrete adapters and preserve supported module names", async () => {
  const root = await load("index");
  const surface = await load("public-api-surface");
  assert.deepEqual(Object.keys(surface).toSorted(), [...Object.keys(root), "scaffolding"].toSorted());
  for (const name of Object.keys(root)) {
    assert.equal(surface[name], root[name]);
  }
  for (const path of [
    "source-inventory/api", "workspace-inventory/api", "process-execution/api",
    "capabilities/source-dependencies/api", "capabilities/suppression-governance/api",
    "capabilities/executable-specifications/api", "capabilities/contract-protobuf-evolution/api",
    "capabilities/governance-architecture-decisions/api", "capabilities/property-testing-standard/api",
  ]) {
    const api = await load(path);
    assert.equal(Object.keys(api).some((name) => /^(?:Node|Filesystem|Pnpm|Ajv|Oxc|GovernanceAccepted)/u.test(name)), false, path);
  }
});

test("governance ACLs map only their caller contracts and retain cancellation and failure identity", async () => {
  const evidence = Object.freeze({ acceptedDecisionIds: ["ADR-0001"], acceptedDecisionPaths: ["docs/0001.md"] });
  const signal = new AbortController().signal;
  const input = { consumerRoot: "/inert", baselinePath: "accepted.json", governanceConfigPath: "decisions.yaml", signal };
  for (const capability of ["contract-protobuf-evolution", "public-api-compatibility"]) {
    const { GovernanceAcceptedDecisionEvidenceAcl } = await load(`capabilities/${capability}/adapters/outbound/governance/governance-accepted-decision-evidence-acl`);
    let calls = 0;
    const acl = new GovernanceAcceptedDecisionEvidenceAcl(async (request) => {
      calls += 1;
      assert.deepEqual(request, { consumerRoot: "/inert", baselinePath: "accepted.json", configPath: "decisions.yaml", signal });
      return evidence;
    });
    assert.deepEqual(await acl.readAcceptedDecisionEvidence(input), capability === "public-api-compatibility"
      ? evidence : { acceptedDecisionIds: ["ADR-0001"] });
    assert.equal(calls, 1);
    const failure = new Error("governance rejects the observation");
    const failing = new GovernanceAcceptedDecisionEvidenceAcl(async () => { throw failure; });
    await assert.rejects(failing.readAcceptedDecisionEvidence(input), (error) => error === failure);
  }
});

test("workflow process adapters use the selected executor and preserve process evidence", async () => {
  const { createProcessExecution } = await load("capabilities/repository-agent-workflow/adapters/outbound/process/process-execution");
  const { PnpmPackageScriptRunner } = await load("capabilities/repository-agent-workflow/adapters/outbound/pnpm/pnpm-package-script-runner");
  const { GitRepositoryChangesReader } = await load("capabilities/repository-agent-workflow/adapters/outbound/git/git-repository-changes-reader");
  const signal = new AbortController().signal;
  const requests = [];
  const execute = createProcessExecution({ async run(request) {
    requests.push(request);
    return { exitCode: 17, signal: "SIGTERM", stdout: "observed", stderr: "failure" };
  } });
  assert.deepEqual(await execute("git", ["status"], { cwd: "/inert", signal, strictUtf8: true }), {
    exitCode: 17, stdout: "observed", stderr: "failure",
  });
  assert.deepEqual(requests[0], { command: "git", args: ["status"], cwd: "/inert", signal, strictUtf8: true });
  const runner = new PnpmPackageScriptRunner({ npmExecPath: cliPath }, execute);
  assert.equal((await runner.run({ consumerRoot: "/inert", script: "test", paths: ["src/value.ts"], signal })).exitCode, 17);
  assert.deepEqual(requests[1].args, [cliPath, "run", "test", "--", "src/value.ts"]);
  assert.equal(requests[1].signal, signal);
  const reader = new GitRepositoryChangesReader(createProcessExecution({ async run(request) {
    assert.equal(request.strictUtf8, true);
    assert.equal(request.signal, signal);
    throw new Error("Process output is not valid UTF-8.");
  } }));
  await assert.rejects(reader.collect({ consumerRoot: process.cwd(), signal }), /not valid UTF-8/u);
});
