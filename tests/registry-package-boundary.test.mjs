import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  readInstalledPortableDocsSkill
} from "../scripts/registry-installed-docs-skill.mjs";
import {
  isCanonicalPathInside,
  isSameCanonicalPath
} from "../scripts/registry-package-paths.mjs";
import {
  assertWindowsDocsApplyRecovery,
  assertWindowsDocsRecoveryInspection,
  verifyWindowsDocsRecoveryQualification
} from "../scripts/registry-document-authoring-policy.mjs";
import {
  writeDocsProtocolProfileFixture
} from "../scripts/registry-document-authoring-e2e.mjs";
import {
  NodeDocsProfileReader
} from "../packages/docs-protocol/dist/adapters/node-profile-reader.js";

test("registry Docs Profile fixture satisfies the current portable profile policy", async (context) => {
  const consumerRoot = await mkdtemp(join(tmpdir(), "registry-docs-profile-"));
  context.after(() => rm(consumerRoot, { force: true, recursive: true }));
  await mkdir(join(consumerRoot, "architecture", "foundation"), { recursive: true });

  await writeDocsProtocolProfileFixture(consumerRoot);

  const profile = await new NodeDocsProfileReader().read({
    consumerRoot,
    profilePath: "architecture/foundation/docs-protocol.yaml"
  });
  assert.equal(profile.schemaVersion, 3);
  assert.deepEqual(profile.agentWorkflow, {
    adoption: "portable-v1",
    skillPath: ".agents/skills/docs-authoring/SKILL.md"
  });
  assert.equal(profile.foundationProfile.schemaVersion, 3);
  assert.equal(
    profile.foundationProfile.metadataSidecarPolicy,
    "foundation-profile-v3-strict-merge"
  );
});

test("canonical package boundaries use platform path semantics", () => {
  const root = join("registry-root", "node_modules", "@agent-teams", "document-authoring");
  const qualification = join(root, "dist", "qualification", "index.js");

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

test("portable Skill resolves from the qualified installed Docs Protocol root", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "registry-installed-docs-skill-"));
  context.after(() => rm(temporaryRoot, { force: true, recursive: true }));
  const installedRoot = join(temporaryRoot, "nested", "node_modules", "@agent-teams", "docs-protocol");
  await mkdir(join(installedRoot, "dist", "qualification"), { recursive: true });
  await writeFile(join(installedRoot, "package.json"), `${JSON.stringify({
    name: "@agent-teams/docs-protocol",
    type: "module",
    exports: { "./qualification": { import: "./dist/qualification/index.js" } }
  })}\n`, "utf8");
  await writeFile(join(installedRoot, "dist", "qualification", "index.js"),
    "export const portableQualificationSkill = () => Buffer.from('# installed portable skill\\n');\n",
    "utf8");

  assert.equal(
    (await readInstalledPortableDocsSkill(installedRoot)).toString("utf8"),
    "# installed portable skill\n"
  );
});

test("portable Skill rejects an installed qualification export outside its package root", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "registry-installed-docs-skill-escape-"));
  context.after(() => rm(temporaryRoot, { force: true, recursive: true }));
  const installedRoot = join(temporaryRoot, "docs-protocol");
  await mkdir(installedRoot);
  await writeFile(join(temporaryRoot, "outside.js"),
    "export const portableQualificationSkill = () => Buffer.from('outside');\n", "utf8");
  await writeFile(join(installedRoot, "package.json"), `${JSON.stringify({
    name: "@agent-teams/docs-protocol",
    type: "module",
    exports: { "./qualification": { import: "./../outside.js" } }
  })}\n`, "utf8");

  await assert.rejects(
    readInstalledPortableDocsSkill(installedRoot),
    /qualification export escapes its package root/u
  );
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

async function runWindowsEvidenceScenario(context, mutateAfterInspection, prepareTransition) {
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
        const transitionPath = join(stateRoot,
          "scaffolding-transaction.json.document-transition");
        await mkdir(stateRoot);
        await writeFile(join(stateRoot, "foundation-operation.lock"), "", "utf8");
        if (prepareTransition === undefined) {
          await writeFile(transitionPath, "evidence", "utf8");
        } else {
          await prepareTransition({ consumerRoot, stateRoot, transitionPath });
        }
        return windowsRecoveryApply();
      }
      if (args[0] === "doctor") {
        return doctor;
      }
      await mutateAfterInspection?.({
        stateRoot: join(consumerRoot, ".agent-teams-local"),
        transitionPath: join(consumerRoot, ".agent-teams-local",
          "scaffolding-transaction.json.document-transition")
      });
      return recover;
    }
  });
  return { catalogRoot, commands };
}

test("Windows registry qualification inspects preserved evidence without mutation", async (context) => {
  const { catalogRoot, commands } = await runWindowsEvidenceScenario(context);
  assert.deepEqual(commands.map(({ args, exitCode }) => [args[0], exitCode]), [
    ["new", 1], ["doctor", 1], ["recover", 1]
  ]);
  assert.equal(await readFile(join(catalogRoot, "README.md"), "utf8"), "# Catalog\n");
});

test("Windows registry qualification rejects corrupted transition evidence", async (context) => {
  await assert.rejects(runWindowsEvidenceScenario(context, async ({ transitionPath }) => {
    await writeFile(transitionPath, "corrupted", "utf8");
  }), /transition evidence bytes changed/u);
});

test("Windows registry qualification rejects byte-identical transition replacement", async (context) => {
  await assert.rejects(runWindowsEvidenceScenario(context, async ({ stateRoot, transitionPath }) => {
    const replacement = join(stateRoot, "replacement-transition");
    await writeFile(replacement, "evidence", "utf8");
    await rm(transitionPath);
    await rename(replacement, transitionPath);
  }), /file identity changed/u);
});

test("Windows registry qualification rejects extra recovery state entries", async (context) => {
  await assert.rejects(runWindowsEvidenceScenario(context, async ({ stateRoot }) => {
    await writeFile(join(stateRoot, "unexpected-residue"), "unexpected", "utf8");
  }), /unexpected entry census/u);
});

const symlinkEvidenceTest = process.platform === "win32" ? test.skip : test;
symlinkEvidenceTest("Windows registry qualification rejects symlink transition evidence", async (context) => {
  await assert.rejects(runWindowsEvidenceScenario(context, undefined,
    async ({ consumerRoot, transitionPath }) => {
      const target = join(consumerRoot, "outside-transition-evidence");
      await writeFile(target, "evidence", "utf8");
      await symlink(target, transitionPath);
    }), /not a regular physical file/u);
});
