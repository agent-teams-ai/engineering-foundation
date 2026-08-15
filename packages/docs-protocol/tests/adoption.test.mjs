import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { NodeDocsAdoptionInspector } from "../dist/adapters/node-adoption-inspector.js";

const profilePath = "architecture/foundation/docs-protocol.yaml";
const skillPath = ".agents/skills/docs-authoring/SKILL.md";
const docsRoot = resolve(import.meta.dirname, "..");
const foundationRoot = resolve(import.meta.dirname, "../../engineering-foundation");
const docsManifest = JSON.parse(await readFile(join(docsRoot, "package.json"), "utf8"));
const foundationManifest = JSON.parse(await readFile(join(foundationRoot, "package.json"), "utf8"));
const scripts = Object.fromEntries(["check", "doctor", "find", "info", "new", "recover"].map((command) => [
  `docs:${command}`,
  `agent-teams-docs ${command} --consumer . --profile ${profilePath}`
]));
const canonicalSkill = `# Documentation authoring

Protocol: \`agent-teams.docs-protocol/v1\`.

## Required workflow

- Search first with \`pnpm docs:find -- --text query\`.
- Preview with \`pnpm docs:new -- --type TYPE --id ID --dry-run\`.
- Apply with \`pnpm docs:new -- --type TYPE --id ID --apply\` after review.
- Manually update the reported index/link when reachability requires it.
- Finish with \`pnpm docs:check\` after the index is current.

## Rules

- Treat Foundation profiles as authority.
- Never invent owners, types, statuses, or paths.
- Keep preview and apply inputs identical.
- Stop when recovery is required.
- Resolve required code anchors before apply.
- Advisory anchor misses remain visible warnings.
- Keep related and blocked-by identifiers canonical.
- Do not bypass the repository scripts.
`;

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "docs-adoption-"));
  for (const directory of ["architecture/foundation", ".agents/skills/docs-authoring", "docs", "node_modules/@agent-teams"]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  for (const path of [profilePath, "docs/metadata.schema.json", "docs/owners.yaml"]) {await writeFile(join(root, path), "authority\n");}
  await writeFile(join(root, skillPath), canonicalSkill);
  await writeFile(join(root, "AGENTS.md"), `# Agents\n\nUse [${skillPath}](${skillPath}) for documentation.\n`);
  await writeFile(join(root, "package.json"), JSON.stringify({
    scripts,
    devDependencies: {
      "@agent-teams/docs-protocol": docsManifest.version,
      "@agent-teams/engineering-foundation": foundationManifest.version
    }
  }));
  await symlink(docsRoot, join(root, "node_modules/@agent-teams/docs-protocol"), "dir");
  await symlink(foundationRoot, join(root, "node_modules/@agent-teams/engineering-foundation"), "dir");
  return root;
}

const inspect = (root) => new NodeDocsAdoptionInspector().inspect({
  authorityPaths: ["docs/metadata.schema.json", "docs/owners.yaml"],
  consumerRoot: root,
  profilePath,
  skillPath
});

