import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NodeDocumentEnvironmentInspector } from "../packages/document-authoring/dist/document-authoring/adapters/node/node-document-environment-inspector.js";
import { RunDocumentDoctor } from "../packages/document-authoring/dist/document-authoring/application/use-cases/run-document-doctor.js";
import { assertSchema } from "../packages/document-authoring/dist/document-authoring/adapters/node/schema-catalog.js";
import { inspectDocumentAuthoringEnvironmentV1 } from "../packages/document-authoring/dist/index.js";

const digest = `sha256:${"b".repeat(64)}`;

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "document-doctor-environment-"));
  try {
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function inspector(platform) {
  return new NodeDocumentEnvironmentInspector({
    async buildIdentity() { return digest; },
    async version() { return "0.16.0"; },
  }, {
    platform,
  });
}

test("Node environment inspection is non-mutating and reports POSIX platform support", async () => {
  await withFixture(async (root) => {
    const before = await readdir(root);
    const result = await inspector("linux").inspect(root);
    assert.deepEqual(result, {
      installedFoundationVersion: "0.16.0",
      installedFoundationBuildIdentity: digest,
      filesystem: {
        basis: "platform-contract",
        strictDirectoryDurability: "platform-supported",
      },
    });
    assert.deepEqual(await readdir(root), before);
  });
});

test("public environment inspection v1 exposes the installed immutable snapshot", async () => {
  await withFixture(async (root) => {
    const before = await readdir(root);
    const result = await inspectDocumentAuthoringEnvironmentV1({
      consumerRoot: root,
    });
    assert.equal(typeof result.installedFoundationVersion, "string");
    assert.match(
      result.installedFoundationBuildIdentity,
      /^sha256:[0-9a-f]{64}$/u,
    );
    assert.deepEqual(result.filesystem, {
      basis: "platform-contract",
      strictDirectoryDurability:
        process.platform === "win32"
          ? "platform-unsupported"
          : "platform-supported",
    });
    assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(await readdir(root), before);
  });
});

test("Windows platform contract produces an exact doctor violation without recovery", async () => {
  await withFixture(async (root) => {
    const doctor = new RunDocumentDoctor({
      environment: inspector("win32"),
      async inspect() {
        return { schemaVersion: 1, state: "idle", diagnostics: [] };
      },
    });
    const execution = await doctor.execute({ consumerRoot: root });
    assert.equal(execution.exitCode, 1);
    assert.equal(execution.envelope.outcome, "violation");
    assert.deepEqual(execution.envelope.result, {
      kind: "doctor",
      installedFoundationVersion: "0.16.0",
      installedFoundationBuildIdentity: digest,
      filesystem: {
        basis: "platform-contract",
        strictDirectoryDurability: "platform-unsupported",
      },
      transactionState: "none",
      recoveryClass: "not-required",
    });
    assert.equal(
      execution.envelope.diagnostics[0]?.ruleId,
      "document.environment.strict-directory-durability-unsupported",
    );
    await assertSchema(
      "document-command-envelope/v2",
      execution.envelope,
      "windows-doctor-environment",
    );
    assert.deepEqual(await readdir(root), []);
  });
});

test("doctor always reports the installed environment for transaction recovery", async () => {
  await withFixture(async (root) => {
    const execution = await new RunDocumentDoctor({
      environment: inspector("darwin"),
      async inspect() {
        return {
          schemaVersion: 1,
          state: "manual-recovery-required",
          reason: "unknown evidence",
          transactionKind: "unknown",
          diagnostics: [],
        };
      },
    }).execute({ consumerRoot: root });
    assert.equal(execution.envelope.result.installedFoundationVersion, "0.16.0");
    assert.equal(execution.envelope.result.installedFoundationBuildIdentity, digest);
    assert.equal(
      execution.envelope.result.filesystem?.strictDirectoryDurability,
      "platform-supported",
    );
  });
});

test("rejects a directly symlinked consumer root without creating state", async () => {
  if (process.platform === "win32") {
    return;
  }
  await withFixture(async (root) => {
    const link = `${root}-link`;
    try {
      await symlink(root, link, "dir");
      await assert.rejects(
        inspector("linux").inspect(link),
        /canonical real directory/u,
      );
      assert.deepEqual(await readdir(root), []);
    } finally {
      await rm(link, { force: true });
    }
  });
});

test("preserves installed environment evidence when transaction inspection fails", async () => {
  await withFixture(async (root) => {
    const execution = await new RunDocumentDoctor({
      environment: inspector("linux"),
      async inspect() { throw new Error("inspection failed"); },
    }).execute({ consumerRoot: root });
    assert.equal(execution.envelope.outcome, "execution-failure");
    assert.equal(execution.envelope.result.installedFoundationVersion, "0.16.0");
    assert.equal(execution.envelope.result.installedFoundationBuildIdentity, digest);
  });
});
