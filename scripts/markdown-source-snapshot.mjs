import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { authenticatedMarkdownArchive } from "./markdown-bundle-evidence.mjs";
import { portableEntryIdentity, sha256 } from "./pack-artifact-archive.mjs";

export const markdownDependencies = Object.freeze([
  "github-slugger", "mdast-util-to-string", "remark-frontmatter", "remark-gfm",
  "remark-parse", "unified", "unist-util-visit", "vfile",
]);
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const lockedReference = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\([A-Za-z0-9@._/+-]+\))*$/u;

function fail(reason) { throw new Error(`Markdown source snapshot is invalid: ${reason}.`); }

function dependencyEntries(snapshot) {
  const result = new Map();
  for (const section of [snapshot.dependencies, snapshot.optionalDependencies]) {
    if (section === undefined) { continue; }
    if (section === null || typeof section !== "object" || Array.isArray(section)) { fail("malformed snapshot dependencies"); }
    for (const [name, reference] of Object.entries(section)) {
      if (result.has(name) && result.get(name) !== reference) { fail("conflicting dependency edges"); }
      result.set(name, reference);
    }
  }
  return [...result].toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

// Deliberately not a package manager: consume exact pnpm v9 edges, never resolve
// semver, alias, file/git/workspace requests, or infer peers from metadata.
export function markdownSnapshotPlan(lock) {
  if (lock?.lockfileVersion !== "9.0") { fail("pnpm lock v9 is required"); }
  const importer = lock.importers?.["packages/document-authoring"]?.dependencies;
  const roots = markdownDependencies.map((name) => [name, importer?.[name]?.version]);
  const nodes = new Map();
  const visit = (name, reference) => {
    if (!packageName.test(name) || name.startsWith("@agent-teams/") ||
        typeof reference !== "string" || !lockedReference.test(reference)) { fail("unsupported exact dependency reference"); }
    const key = `${name}@${reference}`;
    if (nodes.has(key)) { return key; }
    const version = reference.split("(")[0];
    const snapshot = lock.snapshots?.[key];
    const metadata = lock.packages?.[`${name}@${version}`];
    const integrity = metadata?.resolution?.integrity;
    if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot) || typeof integrity !== "string") {
      fail(`missing original snapshot or archive identity for ${key}`);
    }
    if (["os", "cpu", "libc"].some(field => metadata[field] !== undefined) ||
        Object.keys(metadata.resolution).some(field => field !== "integrity")) {
      fail("platform-conditioned and non-registry packages are not supported");
    }
    if (nodes.size >= 128) { fail("dependency closure exceeds 128 snapshots"); }
    const node = { key, name, version, integrity, dependencies: [] };
    nodes.set(key, node);
    node.dependencies = dependencyEntries(snapshot).map(([dependency, target]) => [dependency, visit(dependency, target)]);
    return key;
  };
  return { roots: roots.map(([name, reference]) => [name, visit(name, reference)]), nodes };
}

export function markdownSnapshotSha256(plan) {
  return sha256(JSON.stringify({ schemaVersion: 1, lockfileVersion: "9.0", roots: plan.roots,
    nodes: [...plan.nodes.values()].toSorted((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0) }));
}

async function materializeArchive(node, root, readArchive, context) {
  const { archives, budget, inputs } = context;
  let archive = archives.get(node.integrity);
  if (archive === undefined) {
    archive = Buffer.from(await readArchive(node));
    archives.set(node.integrity, archive);
  }
  const { manifest, members } = authenticatedMarkdownArchive({ ...node, archive });
  if (["os", "cpu", "libc"].some(field => manifest[field] !== undefined)) { fail("platform-conditioned manifests are not supported"); }
  for (const [path, bytes] of members) {
    portableEntryIdentity(`package/${path}`);
    if (path.split("/").includes("node_modules")) { fail("embedded dependency trees are not supported"); }
    budget.bytes += bytes.length;
    budget.files += 1;
    if (budget.bytes > 64 * 1024 * 1024 || budget.files > 25_000) { fail("source closure exceeds materialization bounds"); }
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes, { flag: "wx", mode: 0o444 });
    inputs.set(join(root, path), bytes);
  }
}

async function linkDependencies(root, dependencies, roots) {
  for (const [name, key] of dependencies) {
    const destination = join(root, "node_modules", ...name.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await symlink(roots.get(key), destination, process.platform === "win32" ? "junction" : "dir");
  }
}

// All callbacks finish before resolution starts. Only authenticated archive bytes
// and lock-defined links enter this private tree; installed node_modules is unused.
export async function prepareMarkdownSource({ lock, entryBytes, readArchive }) {
  const plan = markdownSnapshotPlan(lock);
  const root = await realpath(await mkdtemp(join(tmpdir(), "markdown-authenticated-source-")));
  const packageRoot = join(root, "entry");
  const roots = new Map([...plan.nodes].map(([key, node]) =>
    [key, join(root, "snapshots", sha256(key), "node_modules", ...node.name.split("/"))]));
  const archives = new Map();
  const inputs = new Map();
  try {
    const budget = { bytes: 0, files: 0 };
    for (const [key, node] of plan.nodes) { await materializeArchive(node, roots.get(key), readArchive, { archives, budget, inputs }); }
    for (const [key, node] of plan.nodes) { await linkDependencies(roots.get(key), node.dependencies, roots); }
    await linkDependencies(packageRoot, plan.roots, roots);
    await mkdir(join(packageRoot, "dist/adapters"), { recursive: true });
    await writeFile(join(packageRoot, "dist/adapters/markdown-runtime.js"), entryBytes, { flag: "wx", mode: 0o444 });
    inputs.set(join(packageRoot, "dist/adapters/markdown-runtime.js"), entryBytes);
    await writeFile(join(packageRoot, "package.json"), '{"type":"module"}\n', { flag: "wx", mode: 0o444 });
    return { packageRoot, archives, inputs, sourceClosureSha256: markdownSnapshotSha256(plan),
      snapshotKeys: new Map([...roots].map(([key, path]) => [path, key])),
      dispose: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
