import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyPortableBootstrap,
  compilePortableBootstrap,
  inspectPortableBootstrap,
  recoverPortableBootstrap
} from "../dist/features/portable-bootstrap/composition/portable-bootstrap.js";
import { compileKnownFileTransactionPlan } from "@agent-teams/repository-mutation";
import { applyKnownFileTransaction } from "@agent-teams/repository-mutation/qualification";
import { NodeDocsProfileReader } from "../dist/features/portable-documentation/adapters/outbound/node-profile-reader.js";
import { NodeDocsAdoptionInspector } from "../dist/features/portable-documentation/adapters/outbound/node-adoption-inspector.js";
import { DOCS_ADOPTION_MAX_ROUTING_BYTES } from "../dist/features/portable-documentation/application/model.js";
import { docsCheckV2, docsInfoV2, docsNewV2 } from "../dist/features/docs-command/sdk.js";

const input = (consumerRoot, mode = "dry-run") => ({
  consumerRoot,
  projectId: "portable-fixture",
  ownerId: "docs/platform",
  mode
});

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "docs-portable-bootstrap-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("portable bootstrap compiles a bounded deterministic create-only plan", async () => fixture(async (root) => {
  const first = await compilePortableBootstrap(input(root));
  const second = await compilePortableBootstrap(input(root));

  assert.deepEqual(first, second);
  assert.equal(first.outcome, "change-required");
  assert.equal(first.files.length, 17);
  assert.ok(first.files.length <= 32);
  assert.equal(JSON.parse(first.transactionPlan.serializedPlan).operations.length, 17);
  assert.equal(first.files.find(({ path }) => path === "AGENTS.md").ownership, "managed-block");
  assert.ok(first.files.filter(({ path }) => path !== "AGENTS.md").every(({ ownership }) =>
    ownership === "create-only"
  ));
}));

test("bootstrap rejects invalid modes from untyped callers before filesystem access", async () => {
  for (const mode of ["preview", "APPLY", "", null, undefined, false, 2]) {
    await assert.rejects(compilePortableBootstrap({ ...input("/unobserved-consumer"), mode }), {
      name: "TypeError", message: "mode must be dry-run or apply."
    });
  }
});

test("apply is atomic, preserves AGENTS.md exterior bytes, and reruns idempotently", async () => fixture(async (root) => {
  const exterior = Buffer.from("# Local rules\r\n\r\nKeep this byte-for-byte.\r\n", "utf8");
  await writeFile(join(root, "AGENTS.md"), exterior);
  const dry = await compilePortableBootstrap(input(root));
  const applied = await applyPortableBootstrap({
    ...input(root, "apply"),
    expectedPlanDigest: dry.planDigest
  });

  assert.equal(applied.outcome, "applied");
  assert.equal(applied.receipt.outcome, "applied");
  assert.equal(applied.receipt.planDigest, dry.transactionPlan.planDigest);
  const agents = await readFile(join(root, "AGENTS.md"));
  assert.ok(agents.subarray(0, exterior.length).equals(exterior));
  assert.match(agents.toString("utf8"), /agent-teams:portable-docs:start/u);
  assert.match(
    agents.toString("utf8"),
    /^Use \[\.agents\/skills\/docs-authoring\/SKILL\.md\]\(\.agents\/skills\/docs-authoring\/SKILL\.md\) for documentation\.$/mu
  );
  assert.equal(applied.plan.outcome, "change-required");
  assert.equal(applied.plan.planDigest, dry.planDigest);

  const config = await readFile(join(root, "docs.config.yaml"), "utf8");
  assert.match(config, /^schemaVersion: 4$/mu);
  assert.doesNotMatch(config, /^projectId:/mu);
  const profile = await new NodeDocsProfileReader().read({
    consumerRoot: root,
    profilePath: "docs.config.yaml"
  });
  assert.equal(profile.adoptionPolicy, "portable-v1");
  assert.equal(profile.schemaVersion, 4);
  assert.deepEqual(profile.relations.blockers, {
    types: ["adr", "explanation", "how-to", "reference", "tutorial"],
    statuses: ["proposed"],
    subjectIncompatibleStatuses: ["accepted", "active", "deprecated", "superseded"]
  });
  const skill = await readFile(join(root, ".agents/skills/docs-authoring/SKILL.md"), "utf8");
  assert.match(skill, /docs-protocol find .*--text QUERY/u);
  assert.equal(skill.includes("--query"), false);
  assert.equal((skill.match(/--id ID --title "TITLE" --owner OWNER_ID --summary "SUMMARY"/gu) ?? []).length, 2);
  assert.match(skill, /manual-required.*markdownLink.*indexPath/u);
  assert.match(skill, /--apply --expect sha256:PLAN_DIGEST_FROM_DRY_RUN/u);
  const info = await docsInfoV2({ consumerRoot: root, profilePath: "docs.config.yaml" });
  assert.equal(info.envelope.diagnostics.some(({ severity }) => severity === "error"), false);

  const current = await compilePortableBootstrap(input(root));
  assert.equal(current.outcome, "current");
  assert.notEqual(current.planDigest, dry.planDigest);
  const rerun = await applyPortableBootstrap({
    ...input(root, "apply"),
    expectedPlanDigest: current.planDigest
  });
  assert.equal(rerun.outcome, "current");
  assert.ok((await readFile(join(root, "AGENTS.md"))).equals(agents));
  assert.equal((await inspectPortableBootstrap({ consumerRoot: root })).state, "idle");
}));

