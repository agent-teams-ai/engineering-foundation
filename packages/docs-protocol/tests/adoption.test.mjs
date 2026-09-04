import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NodeDocsAdoptionInspector } from "../dist/adapters/node-adoption-inspector.js";

const fixtureRoot = new URL("./fixtures/portable-qualification", import.meta.url).pathname;
const profilePath = "docs.config.yaml";
const skillPath = ".agents/skills/docs-authoring/SKILL.md";

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "portable-docs-adoption-"));
  await mkdir(join(root, ".agents", "skills", "docs-authoring"), { recursive: true });
  await mkdir(join(root, ".docs-protocol"), { recursive: true });
  for (const path of [profilePath, skillPath, "AGENTS.md", ".docs-protocol/metadata.schema.json"]) {
    await writeFile(join(root, path), await readFile(join(fixtureRoot, path)));
  }
  return root;
}

const inspect = (root) => new NodeDocsAdoptionInspector().inspect({
  policy: "portable-v1",
  authorityPaths: [".docs-protocol/metadata.schema.json"],
  consumerRoot: root,
  profilePath,
  skillPath
});

test("portable adoption accepts only the generic Skill route and contained authorities", async () => {
  const root = await createFixture();
  try {
    assert.deepEqual(await inspect(root), []);
    await writeFile(join(root, "AGENTS.md"), "# Agents\n");
    const diagnostics = await inspect(root);
    assert.ok(diagnostics.some(({ subject }) => subject === "AGENTS.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portable adoption accepts the exact AGENTS route with Windows CRLF lines", async () => {
  const root = await createFixture();
  try {
    const agentsPath = join(root, "AGENTS.md");
    const source = await readFile(agentsPath, "utf8");
    await writeFile(agentsPath, source.replaceAll("\n", "\r\n"), "utf8");
    assert.deepEqual(await inspect(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portable adoption rejects symlinked and hardlinked workflow authority", async () => {
  const symlinkRoot = await createFixture();
  const hardlinkRoot = await createFixture();
  const outside = join(symlinkRoot, "outside-skill.md");
  try {
    await writeFile(outside, await readFile(join(symlinkRoot, skillPath)));
    await rm(join(symlinkRoot, skillPath));
    await symlink(outside, join(symlinkRoot, skillPath), "file");
    assert.ok((await inspect(symlinkRoot)).some(({ subject }) => subject === skillPath));

    await link(join(hardlinkRoot, skillPath), join(hardlinkRoot, "skill-alias.md"));
    assert.ok((await inspect(hardlinkRoot)).some(({ subject }) => subject === skillPath));
  } finally {
    await Promise.all([symlinkRoot, hardlinkRoot].map((root) => rm(root, { recursive: true, force: true })));
  }
});
