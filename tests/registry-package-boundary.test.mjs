import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  isCanonicalPathInside,
  isSameCanonicalPath
} from "../scripts/registry-document-authoring-e2e.mjs";
import {
  assertWindowsDocsApplyRecovery,
  assertWindowsDocsRecoveryInspection,
  verifyWindowsDocsRecoveryQualification
} from "../scripts/registry-document-authoring-policy.mjs";

test("canonical package boundaries use platform path semantics", () => {
  const root = join("registry-root", "node_modules", "@agent-teams", "engineering-foundation");
  const qualification = join(root, "dist", "document-authoring", "qualification", "index.js");

  assert.equal(isSameCanonicalPath(root, root), true);
  assert.equal(isCanonicalPathInside(root, qualification), true);
  assert.equal(isCanonicalPathInside(root, root), false);
  assert.equal(isCanonicalPathInside(root, `${root}-alternate`), false);
  assert.equal(isCanonicalPathInside(root, join(root, "..", "docs-protocol")), false);
});

test("canonical package identity follows Windows drive and casing semantics", {
  skip: process.platform !== "win32"
}, () => {
  assert.equal(
    isSameCanonicalPath("C:\\Registry\\Foundation", "c:\\registry\\foundation"),
    true
  );
  assert.equal(
    isCanonicalPathInside("C:\\Registry\\Foundation", "c:\\registry\\foundation\\dist\\index.js"),
    true
  );
});

test("physical package containment rejects a link that resolves outside", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "registry-package-boundary-"));
  context.after(() => rm(temporaryRoot, { force: true, recursive: true }));
  const packageRoot = join(temporaryRoot, "package");
  const outsideRoot = join(temporaryRoot, "outside");
  await Promise.all([mkdir(packageRoot), mkdir(outsideRoot)]);
  const linkedQualification = join(packageRoot, "qualification");
  await symlink(outsideRoot, linkedQualification, process.platform === "win32" ? "junction" : "dir");

  assert.equal(isCanonicalPathInside(
    await realpath(packageRoot), await realpath(linkedQualification)
  ), false);
});

function windowsRecoveryApply() {
  return {
    command: "docs.new",
    outcome: "recovery-required",
    diagnostics: [{ ruleId: "document.transaction.journal-reconciliation" }],
    result: {
      kind: "new",
      reservation: "none",
      writeState: "unchanged",
      documentPath: "docs/catalog/0050-unified-registry-boundary.md",
      planDigest: `sha256:${"1".repeat(64)}`,
      receiptDigest: `sha256:${"2".repeat(64)}`,
      receiptOutcome: "manual-recovery-required",
      receipt: {
        outcome: "manual-recovery-required",
        commit: {
          state: "manual-recovery-required",
          publication: "none",
          recoverability: "preserved-for-recovery"
        },
        directoryMaterialization: { state: "preserved-unknown" }
      }
    }
  };
}

function windowsRecoveryInspection() {
  const transaction = {
    state: "manual-recovery-required",
    reason: "journal-transition-residue"
  };
  return {
    doctor: {
      command: "docs.doctor",
      outcome: "recovery-required",
      result: {
        environment: { filesystem: { strictDirectoryDurability: "platform-unsupported" } },
        transaction
      }
    },
    recover: {
      command: "docs.recover",
      outcome: "recovery-required",
      result: { transactionState: "manual-required", writeState: "unknown", transaction }
    }
  };
}

test("Windows registry qualification accepts only unchanged manual recovery apply", () => {
  const applied = windowsRecoveryApply();
  assert.doesNotThrow(() => assertWindowsDocsApplyRecovery(
    applied, applied.result.documentPath
  ));
  assert.throws(() => assertWindowsDocsApplyRecovery({
    ...applied,
    result: {
      ...applied.result,
      receipt: {
        ...applied.result.receipt,
        commit: { ...applied.result.receipt.commit, publication: "published" }
      }
    }
  }, applied.result.documentPath), /strict durability recovery contract/u);
});

test("Windows registry qualification requires matching doctor and recover inspection", () => {
  const { doctor, recover } = windowsRecoveryInspection();
  assert.doesNotThrow(() => assertWindowsDocsRecoveryInspection(doctor, recover));
  assert.throws(() => assertWindowsDocsRecoveryInspection(doctor, {
    ...recover,
    result: { ...recover.result, transactionState: "recovered" }
  }), /manual recovery classification/u);
});

test("Windows registry qualification inspects preserved evidence without mutation", async (context) => {
  const consumerRoot = await mkdtemp(join(tmpdir(), "registry-windows-recovery-"));
  context.after(() => rm(consumerRoot, { force: true, recursive: true }));
  const catalogRoot = join(consumerRoot, "docs", "catalog");
  await mkdir(catalogRoot, { recursive: true });
  await writeFile(join(catalogRoot, "README.md"), "# Catalog\n", "utf8");
  const expectedDocumentPath = "docs/catalog/0050-unified-registry-boundary.md";
  const { doctor, recover } = windowsRecoveryInspection();
  const commands = [];
  await verifyWindowsDocsRecoveryQualification({
    applyArguments: ["new", "--apply"],
    consumerRoot,
    expectedDocumentPath,
    async runDocs(args, exitCode) {
      commands.push({ args, exitCode });
      if (args[0] === "new") {
        const stateRoot = join(consumerRoot, ".agent-teams-local");
        await mkdir(stateRoot);
        await writeFile(join(stateRoot,
          "scaffolding-transaction.json.document-transition"), "evidence", "utf8");
        return windowsRecoveryApply();
      }
      return args[0] === "doctor" ? doctor : recover;
    }
  });
  assert.deepEqual(commands.map(({ args, exitCode }) => [args[0], exitCode]), [
    ["new", 1], ["doctor", 1], ["recover", 1]
  ]);
  assert.equal(await readFile(join(catalogRoot, "README.md"), "utf8"), "# Catalog\n");
});