test("portable adoption accepts the exact route for a custom profile Skill path", async () => fixture(async (root) => {
  const preview = await compilePortableBootstrap(input(root));
  await applyPortableBootstrap({
    ...input(root, "apply"),
    expectedPlanDigest: preview.planDigest
  });
  const customSkillPath = ".agents/skills/custom-documentation/SKILL.md";
  await mkdir(join(root, ".agents/skills/custom-documentation"), { recursive: true });
  await writeFile(
    join(root, customSkillPath),
    await readFile(join(root, ".agents/skills/docs-authoring/SKILL.md"))
  );
  await writeFile(
    join(root, "AGENTS.md"),
    `Use [${customSkillPath}](${customSkillPath}) for documentation.\n`
  );

  const diagnostics = await new NodeDocsAdoptionInspector().inspect({
    authorityPaths: [
      ".docs-protocol/document-authoring.yaml",
      ".docs-protocol/metadata.schema.json",
      ".docs-protocol/owners.yaml"
    ],
    consumerRoot: root,
    policy: "portable-v1",
    profilePath: "docs.config.yaml",
    skillPath: customSkillPath
  });
  assert.deepEqual(diagnostics, []);
  const customSkill = await readFile(join(root, customSkillPath), "utf8");
  await writeFile(
    join(root, customSkillPath),
    customSkill.replace(
      "If the result is `manual-required`, add its exact `markdownLink` to its exact `indexPath` before verification.",
      "Continue after apply."
    )
  );
  const missingReachability = await new NodeDocsAdoptionInspector().inspect({
    authorityPaths: [
      ".docs-protocol/document-authoring.yaml",
      ".docs-protocol/metadata.schema.json",
      ".docs-protocol/owners.yaml"
    ],
    consumerRoot: root,
    policy: "portable-v1",
    profilePath: "docs.config.yaml",
    skillPath: customSkillPath
  });
  assert.ok(missingReachability.some(({ message }) => message.includes("manual reachability")));
}));

test("bootstrapped ADR lifecycle accepts accepted only after manual reachability is applied", async () => fixture(async (root) => {
  const bootstrap = await compilePortableBootstrap(input(root));
  await applyPortableBootstrap({
    ...input(root, "apply"),
    expectedPlanDigest: bootstrap.planDigest
  });
  const request = {
    consumerRoot: root,
    profilePath: "docs.config.yaml",
    intent: {
      type: "adr",
      id: "ADR-0001",
      title: "Portable lifecycle",
      owner: "docs/platform",
      summary: "Proves the portable ADR lifecycle."
    }
  };
  const preview = await docsNewV2({ ...request, apply: false });
  assert.equal(preview.envelope.result.writeState, "preview");
  assert.deepEqual(preview.envelope.result.reachability, {
    state: "manual-required",
    indexPath: "docs/decisions/README.md",
    markdownLink: "[ADR-0001: Portable lifecycle](0001-portable-lifecycle.md)"
  });
  const applied = await docsNewV2({ ...request, apply: true });
  assert.equal(applied.envelope.result.writeState, "applied");
  const reachability = preview.envelope.result.reachability;
  const index = join(root, reachability.indexPath);
  await writeFile(
    index,
    `${(await readFile(index, "utf8")).trimEnd()}\n\n${reachability.markdownLink}\n`
  );
  const document = join(root, preview.envelope.result.documentPath);
  const proposed = await readFile(document, "utf8");
  assert.match(proposed, /^status: proposed$/mu);
  await writeFile(document, proposed.replace(/^status: proposed$/mu, "status: accepted"));

  const accepted = await docsCheckV2({ consumerRoot: root, profilePath: "docs.config.yaml" });
  assert.equal(accepted.envelope.outcome, "success");
  assert.equal(accepted.envelope.diagnostics.some(({ severity }) => severity === "error"), false);

  await writeFile(join(root, "docs/tutorials/accepted-is-invalid.md"), `---
id: docs.tutorial.accepted-is-invalid
type: tutorial
status: accepted
owner: docs/platform
summary: Accepted remains ADR-only.
---

# Accepted is invalid here
`);
  const invalidDiataxis = await docsCheckV2({
    consumerRoot: root,
    profilePath: "docs.config.yaml"
  });
  assert.notEqual(invalidDiataxis.envelope.outcome, "success");
  assert.ok(invalidDiataxis.envelope.diagnostics.some(({ severity }) => severity === "error"));
}));

