import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { parseSync, Visitor } from "oxc-parser";
import { parse } from "yaml";

import { acquireMarkdownArchives } from "./markdown-archive-cache.mjs";
import { buildMarkdownDistribution, projectMarkdownManifest } from "./markdown-distribution.mjs";
import { markdownDependencies } from "./markdown-source-snapshot.mjs";
import { boundedDirectoryEntries, canonicalPublishManifest, materializeStableTree, npmPackManifest,
  readBoundedStableJson, readStableRegularFile } from "./pack-artifact-stage-support.mjs";
import { PUBLISHABLE_PACKAGES } from "./publishable-packages.mjs";

const authoringName = "@agent-teams/document-authoring";
const runtimePath = "dist/adapters/markdown-runtime.js";
const privateArtifacts = new Set([
  "dist/adapters/markdown-runtime.d.ts", "dist/adapters/markdown-runtime.d.ts.map", `${runtimePath}.map`,
]);

function fail(reason) { throw new Error(`Markdown publication is invalid: ${reason}.`); }

function assertNoRemovedReference(specifier, declaration) {
  if (typeof specifier !== "string") { fail("computed module references cannot be qualified"); }
  if (markdownDependencies.some(name => specifier === name || specifier.startsWith(`${name}/`))) {
    fail(`remaining reference to bundled dependency ${specifier}`);
  }
  if (declaration && /(?:^|\/)markdown-runtime(?:\.d\.ts|\.js)?(?:\.map)?$/u.test(specifier)) {
    fail("public declarations or exports reference the private Markdown adapter");
  }
  if (declaration && specifier.includes("*")) {
    const pattern = new RegExp(`^${specifier.split("*").map(part => RegExp.escape(part)).join(".*")}$`, "u");
    if ([runtimePath, ...privateArtifacts].some(path => pattern.test(`./${path}`))) {
      fail("public export pattern exposes the private Markdown adapter");
    }
  }
}

function assertSourceReferences(path, bytes) {
  const parsed = parseSync(path, new TextDecoder("utf-8", { fatal: true }).decode(bytes), { astType: "ts" });
  if (parsed.errors.length > 0) { fail(`cannot parse ${path}`); }
  const declaration = path.endsWith(".d.ts");
  const reference = node => assertNoRemovedReference(node?.value, declaration);
  new Visitor({
    ImportDeclaration: node => reference(node.source),
    ExportAllDeclaration: node => reference(node.source),
    ExportNamedDeclaration: node => { if (node.source !== null) { reference(node.source); } },
    ImportExpression: node => reference(node.source),
    TSImportType: node => reference(node.source),
    TSImportEqualsDeclaration: node => {
      if (node.moduleReference.type === "TSExternalModuleReference") { reference(node.moduleReference.expression); }
    },
    CallExpression: node => {
      if (node.callee.type === "Identifier" && node.callee.name === "require") { reference(node.arguments[0]); }
    },
  }).visit(parsed.program);
  // Triple-slash type references are comments, not AST import declarations.
  for (const comment of parsed.comments) {
    for (const tag of comment.value.matchAll(/<reference\b[^>]*>/gu)) {
      for (const match of tag[0].matchAll(/\b(?:types|path)\s*=\s*["']([^"']+)["']/gu)) {
        assertNoRemovedReference(match[1], true);
      }
    }
  }
}

async function qualifyRemainingFiles(packageRoot, manifest) {
  const state = { bytes: 0, entries: 0 };
  const visit = async (path, depth) => {
    if (depth > 32) { fail("distribution tree exceeds traversal bound"); }
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) { fail("distribution tree contains a symlink"); }
    if (metadata.isDirectory()) {
      for (const entry of await boundedDirectoryEntries(path, "Markdown distribution", state)) {
        await visit(join(path, entry.name), depth + 1);
      }
    } else if (metadata.isFile()) {
      const name = relative(packageRoot, path).split(sep).join("/");
      const { bytes } = await readStableRegularFile(path, state, "Markdown distribution member");
      if (name !== runtimePath && !privateArtifacts.has(name) && /\.(?:[cm]?js|d\.ts)$/u.test(name)) {
        assertSourceReferences(name, bytes);
      }
    } else { fail("distribution tree contains a special file"); }
  };
  await visit(join(packageRoot, "dist"), 0);
  const checkExport = value => {
    if (typeof value === "string") { assertNoRemovedReference(value, true); }
    else if (value !== null && typeof value === "object") { Object.values(value).forEach(checkExport); }
  };
  [manifest.exports, manifest.imports, manifest.typesVersions, manifest.types, manifest.typings, manifest.main, manifest.bin].forEach(checkExport);
}

const purl = ({ name, version }) => `pkg:npm/${name.replace("@", "%40")}@${version}`;

