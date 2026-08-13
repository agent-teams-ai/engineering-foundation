import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  inspectDocumentTransactionV1,
} from "../packages/engineering-foundation/dist/document-authoring/index.js";
import {
  projectDocumentTransactionInspectionV1,
} from "../packages/engineering-foundation/dist/document-authoring/composition/inspect-document-transaction.js";
import {
  inspectFoundationTransactionAwareMode,
} from "../packages/engineering-foundation/dist/index.js";
import {
  installedFoundationBuildIdentity,
} from "../packages/engineering-foundation/dist/transaction-coordination/adapters/node/installed-foundation-build-identity.js";
import {
  installedFoundationVersion,
} from "../packages/engineering-foundation/dist/package-version.js";
import {
  createDocumentEnvelopeV3,
} from "./fixtures/document-authoring-envelope-v3.mjs";

const fixture = JSON.parse(await readFile(
  new URL("fixtures/document-authoring-contracts/valid-v1.json", import.meta.url),
  "utf8",
));

function exactStatus() {
  const buildIdentity = `sha256:${"a".repeat(64)}`;
  return {
    state: "pending",
    operationKind: "document-authoring",
    format: "document-authoring-envelope-v3",
    foundationVersion: "0.16.0",
    foundationBuildIdentity: buildIdentity,
    recovery: {
      commandId: "docs-recover",
      exactFoundationVersion: "0.16.0",
      exactFoundationBuildIdentity: buildIdentity,
    },
    diagnostics: [{
      code: "FOUNDATION_TRANSACTION_ACTIVE",
      message: "pending document transaction",
    }],
  };
}

test("projects only an exact v3/v2 document handler as docs-recover", () => {
  assert.deepEqual(projectDocumentTransactionInspectionV1(exactStatus()), {
    schemaVersion: 1,
    state: "recoverable",
    operationKind: "document-authoring",
    format: "document-authoring-envelope-v3",
    foundationVersion: "0.16.0",
    foundationBuildIdentity: `sha256:${"a".repeat(64)}`,
    recovery: {
      commandId: "docs-recover",
      exactFoundationVersion: "0.16.0",
      exactFoundationBuildIdentity: `sha256:${"a".repeat(64)}`,
    },
    diagnostics: [{
      code: "FOUNDATION_TRANSACTION_ACTIVE",
      message: "pending document transaction",
    }],
  });

  const mismatch = exactStatus();
  mismatch.diagnostics = [{
    code: "FOUNDATION_TRANSACTION_VERSION_MISMATCH",
    message: "exact build unavailable",
  }];
  assert.deepEqual(projectDocumentTransactionInspectionV1(mismatch), {
    schemaVersion: 1,
    state: "manual-recovery-required",
    reason: "exact build unavailable",
    operationKind: "document-authoring",
    transactionKind: "version-mismatch",
    format: "document-authoring-envelope-v3",
    foundationVersion: "0.16.0",
    foundationBuildIdentity: `sha256:${"a".repeat(64)}`,
    recovery: {
      commandId: "docs-recover",
      args: {
        exactFoundationVersion: "0.16.0",
        exactFoundationBuildIdentity: `sha256:${"a".repeat(64)}`,
      },
    },
    diagnostics: mismatch.diagnostics,
  });

  assert.deepEqual(projectDocumentTransactionInspectionV1({
    state: "idle",
    diagnostics: [],
  }), {
    schemaVersion: 1,
    state: "idle",
    diagnostics: [],
  });

  const manual = {
    state: "manual-recovery-required",
    reason: "physical-identity-unverifiable",
    operationKind: "document-authoring",
    format: "envelope-v3",
    diagnostics: [{
      code: "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED",
      message: "identity is unavailable",
    }],
  };
  assert.deepEqual(projectDocumentTransactionInspectionV1(manual), {
    schemaVersion: 1,
    state: "manual-recovery-required",
    reason: "physical-identity-unverifiable",
    operationKind: "document-authoring",
    transactionKind: "corrupt",
    format: "envelope-v3",
    diagnostics: manual.diagnostics,
  });

  const foreign = {
    state: "pending",
    operationKind: "scaffolding",
    format: "legacy-scaffolding-v1",
    foundationVersion: "0.16.0",
    recovery: {
      commandId: "scaffold-recover",
      exactFoundationVersion: "0.16.0",
    },
    diagnostics: [{
      code: "FOUNDATION_TRANSACTION_ACTIVE",
      message: "recover scaffold first",
    }],
  };
  assert.deepEqual(projectDocumentTransactionInspectionV1(foreign), {
    schemaVersion: 1,
    state: "manual-recovery-required",
    reason: "recover scaffold first",
    operationKind: "scaffolding",
    transactionKind: "scaffold",
    format: "legacy-scaffolding-v1",
    foundationVersion: "0.16.0",
    recovery: {
      commandId: "scaffold-recover",
      args: { exactFoundationVersion: "0.16.0" },
    },
    diagnostics: foreign.diagnostics,
  });
});