test("apply requires the exact dry-run digest", async () => fixture(async (root) => {
  await assert.rejects(
    applyPortableBootstrap({ ...input(root, "apply"), expectedPlanDigest: `sha256:${"0".repeat(64)}` }),
    /Plan is stale/u
  );
  await assert.rejects(readFile(join(root, "docs.config.yaml")), /ENOENT/u);
}));

test("apply rejects an AGENTS.md preimage changed after preview", async () => fixture(async (root) => {
  await writeFile(join(root, "AGENTS.md"), "# Initial rules\n");
  const dry = await compilePortableBootstrap(input(root));
  await writeFile(join(root, "AGENTS.md"), "# Changed after preview\n");

  await assert.rejects(
    applyPortableBootstrap({
      ...input(root, "apply"),
      expectedPlanDigest: dry.planDigest
    }),
    /Plan is stale/u
  );
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "# Changed after preview\n");
  await assert.rejects(readFile(join(root, "docs.config.yaml")), /ENOENT/u);
}));

test("a conflicting create-only target blocks every write", async () => fixture(async (root) => {
  await writeFile(join(root, "docs.config.yaml"), "local: true\n");
  const compiled = await compilePortableBootstrap(input(root));

  assert.equal(compiled.outcome, "blocked");
  assert.equal(compiled.transactionPlan, undefined);
  await assert.rejects(
    applyPortableBootstrap({
      ...input(root, "apply"),
      expectedPlanDigest: compiled.planDigest
    }),
    /blocked by conflicting/u
  );
  await assert.rejects(readFile(join(root, ".docs-protocol/owners.yaml")), /ENOENT/u);
  assert.equal(await readFile(join(root, "docs.config.yaml"), "utf8"), "local: true\n");
}));

test("duplicate or modified AGENTS.md markers fail closed", async () => fixture(async (root) => {
  await writeFile(join(root, "AGENTS.md"), [
    "<!-- agent-teams:portable-docs:start -->",
    "locally modified",
    "<!-- agent-teams:portable-docs:end -->",
    "<!-- agent-teams:portable-docs:start -->"
  ].join("\n"));

  const compiled = await compilePortableBootstrap(input(root));
  assert.equal(compiled.outcome, "blocked");
  assert.deepEqual(compiled.issues.map(({ code }) => code), [
    "PORTABLE_BOOTSTRAP_INVALID_AGENTS_MARKERS"
  ]);
}));

test("bootstrap enforces the shared AGENTS.md routing bound on exact final bytes", async () => {
  const block = [
    "<!-- agent-teams:portable-docs:start -->",
    "Use [.agents/skills/docs-authoring/SKILL.md](.agents/skills/docs-authoring/SKILL.md) for documentation.",
    "<!-- agent-teams:portable-docs:end -->"
  ].join("\n");
  const addition = Buffer.from(`\n\n${block}\n`, "utf8");
  await fixture(async (root) => {
    await writeFile(join(root, "AGENTS.md"), Buffer.alloc(DOCS_ADOPTION_MAX_ROUTING_BYTES - addition.byteLength, 0x61));
    const boundary = await compilePortableBootstrap(input(root));
    assert.equal(boundary.outcome, "change-required");
    assert.equal(
      JSON.parse(boundary.transactionPlan.serializedPlan).operations.find(({ path }) => path === "AGENTS.md").postimage.size,
      DOCS_ADOPTION_MAX_ROUTING_BYTES
    );
  });
  await fixture(async (root) => {
    await writeFile(join(root, "AGENTS.md"), Buffer.alloc(DOCS_ADOPTION_MAX_ROUTING_BYTES - addition.byteLength + 1, 0x61));
    const oversized = await compilePortableBootstrap(input(root));
    assert.equal(oversized.outcome, "blocked");
    assert.equal(oversized.transactionPlan, undefined);
    assert.equal(oversized.issues.at(-1).code, "PORTABLE_BOOTSTRAP_AGENTS_TOO_LARGE");
    await assert.rejects(readFile(join(root, "docs.config.yaml")), /ENOENT/u);
  });
});

