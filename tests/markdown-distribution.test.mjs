import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { version as esbuildVersion } from "esbuild";

import { buildMarkdownDistribution, projectMarkdownManifest } from "../scripts/markdown-distribution.mjs";
import { canonicalMarkdownGraph } from "../scripts/markdown-canonical-graph.mjs";
import { markdownSnapshotPlan } from "../scripts/markdown-source-snapshot.mjs";
import { acquireMarkdownArchives } from "../scripts/markdown-archive-cache.mjs";
import { projectMarkdownPublication } from "../scripts/markdown-publication.mjs";
import { sha256 } from "../scripts/pack-artifact-archive.mjs";
import { tarArchive } from "./pack-publishable-artifacts-support.mjs";

const names = [
  "github-slugger", "mdast-util-to-string", "remark-frontmatter", "remark-gfm",
  "remark-parse", "unified", "unist-util-visit", "vfile",
];

async function fixture(t, { entrySuffix = "", componentName, alternativeEntry = false } = {}) {
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
  const snapshots = {};
  for (const [index, originalName] of names.entries()) {
    const name = componentName !== undefined && index === 0 ? componentName : originalName;
    const root = join(packageRoot, "node_modules", originalName);
    const files = new Map([
      ["package.json", Buffer.from(JSON.stringify({ name, version: "1.0.0", type: "module", exports: "./index.js" }))],
      ["index.js", Buffer.from(`export const value = ${index};\n`)],
      ["LICENSE", Buffer.from("Fixture permission notice.\n")],
    ]);
    if (alternativeEntry && originalName === "unified") {
      files.set("alternative.js", Buffer.from("export const value = 99;\n"));
    }
    await mkdir(root, { recursive: true });
    for (const [path, bytes] of files) { await writeFile(join(root, path), bytes); }
    const archive = tarArchive([...files].map(([path, data]) => ({ name: `package/${path}`, data })));
    const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
    archives.set(integrity, archive);
    packages[`${name}@1.0.0`] = { resolution: { integrity } };
    snapshots[`${name}@1.0.0`] = {};
  }
  await writeFile(join(packageRoot, "dist/adapters/markdown-runtime.js"),
    names.map((name, index) => `export { value as value${index} } from "${name}";`).join("\n") + entrySuffix);
  const sourceLockBytes = Buffer.from(JSON.stringify({ lockfileVersion: "9.0", packages, snapshots,
    importers: { "packages/document-authoring": { dependencies: Object.fromEntries(names.map(name => [name, { version: "1.0.0" }])) } },
  }));
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

test("post-build projection retains notices and SBOM while removing only unreachable private declarations", async (t) => {
  const input = await fixture(t);
  const declaration = "export declare const value5: number;\n";
  await writeFile(join(input.packageRoot, "dist/index.d.ts"), declaration);
  await writeFile(join(input.packageRoot, "dist/index.js"), 'export {value5} from "./adapters/markdown-runtime.js";\n');
  await writeFile(join(input.packageRoot, "dist/adapters/markdown-runtime.d.ts"), 'export * from "unified";\n');
  await writeFile(join(input.packageRoot, "dist/adapters/markdown-runtime.js.map"), "{}");
  const manifestBytes = await readFile(join(input.packageRoot, "package.json"));
  const result = await projectMarkdownPublication(input);
  assert.equal(result.dependencies.unified, undefined);
  assert.equal(result.dependencies["@agent-teams/repository-mutation"], "0.1.0");
  assert.equal(result.dependencies.yaml, "2.8.3");
  assert.deepEqual(await readFile(join(input.packageRoot, "package.json")), manifestBytes);
  assert.equal(await readFile(join(input.packageRoot, "dist/index.d.ts"), "utf8"), declaration);
  await assert.rejects(readFile(join(input.packageRoot, "dist/adapters/markdown-runtime.d.ts")), { code: "ENOENT" });
  await assert.rejects(readFile(join(input.packageRoot, "dist/adapters/markdown-runtime.js.map")), { code: "ENOENT" });
  const proof = JSON.parse(await readFile(join(input.packageRoot, "dist/markdown-distribution-proof.json"), "utf8"));
  const sbom = JSON.parse(await readFile(join(input.packageRoot, "dist/markdown-upstream.cdx.json"), "utf8"));
  const notices = await readFile(join(input.packageRoot, "dist/markdown-upstream-notices.txt"), "utf8");
  assert.equal(proof.outputSha256, sha256(await readFile(join(input.packageRoot, "dist/adapters/markdown-runtime.js"))));
  assert.equal(sbom.specVersion, "1.6");
  assert.equal(sbom.components.length, names.length);
  for (const component of sbom.components) {
    assert.match(component.hashes[0].content, /^[a-f0-9]{128}$/u);
    assert.ok(notices.includes(`${component.name}@${component.version}`));
    assert.equal(component.licenses[0].license.text.content, "Fixture permission notice.\n");
  }
  assert.equal(sbom.metadata.component.purl, "pkg:npm/%40agent-teams/document-authoring@0.1.0");
});

test("projection rejects surviving runtime, type and manifest references before changing files", async (t) => {
  const cases = [
    ["dist/index.js", 'export * from "unified";'],
    ["dist/index.js", 'export * from "unif\\u0069ed/subpath";'],
    ["dist/index.js", 'export const parser = name => import(name);'],
    ["dist/index.d.ts", 'export type Parser = import("unified").Parser;'],
    ["dist/index.d.ts", 'export * from "./adapters/markdown-runtime.js";'],
    ["dist/index.d.ts", '/// <reference types="unified" />\nexport {};'],
    ["dist/index.d.ts", '/// <reference path = "./adapters/markdown-runtime.d.ts" />\nexport {};'],
    ["dist/index.d.ts", '/// <reference resolution-mode="import" types = "unified" />\nexport {};'],
  ];
  for (const [path, text] of cases) {
    const input = await fixture(t);
    const original = await readFile(join(input.packageRoot, "dist/adapters/markdown-runtime.js"));
    await writeFile(join(input.packageRoot, path), text);
    await assert.rejects(projectMarkdownPublication(input), /remaining reference|private Markdown|computed module/u);
    assert.deepEqual(await readFile(join(input.packageRoot, "dist/adapters/markdown-runtime.js")), original);
  }
  const input = await fixture(t);
  await assert.rejects(projectMarkdownPublication({ ...input, manifest: {
    ...input.manifest, exports: { ".": "./dist/adapters/markdown-runtime.js" },
  } }), /private Markdown/u);
  await assert.rejects(projectMarkdownPublication({ ...input, manifest: {
    ...input.manifest, exports: { "./*": "./dist/*" },
  } }), /private Markdown/u);
  await assert.rejects(projectMarkdownPublication({ ...input, manifest: {
    ...input.manifest, imports: { "#parser": "unified" },
  } }), /remaining reference/u);
  const unrelated = { name: "@agent-teams/docs-protocol" };
  assert.equal(await projectMarkdownPublication({ manifest: unrelated }), unrelated);
});

test("archive callbacks cannot add an unchecked declaration reference before projection", async (t) => {
  const input = await fixture(t);
  const original = await readFile(join(input.packageRoot, "dist/adapters/markdown-runtime.js"));
  await assert.rejects(projectMarkdownPublication({ ...input, readArchive: async coordinate => {
    await writeFile(join(input.packageRoot, "dist/index.d.ts"), 'export * from "unified";');
    return input.readArchive(coordinate);
  } }), /remaining reference/u);
  assert.deepEqual(await readFile(join(input.packageRoot, "dist/adapters/markdown-runtime.js")), original);
});

test("installed source and resolution manifests cannot influence lock-authenticated build inputs", async (t) => {
  const source = await fixture(t);
  await writeFile(join(source.packageRoot, "node_modules/unified/index.js"), "export const value = 99;\n");
  const first = await buildMarkdownDistribution(source);
  const metadata = await fixture(t);
  const path = join(metadata.packageRoot, "node_modules/unified/package.json");
  const value = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...value, description: "tampered metadata" }));
  const second = await buildMarkdownDistribution(metadata);
  assert.equal(first.code, second.code);
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(first.code).toString("base64")}`);
  assert.equal(runtime.value5, 5);
});

test("temporary exports redirect restored before verification cannot select a different authentic member", async (t) => {
  const input = await fixture(t, { alternativeEntry: true });
  const path = join(input.packageRoot, "node_modules/unified/package.json");
  const canonical = await readFile(path);
  await writeFile(path, JSON.stringify({ ...JSON.parse(canonical.toString()), exports: "./alternative.js" }));
  let restored = false;
  const result = await buildMarkdownDistribution({ ...input, readArchive: async (coordinate) => {
    if (!restored) { restored = true; await writeFile(path, canonical); }
    return input.readArchive(coordinate);
  } });
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(result.code).toString("base64")}`);
  assert.equal(runtime.value5, 5);
});