export function markdownSbom(manifest, evidence) {
  return {
    $schema: "http://cyclonedx.org/schema/bom-1.6.schema.json", bomFormat: "CycloneDX", specVersion: "1.6", version: 1,
    metadata: { component: { type: "library", name: manifest.name, version: manifest.version, purl: purl(manifest) } },
    components: evidence.components.map(component => ({
      type: "library", "bom-ref": purl(component), name: component.name, version: component.version, purl: purl(component),
      scope: "required", hashes: [{ alg: "SHA-512", content: Buffer.from(component.integrity.slice(7), "base64").toString("hex") }],
      licenses: component.licenses.map(license => ({ license: {
        name: `Retained upstream notice: ${license.path}`, text: { contentType: "text/plain", content: license.text },
      } })),
      properties: [{ name: "agent-teams:distribution", value: "embedded in the Markdown adapter, not eliminated" }],
    })),
    properties: [
      { name: "agent-teams:source-lock-sha256", value: evidence.sourceLockSha256 },
      { name: "agent-teams:markdown-output-sha256", value: evidence.outputSha256 },
    ],
  };
}

// Invoke only on an owned disposable post-build tree, before sealing its payload.
// Every stage rebuilds independently from its own compiled entry and original lock.
export async function projectMarkdownPublication({ packageRoot, manifest, sourceLockBytes, readArchive }) {
  if (manifest.name !== authoringName) { return manifest; }
  const distribution = await buildMarkdownDistribution({ packageRoot, sourceLockBytes, readArchive });
  // Archive callbacks have finished; they cannot invalidate an earlier scan.
  await qualifyRemainingFiles(packageRoot, manifest);
  const projected = projectMarkdownManifest(manifest, distribution);
  const notices = distribution.evidence.components.map(component =>
    `${component.name}@${component.version}\n${component.integrity}\n\n${component.licenses.map(license =>
      `${license.path}${license.source === undefined ? "" : ` (${license.source})`}\n${license.text}`).join("\n\n")}`,
  ).join("\n\n----------------------------------------\n\n");
  const artifacts = {
    [runtimePath]: distribution.code,
    "dist/markdown-upstream-notices.txt": `${notices}\n`,
    "dist/markdown-upstream.cdx.json": `${JSON.stringify(markdownSbom(projected, distribution.evidence), null, 2)}\n`,
    "dist/markdown-distribution-proof.json": `${JSON.stringify(distribution.evidence, null, 2)}\n`,
  };
  for (const [path, bytes] of Object.entries(artifacts)) { await writeFile(join(packageRoot, path), bytes); }
  for (const path of privateArtifacts) { await rm(join(packageRoot, path), { force: true }); }
  return projected;
}

export async function prepareMarkdownPublication(repositoryRoot) {
  const { bytes: sourceLockBytes } = await readStableRegularFile(join(repositoryRoot, "pnpm-lock.yaml"), { bytes: 0 }, "Original source lock");
  const readArchive = await acquireMarkdownArchives({ sourceLockBytes, cacheRoot: join(repositoryRoot, ".cache/markdown-upstream") });
  return { sourceLockBytes, readArchive };
}

// Existing registry/release/check callers already build the source. Copy their
// complete built package before projecting; never change the developer checkout.
export async function stageBuiltMarkdownPublication({ repositoryRoot, packageRoot, temporaryRoot, context }) {
  const manifest = await readBoundedStableJson(join(packageRoot, "package.json"), "Built package manifest");
  if (manifest.name !== authoringName) { return packageRoot; }
  const authority = context ?? await prepareMarkdownPublication(repositoryRoot);
  await mkdir(temporaryRoot, { recursive: true });
  const root = await mkdtemp(join(temporaryRoot, "markdown-publication-"));
  const stagedRoot = join(root, "package");
  await materializeStableTree(packageRoot, stagedRoot, { allowLinks: false,
    excludedEntries: new Set(["node_modules", ".git", "tsconfig.tsbuildinfo"]), label: "Built authoring package", state: { bytes: 0, entries: 0 } });
  const copiedManifest = await readBoundedStableJson(join(stagedRoot, "package.json"), "Copied authoring manifest");
  if (JSON.stringify(copiedManifest) !== JSON.stringify(manifest)) { fail("manifest changed while staging"); }
  const { bytes } = await readStableRegularFile(join(repositoryRoot, "pnpm-workspace.yaml"), { bytes: 0 }, "Workspace catalog");
  const internalPackageVersions = new Map(await Promise.all(PUBLISHABLE_PACKAGES.map(async entry =>
    [entry.name, (await readBoundedStableJson(join(repositoryRoot, entry.manifestPath), "Workspace package manifest")).version])));
  const canonical = canonicalPublishManifest(manifest, { catalogVersions: new Map(Object.entries(parse(bytes.toString("utf8")).catalog)), internalPackageVersions });
  const projected = await projectMarkdownPublication({ packageRoot: stagedRoot, manifest: canonical,
    sourceLockBytes: authority.sourceLockBytes, readArchive: authority.readArchive });
  await writeFile(join(stagedRoot, "package.json"), `${JSON.stringify(npmPackManifest(projected), null, 2)}\n`);
  return stagedRoot;
}