test("bootstrap rejects symlinked and non-regular targets before reading them", async () => {
  await fixture(async (root) => {
    await symlink(join(tmpdir(), "portable-bootstrap-outside-secret"), join(root, "docs.config.yaml"));
    await assert.rejects(compilePortableBootstrap(input(root)), /real regular file/u);
  });
  await fixture(async (root) => {
    await mkdir(join(root, "docs.config.yaml"));
    await assert.rejects(compilePortableBootstrap(input(root)), /real regular file/u);
  });
});

test("bootstrap rejects symlinked consumer roots and repository ancestors", async () => {
  if (process.platform === "win32") {return;}
  await fixture(async (donor) => {
    const donorPlan = await compilePortableBootstrap(input(donor));
    await applyPortableBootstrap({
      ...input(donor, "apply"),
      expectedPlanDigest: donorPlan.planDigest
    });
    await fixture(async (target) => {
      await symlink(join(donor, ".docs-protocol"), join(target, ".docs-protocol"));
      await assert.rejects(
        compilePortableBootstrap(input(target)),
        /unsafe repository ancestor/u
      );
    });
    const linkedRoot = `${donor}-linked-root`;
    await symlink(donor, linkedRoot);
    try {
      await assert.rejects(
        compilePortableBootstrap(input(linkedRoot)),
        /consumerRoot must be one real directory/u
      );
    } finally {
      await rm(linkedRoot, { force: true });
    }
  });
});

test("bootstrap planning rejects hard links and portable name aliases", async () => {
  if (process.platform === "win32") {return;}
  await fixture(async (root) => {
    const plan = await compilePortableBootstrap(input(root));
    await applyPortableBootstrap({
      ...input(root, "apply"),
      expectedPlanDigest: plan.planDigest
    });
    await link(join(root, "docs.config.yaml"), join(root, "docs.config.alias"));
    await assert.rejects(
      compilePortableBootstrap(input(root)),
      /multiple hard links/u
    );
  });
  await fixture(async (root) => {
    await writeFile(join(root, "DOCS.CONFIG.YAML"), "alias\n");
    await assert.rejects(
      compilePortableBootstrap(input(root)),
      /case or Unicode path alias/u
    );
  });
});

for (const [name, bytes] of [
  ["invalid UTF-8", Buffer.from([0xff])],
  ["UTF-8 BOM", Buffer.from("\uFEFFlocal\n", "utf8")],
  ["NUL", Buffer.from("local\u0000rules\n", "utf8")]
]) {
  test(`bootstrap blocks AGENTS.md with ${name}`, async () => fixture(async (root) => {
    await writeFile(join(root, "AGENTS.md"), bytes);
    const compiled = await compilePortableBootstrap(input(root));
    assert.equal(compiled.outcome, "blocked");
    assert.equal(compiled.issues.at(-1).code, "PORTABLE_BOOTSTRAP_INVALID_AGENTS_MARKERS");
  }));
}

test("portable recovery routes an interrupted known-file transaction", async () => fixture(async (root) => {
  const plan = compileKnownFileTransactionPlan({ operations: [{
    path: "recovery-fixture.txt",
    precondition: { state: "absent" },
    postimage: { bytes: Buffer.from("postimage\n", "utf8") }
  }] });
  await assert.rejects(applyKnownFileTransaction({
    consumerRoot: root,
    plan,
    faultInjector(point) {
      if (point.phase === "after-temporary-authorized") {
        throw new Error("injected portable bootstrap crash");
      }
    }
  }), /injected portable bootstrap crash/u);
  assert.equal((await inspectPortableBootstrap({ consumerRoot: root })).state, "recovery-required");

  const receipt = await recoverPortableBootstrap({ consumerRoot: root });
  assert.equal(receipt.outcome, "rolled-back");
  assert.equal((await inspectPortableBootstrap({ consumerRoot: root })).state, "idle");
}));

test("bootstrap planning uses injected observations and transaction compilation", async () => {
  const observed = [];
  let operations;
  const ports = {
    repository: {
      async canonicalRoot(root) { assert.equal(root, "/virtual-bootstrap"); return root; },
      async observe(root, path) { assert.equal(root, "/virtual-bootstrap"); observed.push(path); }
    },
    transactions: {
      compile(inputOperations) { operations = inputOperations; return { planDigest: `sha256:${"1".repeat(64)}`, serializedPlan: "{}" }; }
    }
  };
  const result = await (await import("../dist/features/portable-bootstrap/application/portable-bootstrap.js")).compilePortableBootstrap(input("/virtual-bootstrap"), ports);
  assert.equal(result.outcome, "change-required");
  assert.equal(observed.length, 17);
  assert.equal(operations.length, 17);
  assert.equal(typeof operations[0].postimage.contentBase64, "string");
});
