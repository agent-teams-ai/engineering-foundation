import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { version as esbuildVersion } from "esbuild";

import { buildMarkdownDistribution, projectMarkdownManifest } from "../scripts/markdown-distribution.mjs";
import { canonicalMarkdownGraph } from "../scripts/markdown-canonical-graph.mjs";
import { sha256 } from "../scripts/pack-artifact-archive.mjs";
import { tarArchive } from "./pack-publishable-artifacts-support.mjs";

const names = [
  "github-slugger", "mdast-util-to-string", "remark-frontmatter", "remark-gfm",
  "remark-parse", "unified", "unist-util-visit", "vfile",
];

async function fixture(t, { entrySuffix = "", componentName } = {}) {
  const packageRoot = await mkdtemp(join(tmpdir(), "markdown-distribution-test-"));
  t.after(() => rm(packageRoot, { recursive: true, force: true }));
  const dependencies = Object.fromEntries(names.map((name) => [name, "1.0.0"]));
  const manifest = {
    name: "@agent-teams/document-authoring", type: "module", version: "0.1.0",
    dependencies: { "@agent-teams/repository-mutation": "0.1.0", ajv: "8.20.0", yaml: "2.8.3", ...dependencies },
  };
  await writeFile(join(packageRoot, "package.json"), JSON.stringify(manifest));
  await mkdir(join(packageRoot, "dist/adapters"), { recursive: true });
  const archives = new Map();
  const packages = { [`esbuild@${esbuildVersion}`]: {} };
  for (const [index, originalName] of names.entries()) {
    const name = componentName !== undefined && index === 0 ? componentName : originalName;
    const root = join(packageRoot, "node_modules", originalName);
    const files = new Map([
      ["package.json", Buffer.from(JSON.stringify({ name, version: "1.0.0", type: "module", exports: "./index.js" }))],
      ["index.js", Buffer.from(`export const value = ${index};\n`)],
      ["LICENSE", Buffer.from("Fixture permission notice.\n")],
    ]);
    await mkdir(root, { recursive: true });
    for (const [path, bytes] of files) { await writeFile(join(root, path), bytes); }
    const archive = tarArchive([...files].map(([path, data]) => ({ name: `package/${path}`, data })));
    const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
    archives.set(integrity, archive);
    packages[`${name}@1.0.0`] = { resolution: { integrity } };
  }
  await writeFile(join(packageRoot, "dist/adapters/markdown-runtime.js"),
    names.map((name, index) => `export { value as value${index} } from "${name}";`).join("\n") + entrySuffix);
  const sourceLockBytes = Buffer.from(JSON.stringify({ lockfileVersion: "9.0", packages }));
  const readArchive = async ({ integrity }) => {
    if (!archives.has(integrity)) { throw new Error("Offline archive missing"); }
    return archives.get(integrity);
  };
  return { archives, manifest, packageRoot, readArchive, sourceLockBytes };
}

test("distribution is deterministic across independent roots and imports without dependencies", async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  const [a, b] = await Promise.all([buildMarkdownDistribution(first), buildMarkdownDistribution(second)]);
  assert.equal(a.code, b.code);
  assert.deepEqual(a.evidence, b.evidence);
  assert.equal(a.evidence.components.length, names.length);
  assert.equal(a.evidence.outputSha256, sha256(a.code));
  assert.equal(a.evidence.sourceLockSha256, sha256(first.sourceLockBytes));
  assert.ok(!a.code.includes(first.packageRoot));
  assert.ok(Object.isFrozen(a));
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(a.code).toString("base64")}`);
  assert.deepEqual(Object.values(runtime), names.map((_, index) => index));
  const projected = projectMarkdownManifest(first.manifest, a);
  assert.deepEqual(projected.dependencies, { "@agent-teams/repository-mutation": "0.1.0", ajv: "8.20.0", yaml: "2.8.3" });
  assert.equal(first.manifest.dependencies.unified, "1.0.0");
  assert.throws(() => projectMarkdownManifest(first.manifest, structuredClone(a)), /authenticated authoring/u);
  assert.throws(() => projectMarkdownManifest({ ...first.manifest, name: "other" }, a), /authenticated authoring/u);
  assert.throws(() => projectMarkdownManifest({ ...first.manifest,
    dependencies: { ...first.manifest.dependencies, unified: "2.0.0" },
  }, a), /exact version/u);
});

test("modified source or resolution manifest cannot pass original-archive authentication", async (t) => {
  const source = await fixture(t);
  await writeFile(join(source.packageRoot, "node_modules/unified/index.js"), "export const value = 99;\n");
  await assert.rejects(buildMarkdownDistribution(source), /upstream bytes differ/u);
  const metadata = await fixture(t);
  const path = join(metadata.packageRoot, "node_modules/unified/package.json");
  const value = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...value, description: "tampered metadata" }));
  await assert.rejects(buildMarkdownDistribution(metadata), /installed manifest differs/u);
});

test("proof authenticates captured build bytes instead of a post-build source reread", async (t) => {
  const input = await fixture(t);
  let changed = false;
  const result = await buildMarkdownDistribution({ ...input, readArchive: async (coordinate) => {
    if (!changed) {
      changed = true;
      await writeFile(join(input.packageRoot, "node_modules/unified/index.js"), "export const value = 99;\n");
    }
    return input.readArchive(coordinate);
  } });
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(result.code).toString("base64")}`);
  assert.equal(runtime.value5, 5);
  assert.equal(result.evidence.components.find(({ name }) => name === "unified").files[0].sha256,
    sha256("export const value = 5;\n"));
});

