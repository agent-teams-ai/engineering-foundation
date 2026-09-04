import { isBuiltin } from "node:module";
import { realpath } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

import { build, version as esbuildVersion } from "esbuild";
import { parse } from "yaml";

import { verifyBundledComponent } from "./markdown-bundle-evidence.mjs";
import { canonicalMarkdownGraph, canonicalMarkdownPlugin } from "./markdown-canonical-graph.mjs";
import { sha256 } from "./pack-artifact-archive.mjs";
import { readStableRegularFile } from "./pack-artifact-stage-support.mjs";
import { markdownDependencies, prepareMarkdownSource } from "./markdown-source-snapshot.mjs";

const runtimePath = "dist/adapters/markdown-runtime.js";
const buildOptions = Object.freeze({
  bundle: true, charset: "utf8", format: "esm", legalComments: "none", logLevel: "silent",
  metafile: true, minifyWhitespace: true, platform: "node", sourcemap: false, target: "node24", write: false,
  tsconfigRaw: Object.freeze({ compilerOptions: Object.freeze({}) }),
});
const verifiedDistributions = new WeakSet();

function invalid(reason) {
  throw new Error(`Markdown distribution is invalid: ${reason}.`);
}

function componentRoot(path) {
  const segments = path.split(sep);
  const marker = segments.lastIndexOf("node_modules");
  if (marker < 0) { invalid("non-entry first-party source would be bundled"); }
  const count = segments[marker + 1]?.startsWith("@") ? 2 : 1;
  return segments.slice(0, marker + count + 1).join(sep);
}

function inputCapture(entry, captured, authorizedInputs) {
  let inputCount = 0;
  return {
    name: "authenticated-markdown-inputs",
    setup(builder) {
      // esbuild evaluates this filter in Go, where the JavaScript u flag is invalid.
      builder.onLoad({ filter: /.*/ }, ({ path }) => {
        inputCount += 1;
        if (inputCount > 2500) { invalid("too many inputs"); }
        const extension = extname(path);
        if (![".js", ".cjs", ".mjs", ".json"].includes(extension)) { invalid("unexpected input language"); }
        const root = path === entry ? undefined : componentRoot(path);
        const bytes = authorizedInputs.get(path);
        if (bytes === undefined) { invalid("input is outside authenticated archive members"); }
        // Neither installed nor staged file mutations can replace these bytes.
        captured.set(path, { bytes, root });
        return { contents: bytes, loader: extension === ".json" ? "json" : "js", resolveDir: dirname(path) };
      });
    },
  };
}

async function licenseSupplement(name, version) {
  if (name !== "format" || version !== "0.2.2") { return; }
  const { bytes } = await readStableRegularFile(
    join(import.meta.dirname, "markdown-licenses/format-0.2.2.txt"), { bytes: 0 }, "Reviewed upstream license",
  );
  return {
    bytes, sha256: "0b2c94863590ca2aed327e89642b7e74b1608ec423bfec1d8f1beba2945fc4ba",
    source: "https://github.com/samsonjs/format/blob/91b6bd78af9b061c90010b86d83caa051edeb1ea/License.md",
    sourceInput: { path: "format.js", sha256: "666bd4da85e596b4e3e119f201ea5c69dae64e2e9f75a5758de777b9550a6155" },
  };
}

