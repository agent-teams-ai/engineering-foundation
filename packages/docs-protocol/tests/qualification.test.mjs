import assert from "node:assert/strict";
import { access, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { planDocumentationDocument } from "../../engineering-foundation/dist/document-authoring/index.js";
import { applyNodeDocumentationPlanPrivately } from "../../engineering-foundation/dist/document-authoring/composition/node-document-writing-private.js";
import { DocsProtocol } from "../dist/application/docs-protocol.js";
import { NodeCodeAnchorMatcher } from "../dist/adapters/node-code-anchor-matcher.js";
import { NodeDocsAdoptionInspector } from "../dist/adapters/node-adoption-inspector.js";
import { NodeDocsProfileReader } from "../dist/adapters/node-profile-reader.js";
import { NodeFoundationDocsPort } from "../dist/adapters/foundation-docs-port.js";
import { runDocsProtocolQualification, runDocsProtocolQualificationV2 } from "../dist/qualification/index.js";
import { overlayLocalDevelopmentSkill } from "../dist/qualification/qualification-v2-runner.js";
import { crashAtDurablePublishing } from "../dist/qualification/crash-driver.js";
import {
  fileSnapshot,
  isQualificationEvidenceExcludedPath,
  isQualificationMutationObservationExcludedPath,
  isQualificationSourceCopyExcludedPath,
  qualificationEvidencePolicy,
  snapshot,
} from "../dist/qualification/filesystem-evidence.js";

const fixtureRoot = new URL("./fixtures/qualification", import.meta.url).pathname;

test("shared qualification runner mutates only its owned disposable copy", async () => {
  const receipt = await runDocsProtocolQualification({
    fixtureRoot,
    scenario: {
      find: { query: { type: "adr" }, expectedIds: [] },
      newDocument: {
        intent: {
          type: "adr",
          id: "ADR-0001",
          title: "Qualification decision",
          owner: "architecture/tooling",
          summary: "Proves the shared disposable qualification workflow."
        }
      }
    }
  });
  assert.equal(receipt.projectId, "docs-protocol-qualification");
  assert.equal(receipt.appliedDocumentPath, "docs/decisions/generated/0001-qualification-decision.md");
  assert.deepEqual(receipt.checks, ["info", "find", "preview", "crash", "doctor", "recover", "receipt", "parent", "apply", "index", "check", "source-unchanged"]);
});

test("v2 qualification rejects unverified released-cohort fixtures", async () => {
  await assert.rejects(
    runDocsProtocolQualificationV2({ consumerRoot: fixtureRoot }),
    /Consumer root must equal the Git repository top-level directory|current exact managed integration/u
  );
});

test("v2 qualification derives managed authority and marks local evidence non-admissible", async () => {
  const receipt = await runDocsProtocolQualificationV2({ consumerRoot: fixtureRoot, localDevelopment: true });
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.evidenceClass, "local-development");
  assert.equal(receipt.cohortAdmissible, false);
  assert.match(receipt.receiptDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(receipt.checks.includes("golden"), false);
  assert.deepEqual(receipt.scenarios.map(({ type }) => type), ["adr"]);
  assert.equal(receipt.derived.contractPath, "architecture/foundation/docs-protocol-qualification.json");
  assert.equal(receipt.derived.gateCommand, "pnpm docs:protocol:check");
});

test("v2 local-development Skill overlay rejects a symlink without touching its target", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-teams-docs-skill-overlay-"));
  const outside = join(temporary, "outside-skill.md");
  const sentinel = "outside must remain unchanged\n";
  try {
    const skillDirectory = join(temporary, ".agents", "skills", "docs-authoring");
    const skill = join(skillDirectory, "SKILL.md");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(outside, sentinel);
    await symlink(outside, skill, "file");
    await assert.rejects(
      overlayLocalDevelopmentSkill(temporary, ".agents/skills/docs-authoring/SKILL.md", true),
      /Local-development qualification Skill target must be one stable, non-hardlinked regular file/u
    );
    assert.equal(await readFile(outside, "utf8"), sentinel);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("v2 qualification excludes transient cache and build output from evidence", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-teams-docs-transient-evidence-"));
  const consumerRoot = join(temporary, "consumer");
  try {
    await cp(fixtureRoot, consumerRoot, { recursive: true, errorOnExist: true, force: false, dereference: false });
    await mkdir(join(consumerRoot, ".cache", "docs-tools"), { recursive: true });
    await mkdir(join(consumerRoot, "agent-runtime", "experiments", "rust-system-boundaries", "target"), { recursive: true });
    await writeFile(join(consumerRoot, ".cache", "docs-tools", "binary"), "cache\n");
    await writeFile(join(consumerRoot, "agent-runtime", "experiments", "rust-system-boundaries", "target", "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n# Cargo build cache\n");
    await writeFile(join(consumerRoot, "agent-runtime", "experiments", "rust-system-boundaries", "target", "artifact"), "build\n");

    const receipt = await runDocsProtocolQualificationV2({ consumerRoot, localDevelopment: true });
    assert.equal(receipt.evidenceClass, "local-development");
    assert.equal(receipt.cohortAdmissible, false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("qualification separates immutable source exclusions from mutation observation", async () => {
  assert.equal(isQualificationSourceCopyExcludedPath(".agent-teams-local/journal.json", "directory"), true);
  assert.equal(isQualificationMutationObservationExcludedPath(".agent-teams-local/journal.json", "directory"), false);
  assert.equal(isQualificationSourceCopyExcludedPath("node_modules/package/index.js", "directory"), true);
  assert.equal(isQualificationMutationObservationExcludedPath("packages/example/node_modules/package/index.js", "directory"), true);
  assert.equal(isQualificationSourceCopyExcludedPath(".git", "file"), true);
  assert.equal(isQualificationMutationObservationExcludedPath("packages/example/node_modules", "file"), true);
  assert.equal(isQualificationSourceCopyExcludedPath("target/output", "directory"), true);
  assert.equal(isQualificationSourceCopyExcludedPath("docs/target/governed.md", "directory"), false);
  assert.equal(isQualificationMutationObservationExcludedPath("docs/.cache/preview-side-effect.md", "directory"), false);

  const temporary = await mkdtemp(join(tmpdir(), "agent-teams-docs-mutation-evidence-"));
  try {
    const root = await realpath(temporary);
    const policy = qualificationEvidencePolicy(["docs"]);
    await mkdir(join(temporary, ".agent-teams-local"), { recursive: true });
    await mkdir(join(temporary, ".cache"), { recursive: true });
    await mkdir(join(temporary, "docs", "target"), { recursive: true });
    await mkdir(join(temporary, "agent-runtime", "experiments", "rust-system-boundaries", "target"), { recursive: true });
    await writeFile(join(temporary, ".agent-teams-local", "preview-side-effect.json"), "{}\n");
    await writeFile(join(temporary, ".cache", "ignored-build-output"), "cache\n");
    await writeFile(join(temporary, "docs", "target", "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n");
    await writeFile(join(temporary, "docs", "target", "governed.md"), "# Governed\n");
    const nestedTarget = "agent-runtime/experiments/rust-system-boundaries/target";
    await writeFile(join(temporary, nestedTarget, "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n# Cargo build cache\n");
    await writeFile(join(temporary, nestedTarget, "2.1gb-equivalent-artifact"), "generated\n");
    assert.equal(await isQualificationEvidenceExcludedPath(root, nestedTarget, policy, "source", "directory"), true);
    assert.equal(await isQualificationEvidenceExcludedPath(root, nestedTarget, policy, "mutation", "directory"), true);
    assert.equal(await isQualificationEvidenceExcludedPath(root, "docs/target", policy, "source", "directory"), false);
    const sourceBefore = await snapshot(root, policy);
    await writeFile(join(temporary, nestedTarget, "2.1gb-equivalent-artifact"), "changed generated\n");
    assert.equal(await snapshot(root, policy), sourceBefore);
    await writeFile(join(temporary, "docs", "target", "governed.md"), "# Governed changed\n");
    assert.notEqual(await snapshot(root, policy), sourceBefore);
    const observation = await fileSnapshot(root, policy);
    assert.equal(observation.has("file:.agent-teams-local/preview-side-effect.json"), true);
    assert.equal(observation.has("file:.cache/ignored-build-output"), false);
    assert.equal(observation.has(`file:${nestedTarget}/2.1gb-equivalent-artifact`), false);
    assert.equal(observation.has("file:docs/target/governed.md"), true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("qualification retains regular files named target and .cache without probing children", async () => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "agent-teams-docs-cache-name-files-")));
  const policy = qualificationEvidencePolicy([]);
  const paths = ["target", ".cache", "packages/example/target", "packages/example/.cache"];
  try {
    await mkdir(join(temporary, "packages", "example"), { recursive: true });
    for (const path of paths) {await writeFile(join(temporary, path), `${path}\n`);}
    for (const path of paths) {
      assert.equal(await isQualificationEvidenceExcludedPath(temporary, path, policy, "source", "file"), false);
      assert.equal(await isQualificationEvidenceExcludedPath(temporary, path, policy, "mutation", "file"), false);
    }
    const sourceBefore = await snapshot(temporary, policy);
    const mutationBefore = await fileSnapshot(temporary, policy);
    for (const path of paths) {assert.equal(mutationBefore.has(`file:${path}`), true);}
    await writeFile(join(temporary, "packages", "example", "target"), "changed\n");
    assert.notEqual(await snapshot(temporary, policy), sourceBefore);
    assert.notEqual((await fileSnapshot(temporary, policy)).get("file:packages/example/target"), mutationBefore.get("file:packages/example/target"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("qualification crash child honors pre-cancellation without materializing inputs", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-teams-docs-cancelled-crash-"));
  try {
    await assert.rejects(
      crashAtDurablePublishing(temporary, {}, AbortSignal.abort()),
      (error) => error?.name === "AbortError",
    );
    await assert.rejects(access(join(temporary, ".qualification-crash-plan.json")), (error) => error?.code === "ENOENT");
    await assert.rejects(access(join(temporary, ".qualification-crash-worker.mjs")), (error) => error?.code === "ENOENT");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("qualification awaits an early crash-child exit before cleaning its inputs", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-teams-docs-early-crash-exit-"));
  const scope = join(temporary, "node_modules", "@agent-teams");
  try {
    await mkdir(scope, { recursive: true });
    await symlink(
      new URL("../../engineering-foundation", import.meta.url).pathname,
      join(scope, "engineering-foundation"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(crashAtDurablePublishing(temporary, {}), /exited before checkpoint/u);
    await assert.rejects(access(join(temporary, ".qualification-crash-plan.json")), (error) => error?.code === "ENOENT");
    await assert.rejects(access(join(temporary, ".qualification-crash-worker.mjs")), (error) => error?.code === "ENOENT");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("qualification cleans its inputs after a crash-child spawn error", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-teams-docs-crash-spawn-error-"));
  const originalExecPath = process.execPath;
  try {
    process.execPath = join(temporary, "missing-node-executable");
    await assert.rejects(
      crashAtDurablePublishing(temporary, {}),
      (error) => error?.code === "ENOENT",
    );
    await assert.rejects(access(join(temporary, ".qualification-crash-plan.json")), (error) => error?.code === "ENOENT");
    await assert.rejects(access(join(temporary, ".qualification-crash-worker.mjs")), (error) => error?.code === "ENOENT");
  } finally {
    process.execPath = originalExecPath;
    await rm(temporary, { recursive: true, force: true });
  }
});

const requiresStrictDirectoryDurability = process.platform === "win32" ? test.skip : test;

requiresStrictDirectoryDurability("recovery uses persisted transaction authority after both mutable profiles are corrupted", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-teams-docs-corrupt-profile-"));
  const consumerRoot = join(temporary, "consumer");
  try {
    await cp(fixtureRoot, consumerRoot, { recursive: true, errorOnExist: true, force: false, dereference: false });
    const plan = await planDocumentationDocument({
      consumerRoot,
      profilePath: "architecture/foundation/document-authoring.yaml",
      parentPolicy: "create-missing-real-directories",
      intent: {
        schemaVersion: 1,
        type: "adr",
        id: "ADR-0002",
        title: "Crash recovery",
        owner: "architecture/tooling",
        summary: "Proves recovery is independent of mutable profiles."
      }
    });
    assert.equal(plan.schemaVersion, 2);
    assert.deepEqual(plan.parentMaterialization.missingDirectories, ["docs/decisions/generated"]);
    const interrupted = await applyNodeDocumentationPlanPrivately(
      { consumerRoot, plan },
      {
        faultInjector(point) {
          if (point.phase === "after-published-journal-durable") {
            throw new Error("simulated process crash after durable publication state");
          }
        }
      }
    );
    assert.equal(interrupted.outcome, "recovery-required");
    await writeFile(join(consumerRoot, "architecture/foundation/docs-protocol.yaml"), "not: [valid\n", "utf8");
    await writeFile(join(consumerRoot, "architecture/foundation/document-authoring.yaml"), "not: [valid\n", "utf8");

    const protocol = new DocsProtocol({
      adoption: new NodeDocsAdoptionInspector(),
      anchors: new NodeCodeAnchorMatcher(),
      foundation: new NodeFoundationDocsPort(),
      profiles: new NodeDocsProfileReader()
    });
    const recovered = await protocol.recover({
      consumerRoot,
      profilePath: "architecture/foundation/docs-protocol.yaml"
    });
    assert.equal(recovered.exitCode, 0, JSON.stringify(recovered.envelope));
    assert.equal(recovered.envelope.result.transactionState, "recovered");
    await lstat(join(consumerRoot, plan.destination));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