test("projects manual status by structured reason without message heuristics", () => {
  const diagnostic = [{
    code: "FOUNDATION_TRANSACTION_MANUAL_RECOVERY_REQUIRED",
    message: "the message intentionally contains unsupported version and document words",
  }];
  for (const [reason, transactionKind] of [
    ["journal-transition-residue", "transition-residue"],
    ["orphan-temporary", "transition-residue"],
    ["invalid-slot", "corrupt"],
    ["corrupt-or-incompatible", "corrupt"],
    ["unsupported-schema", "version-mismatch"],
    ["multiple-transactions", "unknown"],
  ]) {
    const projected = projectDocumentTransactionInspectionV1({
      state: "manual-recovery-required", reason, diagnostics: diagnostic,
    });
    assert.equal(projected.transactionKind, transactionKind);
    assert.equal(projected.recovery, undefined);
  }
});

test("public document inspection exposes docs-recover while legacy local-mode stays lossy", async () => {
  const root = await mkdtemp(join(tmpdir(), "document-public-inspection-"));
  try {
    const envelope = createDocumentEnvelopeV3(fixture);
    const installed = {
      version: await installedFoundationVersion(),
      buildIdentity: await installedFoundationBuildIdentity(),
    };
    envelope.foundation = installed;
    envelope.journal.plan.compiler = {
      ...envelope.journal.plan.compiler,
      ...installed,
    };
    const { documentPlanDigest } = await import(
      "../packages/engineering-foundation/dist/document-authoring/application/policies/document-contract-digests.js"
    );
    const { sha256Json } = await import(
      "../packages/engineering-foundation/dist/canonical-json.js"
    );
    envelope.journal.plan.planDigest = documentPlanDigest(envelope.journal.plan);
    envelope.payloadDigest = sha256Json(envelope.journal);
    delete envelope.envelopeDigest;
    envelope.envelopeDigest = sha256Json(envelope);

    const path = join(root, ".agent-teams-local", "scaffolding-transaction.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(envelope)}\n`, "utf8");

    const documentStatus = await inspectDocumentTransactionV1(root);
    assert.equal(documentStatus.state, "recoverable");
    assert.equal(documentStatus.recovery.commandId, "docs-recover");
    assert.equal(documentStatus.recovery.exactFoundationVersion, installed.version);
    assert.equal(
      documentStatus.recovery.exactFoundationBuildIdentity,
      installed.buildIdentity,
    );

    const legacy = await inspectFoundationTransactionAwareMode(root, {
      ignoreOperationLock: true,
    });
    assert.equal(legacy.transaction.state, "manual-recovery-required");
    assert.equal(legacy.transaction.reason, "recovery-handler-unavailable");
    assert.equal("recovery" in legacy.transaction, false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("public document inspection never follows a redirected state directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "document-public-inspection-"));
  const outside = await mkdtemp(join(tmpdir(), "document-public-inspection-outside-"));
  try {
    const envelope = createDocumentEnvelopeV3(fixture);
    const installed = {
      version: await installedFoundationVersion(),
      buildIdentity: await installedFoundationBuildIdentity(),
    };
    envelope.foundation = installed;
    envelope.journal.plan.compiler = {
      ...envelope.journal.plan.compiler,
      ...installed,
    };
    const { documentPlanDigest } = await import(
      "../packages/engineering-foundation/dist/document-authoring/application/policies/document-contract-digests.js"
    );
    const { sha256Json } = await import(
      "../packages/engineering-foundation/dist/canonical-json.js"
    );
    envelope.journal.plan.planDigest = documentPlanDigest(envelope.journal.plan);
    envelope.payloadDigest = sha256Json(envelope.journal);
    delete envelope.envelopeDigest;
    envelope.envelopeDigest = sha256Json(envelope);
    await writeFile(
      join(outside, "scaffolding-transaction.json"),
      `${JSON.stringify(envelope)}\n`,
      "utf8",
    );
    await symlink(
      outside,
      join(root, ".agent-teams-local"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const status = await inspectDocumentTransactionV1(root);
    assert.equal(status.state, "manual-recovery-required");
    assert.match(status.reason, /redirected|safely/u);
    assert.equal("recovery" in status, false);
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  }
});