async function proveComponents(captured, lock, readArchive, snapshotKeys) {
  const roots = [...new Set([...captured.values()].map(({ root }) => root).filter(Boolean))].toSorted();
  if (roots.length === 0 || roots.length > 2500) { invalid("physical input inventory is not bounded"); }
  const identities = new Map();
  const proofs = new Map();
  for (const root of roots) {
    const { bytes } = await readStableRegularFile(join(root, "package.json"), { bytes: 0 }, "Upstream manifest");
    const { name, version } = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof name !== "string" || name.startsWith("@agent-teams/")) { invalid("first-party component cannot be bundled"); }
    const integrity = lock.packages?.[`${name}@${version}`]?.resolution?.integrity;
    if (typeof integrity !== "string") { invalid(`missing original lock identity for ${name}`); }
    const inputs = [...captured].filter(([, input]) => input.root === root)
      .map(([path, input]) => ({ path: relative(root, path).split(sep).join("/"), bytes: input.bytes }));
    const proof = verifyBundledComponent({
      name, version, integrity, inputs, archive: await readArchive({ name, version, integrity }),
      supplement: await licenseSupplement(name, version),
    });
    if (sha256(bytes) !== proof.manifestSha256) { invalid(`installed manifest differs for ${name}`); }
    identities.set(root, { ...proof, snapshotKey: snapshotKeys.get(root) });
    const key = `${name}@${version}`;
    const previous = proofs.get(key);
    const files = new Map([...(previous?.files ?? []), ...proof.files].map((file) => [file.path, file]));
    proofs.set(key, Object.freeze({ ...proof, files: Object.freeze([...files.values()].toSorted((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    )) }));
    if (proofs.size > 100) { invalid("component inventory is not bounded"); }
  }
  const components = [...proofs.values()].toSorted((left, right) => {
    const a = `${left.name}@${left.version}`;
    const b = `${right.name}@${right.version}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return { components, identities };
}

function assertCapturedInputs(result, captured, packageRoot) {
  const inputs = Object.keys(result.metafile.inputs).map((path) => resolve(packageRoot, path));
  if (inputs.length !== captured.size || inputs.some((path) => !captured.has(path))) {
    invalid("build contains uncaptured inputs");
  }
  const outputs = Object.values(result.metafile.outputs);
  if (result.warnings.length !== 0 || result.outputFiles.length !== 1 || outputs.length !== 1 ||
      outputs[0].imports.some(({ path, external }) => !external || !path.startsWith("node:") || !isBuiltin(path))) {
    invalid("build must produce one self-contained module without warnings");
  }
}

// No network or source-tree writes: callers pre-acquire original lock-authenticated
// archives before entering hermetic package staging. Cache misses must reject.
async function buildFromAuthenticatedSource({ packageRoot, sourceLockBytes, sourceClosureSha256, readArchive, lock, inputs, snapshotKeys }) {
  const physicalRoot = await realpath(packageRoot);
  const entry = resolve(physicalRoot, runtimePath);
  const captured = new Map();
  const result = await build({
    ...buildOptions, absWorkingDir: physicalRoot, entryPoints: [runtimePath], outfile: "markdown-runtime.bundle.js",
    plugins: [inputCapture(entry, captured, inputs)],
  });
  assertCapturedInputs(result, captured, physicalRoot);
  const { components, identities } = await proveComponents(captured, lock, readArchive, snapshotKeys);
  const graph = canonicalMarkdownGraph({ captured, entry, identities, metafile: result.metafile, packageRoot: physicalRoot });
  const emitted = await build({
    ...buildOptions, entryPoints: [graph.entry], outfile: "markdown-runtime.bundle.js",
    plugins: [canonicalMarkdownPlugin(graph)],
  });
  if (emitted.warnings.length !== 0 || emitted.outputFiles.length !== 1) { invalid("canonical emission must produce one module"); }
  const code = Buffer.from(emitted.outputFiles[0].contents).toString("utf8");
  return Object.freeze({
    code,
    evidence: Object.freeze({
      sourceLockSha256: sha256(sourceLockBytes), entrySha256: sha256(captured.get(entry).bytes),
      sourceClosureSha256,
      bundler: Object.freeze({ name: "esbuild", version: esbuildVersion, options: buildOptions }),
      outputSha256: sha256(code), canonicalGraphSha256: graph.digest, components: Object.freeze(components),
    }),
  });
}

export async function buildMarkdownDistribution({ packageRoot, sourceLockBytes, readArchive }) {
  if (!Buffer.isBuffer(sourceLockBytes) || sourceLockBytes.length > 8 * 1024 * 1024 || typeof readArchive !== "function") {
    invalid("original lock bytes and an offline archive reader are required");
  }
  const capturedLock = Buffer.from(sourceLockBytes);
  const lock = parse(capturedLock.toString("utf8"));
  if (lock?.lockfileVersion !== "9.0" || lock.packages?.[`esbuild@${esbuildVersion}`] === undefined) {
    invalid("original lock does not bind the active bundler");
  }
  const { bytes: entryBytes } = await readStableRegularFile(join(packageRoot, runtimePath), { bytes: 0 }, "Compiled Markdown entry");
  const source = await prepareMarkdownSource({ lock, entryBytes, readArchive });
  try {
    const distribution = await buildFromAuthenticatedSource({
      packageRoot: source.packageRoot, sourceLockBytes: capturedLock, lock, inputs: source.inputs, snapshotKeys: source.snapshotKeys,
      sourceClosureSha256: source.sourceClosureSha256,
      readArchive: async ({ integrity }) => source.archives.get(integrity),
    });
    verifiedDistributions.add(distribution);
    return distribution;
  } finally { await source.dispose(); }
}

// Only a proof created by this module can authorize the exact dependency projection.
// Canonical manifest resolution remains the caller's responsibility.
export function projectMarkdownManifest(manifest, distribution) {
  if (!verifiedDistributions.has(distribution) || manifest?.name !== "@agent-teams/document-authoring") {
    invalid("dependency projection requires an authenticated authoring distribution");
  }
  const dependencies = { ...manifest.dependencies };
  for (const name of markdownDependencies) {
    if (!distribution.evidence.components.some((component) =>
      component.name === name && component.version === dependencies[name])) {
      invalid(`projected dependency was not bundled at its exact version: ${name}`);
    }
    delete dependencies[name];
  }
  return { ...manifest, dependencies };
}