test("offline archive misses and substituted archive bytes reject without a fallback", async (t) => {
  const input = await fixture(t);
  await assert.rejects(buildMarkdownDistribution({ ...input, readArchive: async () => {
    throw new Error("Offline archive missing");
  } }), /Offline archive missing/u);
  await assert.rejects(buildMarkdownDistribution({ ...input, readArchive: async () => Buffer.from("substituted") }),
    /archive integrity mismatch/u);
});

test("additional first-party modules or Agent Teams packages cannot enter the bundle", async (t) => {
  const input = await fixture(t, { entrySuffix: '\nexport { helper } from "./helper.js";\n' });
  await writeFile(join(input.packageRoot, "dist/adapters/helper.js"), "export const helper = 1;\n");
  await assert.rejects(buildMarkdownDistribution(input), /non-entry first-party/u);
  const dependency = await fixture(t, { componentName: "@agent-teams/repository-mutation" });
  await assert.rejects(buildMarkdownDistribution(dependency), /first-party component cannot/u);
});

test("lock authority is bounded and must bind the active bundler and every upstream input", async (t) => {
  const input = await fixture(t);
  for (const sourceLockBytes of [undefined, Buffer.alloc(8 * 1024 * 1024 + 1), Buffer.from("{}")]) {
    await assert.rejects(buildMarkdownDistribution({ ...input, sourceLockBytes }));
  }
  const lock = JSON.parse(input.sourceLockBytes.toString());
  delete lock.packages["unified@1.0.0"];
  await assert.rejects(buildMarkdownDistribution({ ...input, sourceLockBytes: Buffer.from(JSON.stringify(lock)) }),
    /missing original lock identity/u);
});

test("canonical identity deduplicates copies only when bytes, manifests and outgoing resolutions agree", () => {
  const packageRoot = "/fixture";
  const entry = "/fixture/entry.js";
  const first = "/fixture/node_modules/one";
  const copy = "/fixture/node_modules/parent/node_modules/one";
  const dependency = "/fixture/node_modules/dep";
  const captured = new Map([
    [entry, { bytes: Buffer.from("entry") }],
    [`${first}/index.js`, { bytes: Buffer.from("one"), root: first }],
    [`${copy}/index.js`, { bytes: Buffer.from("one"), root: copy }],
    [`${dependency}/index.js`, { bytes: Buffer.from("dep"), root: dependency }],
  ]);
  const identity = { name: "one", version: "1.0.0", manifestSha256: "a".repeat(64) };
  const identities = new Map([[first, identity], [copy, identity],
    [dependency, { name: "dep", version: "1.0.0", manifestSha256: "b".repeat(64) }]]);
  const edge = { kind: "import-statement", original: "dep", path: "node_modules/dep/index.js" };
  const metafile = { inputs: {
    "entry.js": { imports: [] },
    "node_modules/one/index.js": { imports: [edge] },
    "node_modules/parent/node_modules/one/index.js": { imports: [edge] },
    "node_modules/dep/index.js": { imports: [] },
  } };
  const input = { captured, entry, identities, metafile, packageRoot };
  assert.equal(canonicalMarkdownGraph(input).nodes.size, 3);
  const alteredBytes = new Map(captured).set(`${copy}/index.js`, { bytes: Buffer.from("different"), root: copy });
  assert.throws(() => canonicalMarkdownGraph({ ...input, captured: alteredBytes }), /copies have different/u);
  const alteredManifests = new Map(identities).set(copy, { ...identity, manifestSha256: "c".repeat(64) });
  assert.throws(() => canonicalMarkdownGraph({ ...input, identities: alteredManifests }), /copies have different/u);
  const alteredEdges = structuredClone(metafile);
  alteredEdges.inputs["node_modules/parent/node_modules/one/index.js"].imports = [];
  assert.throws(() => canonicalMarkdownGraph({ ...input, metafile: alteredEdges }), /copies have different/u);
});