test("archive acquisition callbacks cannot substitute installed files into the private snapshot", async (t) => {
  const input = await fixture(t);
  const originalLockSha256 = sha256(input.sourceLockBytes);
  let changed = false;
  const result = await buildMarkdownDistribution({ ...input, readArchive: async (coordinate) => {
    if (!changed) {
      changed = true;
      input.sourceLockBytes.fill(0);
      await writeFile(join(input.packageRoot, "node_modules/unified/index.js"), "export const value = 99;\n");
    }
    return input.readArchive(coordinate);
  } });
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(result.code).toString("base64")}`);
  assert.equal(runtime.value5, 5);
  assert.equal(result.evidence.sourceLockSha256, originalLockSha256);
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
  await assert.rejects(buildMarkdownDistribution(input), /non-entry first-party|Could not resolve/u);
  const dependency = await fixture(t, { componentName: "@agent-teams/repository-mutation" });
  await assert.rejects(buildMarkdownDistribution(dependency), /first-party component cannot|missing original snapshot/u);
});

test("lock authority is bounded and must bind the active bundler and every upstream input", async (t) => {
  const input = await fixture(t);
  for (const sourceLockBytes of [undefined, Buffer.alloc(8 * 1024 * 1024 + 1), Buffer.from("{}")]) {
    await assert.rejects(buildMarkdownDistribution({ ...input, sourceLockBytes }));
  }
  const lock = JSON.parse(input.sourceLockBytes.toString());
  delete lock.packages["unified@1.0.0"];
  await assert.rejects(buildMarkdownDistribution({ ...input, sourceLockBytes: Buffer.from(JSON.stringify(lock)) }),
    /missing original snapshot/u);
});

test("snapshot plan preserves peer context, optional edges and cycles without resolving semver", async (t) => {
  const input = await fixture(t);
  const lock = JSON.parse(input.sourceLockBytes.toString());
  lock.importers["packages/document-authoring"].dependencies.unified.version = "1.0.0(peer@2.0.0)";
  lock.snapshots["unified@1.0.0(peer@2.0.0)"] = {
    dependencies: { vfile: "1.0.0" }, optionalDependencies: { "unist-util-visit": "1.0.0" },
    transitivePeerDependencies: ["this-is-not-a-dependency-edge"],
  };
  lock.snapshots["vfile@1.0.0"] = { dependencies: { unified: "1.0.0(peer@2.0.0)" } };
  const plan = markdownSnapshotPlan(lock);
  assert.equal(plan.nodes.size, names.length);
  assert.deepEqual(plan.nodes.get("unified@1.0.0(peer@2.0.0)").dependencies,
    [["unist-util-visit", "unist-util-visit@1.0.0"], ["vfile", "vfile@1.0.0"]]);
  assert.equal(plan.nodes.get("unified@1.0.0(peer@2.0.0)").version, "1.0.0");
  for (const reference of ["^1.0.0", "npm:other@1.0.0", "link:../x", "file:archive.tgz", "https://example.test/x"]) {
    const invalid = structuredClone(lock);
    invalid.importers["packages/document-authoring"].dependencies.unified.version = reference;
    assert.throws(() => markdownSnapshotPlan(invalid), /unsupported exact dependency reference/u);
  }
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

test("original archive acquisition uses bounded npm workers and becomes a verified offline reader", async (t) => {
  const input = await fixture(t);
  const cacheRoot = join(input.packageRoot, "archive-cache");
  let calls = 0;
  let active = 0;
  let maximum = 0;
  const runNpm = async (args, cwd, options) => {
    calls += 1;
    active += 1;
    maximum = Math.max(maximum, active);
    try {
      assert.ok(args.includes("--ignore-scripts"));
      assert.ok(args.includes("--registry=https://registry.npmjs.org/"));
      assert.equal(options.timeoutMs, 60_000);
      assert.equal(await readFile(args[args.indexOf("--userconfig") + 1], "utf8"), "");
      assert.ok(!Object.keys(options.environment).some(key => /^(?:npm_config_|npm_token$|node_auth_token$)/iu.test(key)));
      const name = args[1].slice(0, args[1].lastIndexOf("@"));
      const lock = JSON.parse(input.sourceLockBytes.toString());
      const integrity = lock.packages[`${name}@1.0.0`].resolution.integrity;
      await writeFile(join(cwd, `${name}-1.0.0.tgz`), input.archives.get(integrity));
    } finally { active -= 1; }
  };
  const readArchive = await acquireMarkdownArchives({ sourceLockBytes: input.sourceLockBytes, cacheRoot, runNpm });
  assert.equal(calls, names.length);
  assert.ok(maximum > 1 && maximum <= 4);
  assert.equal(active, 0);
  const coordinate = markdownSnapshotPlan(JSON.parse(input.sourceLockBytes.toString())).nodes.values().next().value;
  assert.deepEqual(await readArchive(coordinate), input.archives.get(coordinate.integrity));
  await assert.rejects(readArchive({ ...coordinate, version: "9.9.9" }), /not acquired before hermetic/u);
  await acquireMarkdownArchives({ sourceLockBytes: input.sourceLockBytes, cacheRoot, runNpm: () => {
    throw new Error("A verified cache hit must not use the network");
  } });
  await writeFile(join(cacheRoot, `${sha256(coordinate.integrity)}.tgz`), "corrupted cache");
  await assert.rejects(acquireMarkdownArchives({ sourceLockBytes: input.sourceLockBytes, cacheRoot, runNpm }),
    /archive integrity mismatch/u);
});

test("snapshot policy rejects platform-conditioned packages and conflicting optional declarations", async (t) => {
  const input = await fixture(t);
  const lock = JSON.parse(input.sourceLockBytes.toString());
  lock.packages["unified@1.0.0"].os = ["linux"];
  assert.throws(() => markdownSnapshotPlan(lock), /platform-conditioned/u);
  delete lock.packages["unified@1.0.0"].os;
  lock.snapshots["unified@1.0.0"] = { dependencies: { vfile: "1.0.0" }, optionalDependencies: { vfile: "2.0.0" } };
  assert.throws(() => markdownSnapshotPlan(lock), /conflicting dependency edges/u);
});
