import assert from "node:assert/strict";
import { cp, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  overlayLocalDevelopmentSkill
} from "../dist/qualification/adapters/outbound/node-managed-qualification.js";

import { runDocsProtocolQualificationV2 } from "../dist/qualification/index.js";

const fixtureRoot = new URL("./fixtures/qualification", import.meta.url).pathname;

test("managed qualification rejects an unverified released-Cohort fixture", async () => {
  await assert.rejects(
    runDocsProtocolQualificationV2({ consumerRoot: fixtureRoot }),
    /Consumer root must equal the Git repository top-level directory|current exact managed integration|exact executing Agent Teams adapter/u
  );
});

test("managed qualification imports the portable public contract and marks local evidence non-admissible", async () => {
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

test("managed local-development Skill overlay rejects a symlink without touching its target", async () => {
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

test("managed local-development Skill overlay rejects a hardlink without touching its peer", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-teams-docs-skill-hardlink-"));
  const outside = join(temporary, "outside-skill.md");
  const sentinel = "hardlink peer must remain unchanged\n";
  try {
    const skillDirectory = join(temporary, ".agents", "skills", "docs-authoring");
    const skill = join(skillDirectory, "SKILL.md");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(outside, sentinel);
    await link(outside, skill);
    await assert.rejects(
      overlayLocalDevelopmentSkill(temporary, ".agents/skills/docs-authoring/SKILL.md", true),
      /Local-development qualification Skill target must be one stable, non-hardlinked regular file/u
    );
    assert.equal(await readFile(outside, "utf8"), sentinel);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("managed qualification honors pre-cancellation before disposable mutation", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(
    runDocsProtocolQualificationV2({ consumerRoot: fixtureRoot, localDevelopment: true, signal: controller.signal }),
    { name: "AbortError" }
  );
});

test("managed qualification excludes transient cache and tagged build output from evidence", async () => {
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
