import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { stringify } from "yaml";

import { describeCanonicalConsumerAssets } from "../dist/consumer-integration/index.js";
import { computePnpmRuntimeClosureDigestV2 } from
  "../dist/consumer-integration/adapters/pnpm-runtime-closure-v2.js";

const cli = new URL("../dist/cli.js", import.meta.url).pathname;
const sha256 = (character) => `sha256:${character.repeat(64)}`;
const integrity = (character) => `sha512-${character.repeat(86)}==`;

function qualificationFixture() {
  const packages = {
    repositoryMutation: { version: "0.1.0", integrity: integrity("A") },
    documentAuthoring: { version: "0.1.0", integrity: integrity("B") },
    docsProtocol: { version: "0.5.0", integrity: integrity("C") },
    docsProtocolAgentTeams: { version: "0.1.0", integrity: integrity("D") },
    engineeringFoundation: { version: "1.0.0", integrity: integrity("E") }
  };
  const names = {
    repositoryMutation: "@agent-teams/repository-mutation",
    documentAuthoring: "@agent-teams/document-authoring",
    docsProtocol: "@agent-teams/docs-protocol",
    docsProtocolAgentTeams: "@agent-teams/docs-protocol-agent-teams",
    engineeringFoundation: "@agent-teams/engineering-foundation"
  };
  const dependencies = {
    repositoryMutation: {},
    documentAuthoring: { [names.repositoryMutation]: packages.repositoryMutation.version },
    docsProtocol: {
      [names.documentAuthoring]: packages.documentAuthoring.version,
      [names.repositoryMutation]: packages.repositoryMutation.version
    },
    docsProtocolAgentTeams: {
      [names.docsProtocol]: packages.docsProtocol.version,
      [names.repositoryMutation]: packages.repositoryMutation.version
    },
    engineeringFoundation: {
      [names.documentAuthoring]: packages.documentAuthoring.version,
      [names.repositoryMutation]: packages.repositoryMutation.version
    }
  };
  const direct = ["docsProtocol", "docsProtocolAgentTeams", "engineeringFoundation"];
  const lockfile = {
    lockfileVersion: "9.0",
    importers: {
      ".": {
        devDependencies: Object.fromEntries(direct.map((key) => [
          names[key],
          { specifier: packages[key].version, version: packages[key].version }
        ]))
      }
    },
    packages: Object.fromEntries(Object.keys(packages).map((key) => [
      `${names[key]}@${packages[key].version}`,
      { resolution: { integrity: packages[key].integrity } }
    ])),
    snapshots: Object.fromEntries(Object.keys(packages).map((key) => [
      `${names[key]}@${packages[key].version}`,
      Object.keys(dependencies[key]).length === 0 ? {} : { dependencies: dependencies[key] }
    ]))
  };
  const profile = {
    schemaVersion: 3,
    repository: { provider: "github", id: "123", nameWithOwner: "example/docs" },
    integrationRoot: ".",
    packageManager: "pnpm",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    skillPath: ".agents/skills/docs-authoring/SKILL.md",
    callerWorkflowPath: ".github/workflows/docs-protocol.yml",
    managedStatePath: "architecture/foundation/docs-protocol-managed-state.json",
    qualification: {
      contractPath: "architecture/foundation/docs-protocol-qualification.json",
      gateCommand: "pnpm docs:protocol:check"
    },
    cohort: {
      schemaVersion: 2,
      cohortId: "docs-v2-rc1",
      channel: "rc",
      recordDigest: sha256("1"),
      qualificationEventDigest: sha256("2"),
      eligibleAfter: "2026-09-04T12:00:00Z",
      upgradeFrom: ["docs-v1"],
      rollbackTo: ["docs-v1"],
      packages,
      workflow: {
        repository: "agent-teams-ai/.github",
        path: ".github/workflows/docs-protocol-check.yml",
        revision: "3".repeat(40),
        blobSha: "4".repeat(40)
      },
      assets: {
        skillDigest: sha256("5"),
        callerWorkflowDigest: sha256("6"),
        assetCatalogDigest: sha256("7"),
        transitionCatalogDigest: sha256("8")
      },
      schemas: { consumerIntegration: 3, managedState: 2, docsProtocol: 1 },
      runtime: {
        node: ">=24.18.0 <25",
        pnpm: ">=11.17.0 <12",
        runtimeClosureDigest: sha256("9")
      }
    }
  };
  profile.cohort.runtime.runtimeClosureDigest = computePnpmRuntimeClosureDigestV2(
    lockfile,
    profile.cohort
  );
  profile.cohort.assets = describeCanonicalConsumerAssets(profile.cohort);
  return { lockfile: stringify(lockfile), profile };
}

async function disposableConsumer() {
  const root = await mkdtemp(join(tmpdir(), "docs-qualification-cli-v3-"));
  const architecture = join(root, "architecture", "foundation");
  await mkdir(architecture, { recursive: true });
  const fixture = qualificationFixture();
  await Promise.all([
    writeFile(
      join(architecture, "docs-consumer-integration.json"),
      `${JSON.stringify(fixture.profile, null, 2)}\n`
    ),
    writeFile(join(root, "pnpm-lock.yaml"), fixture.lockfile),
    writeFile(join(root, "package.json"), `${JSON.stringify({
      name: "disposable-qualification-v3",
      private: true,
      scripts: { "docs:protocol:check": "node -e \"require('fs').writeFileSync('script-ran', 'bad')\"" }
    }, null, 2)}\n`)
  ]);
  return root;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [cli, "qualify", "--consumer", root, "--json", ...args], {
    encoding: "utf8"
  });
}

test("managed qualify fails closed for profile v3 without trusted registry/canary evidence", async () => {
  const root = await disposableConsumer();
  try {
    const execution = run(root);
    assert.equal(execution.status, 2, execution.stderr || execution.stdout);
    const envelope = JSON.parse(execution.stdout);
    assert.equal(envelope.schemaVersion, 2);
    assert.equal(envelope.outcome, "invalid-input");
    assert.match(
      envelope.diagnostics[0].message,
      /requires a trusted registry\/canary receipt produced outside the consumer CLI/u
    );
    await assert.rejects(access(join(root, "script-ran")), { code: "ENOENT" });

    const local = run(root, "--local-development");
    assert.equal(local.status, 2, local.stderr || local.stdout);
    assert.equal(JSON.parse(local.stdout).schemaVersion, 2);
    assert.equal(JSON.parse(local.stdout).outcome, "invalid-input");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed qualify profile v3 never treats a consumer-owned hostile lockfile as authority", async () => {
  const root = await disposableConsumer();
  try {
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: [\n");
    const execution = run(root);
    assert.notEqual(execution.status, 0);
    const envelope = JSON.parse(execution.stdout);
    assert.equal(envelope.schemaVersion, 2);
    assert.equal(envelope.outcome, "invalid-input");
    assert.deepEqual(envelope.result, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed qualify keeps profile v2 on the disposable qualification suite", () => {
  const root = new URL("./fixtures/qualification", import.meta.url).pathname;
  const execution = run(root, "--local-development");
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const envelope = JSON.parse(execution.stdout);
  assert.equal(envelope.schemaVersion, 2);
  assert.equal(envelope.outcome, "success");
  assert.equal(envelope.result.schemaVersion, 2);
  assert.equal(envelope.result.evidenceClass, "local-development");
});