test("adoption accepts only exact scripts, pins, physical packages, Skill, route, and authorities", async () => {
  const root = await createFixture();
  try {
    assert.deepEqual(await inspect(root), []);
    await writeFile(join(root, "package.json"), JSON.stringify({
      scripts: { ...scripts, "docs:new": "legacy-docs-new" },
      devDependencies: {
        "@agent-teams/docs-protocol": `^${docsManifest.version}`,
        "@agent-teams/engineering-foundation": "latest"
      }
    }));
    const diagnostics = await inspect(root);
    assert.ok(diagnostics.some(({ subject }) => subject.includes("docs:new")));
    assert.ok(diagnostics.some(({ message }) => message.includes("executing version")));
    assert.ok(diagnostics.some(({ message }) => message.includes("executing Foundation version")));
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts, dependencies: {
      "@agent-teams/docs-protocol": docsManifest.version,
      "@agent-teams/engineering-foundation": foundationManifest.version
    } }));
    const production = await inspect(root);
    assert.equal(production.filter(({ message }) => message.includes("tooling-only")).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adoption rejects alternate or missing consumer package resolutions", async () => {
  const docsRootFixture = await createFixture();
  const foundationRootFixture = await createFixture();
  const missingRoot = await createFixture();
  try {
    const installedDocs = join(docsRootFixture, "node_modules/@agent-teams/docs-protocol");
    await rm(installedDocs, { recursive: true, force: true });
    await mkdir(installedDocs, { recursive: true });
    await writeFile(join(installedDocs, "package.json"), JSON.stringify({
      name: "@agent-teams/docs-protocol",
      version: docsManifest.version,
      exports: { "./package.json": "./package.json" }
    }));
    const alternate = await inspect(docsRootFixture);
    assert.ok(alternate.some(({ message }) => message.includes("physical Docs Protocol package")));
    const installedFoundation = join(foundationRootFixture, "node_modules/@agent-teams/engineering-foundation");
    await rm(installedFoundation, { recursive: true, force: true });
    await mkdir(installedFoundation, { recursive: true });
    await writeFile(join(installedFoundation, "package.json"), JSON.stringify({
      name: "@agent-teams/engineering-foundation",
      version: foundationManifest.version,
      exports: { "./package.json": "./package.json" }
    }));
    const alternateFoundation = await inspect(foundationRootFixture);
    assert.ok(alternateFoundation.some(({ message }) => message.includes("same physical Foundation build")));
    await rm(join(missingRoot, "node_modules/@agent-teams/engineering-foundation"), { recursive: true, force: true });
    const missing = await inspect(missingRoot);
    assert.ok(missing.some(({ subject }) => subject === "node_modules/@agent-teams"));
  } finally {
    await Promise.all([docsRootFixture, foundationRootFixture, missingRoot].map((root) => rm(root, { recursive: true, force: true })));
  }
});

test("adoption rejects malformed, oversized, symlinked, and non-canonical workflow inputs", async () => {
  const malformedRoot = await createFixture();
  const oversizedRoot = await createFixture();
  const workflowRoot = await createFixture();
  try {
    await writeFile(join(malformedRoot, "package.json"), "{not-json\n");
    assert.ok((await inspect(malformedRoot)).some(({ subject }) => subject === "package.json"));
    await writeFile(join(malformedRoot, "package.json"), '{"scripts":{},"scripts":{},"devDependencies":{}}');
    assert.ok((await inspect(malformedRoot)).some(({ message }) => message.includes("duplicate keys")));
    await writeFile(join(oversizedRoot, "package.json"), `${" ".repeat(1024 * 1024)}{}`);
    assert.ok((await inspect(oversizedRoot)).some(({ message }) => message.includes("at most")));
    await writeFile(join(workflowRoot, skillPath), canonicalSkill.replace("agent-teams.docs-protocol/v1", "agent-teams.docs-protocol/v2"));
    let diagnostics = await inspect(workflowRoot);
    assert.ok(diagnostics.some(({ message }) => message.includes("exactly agent-teams.docs-protocol/v1")));
    await writeFile(join(workflowRoot, skillPath), canonicalSkill.split("\n").slice(0, 18).join("\n") + "\n");
    diagnostics = await inspect(workflowRoot);
    assert.ok(diagnostics.some(({ message }) => message.includes("between 20 and 30 lines")));
    await writeFile(join(workflowRoot, skillPath), canonicalSkill.replace("--dry-run", "--apply"));
    await writeFile(join(workflowRoot, "AGENTS.md"), `See ${skillPath}.\n`);
    diagnostics = await inspect(workflowRoot);
    assert.ok(diagnostics.some(({ message }) => message.includes("unique ordered")));
    assert.ok(diagnostics.some(({ message }) => message.includes("exactly one route")));
    const outside = join(dirname(workflowRoot), `${workflowRoot.split("/").at(-1)}-outside-skill.md`);
    await writeFile(outside, canonicalSkill);
    await rm(join(workflowRoot, skillPath));
    await symlink(outside, join(workflowRoot, skillPath));
    diagnostics = await inspect(workflowRoot);
    assert.ok(diagnostics.some(({ subject, message }) => subject === skillPath && message.includes("real file")));
    await rm(outside, { force: true });
  } finally {
    await Promise.all([malformedRoot, oversizedRoot, workflowRoot].map((root) => rm(root, { recursive: true, force: true })));
  }
});
