import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import YAML from "yaml";
import { parseSync } from "oxc-parser";

export const roles = new Set(["domain", "integration", "platform", "sdk", "testing"]);
export const layers = new Set(["domain", "application", "contracts", "adapters", "composition", "testing"]);
export const within = (path, root) => path === root || path.startsWith(`${root}/`);
export const problem = (problems, code, message) => problems.push({ code, message });
export const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export function portable(path) {
  return typeof path === "string" && /^[\w@./-]+$/u.test(path) && !path.startsWith("/") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
export async function kind(root, path) {
  if (!portable(path)) {throw new Error(`Nonportable repository path: ${path}`);}
  // Reject symlinks in every ancestor, including file-sized ownership mappings.
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) {throw new Error(`Symlink in governed path: ${path}`);}
    } catch (error) {
      if (error.code === "ENOENT") {return "missing";}
      throw error;
    }
  }
  const value = await lstat(current);
  return value.isDirectory() ? "directory" : value.isFile() ? "file" : "other";
}
export async function sourceFiles(root, path) {
  const type = await kind(root, path);
  if (type === "file") {return /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(path) ? [path] : [];}
  if (type !== "directory") {return [];}
  const nested = [];
  for (const name of (await readdir(join(root, path))).toSorted()) {
    nested.push(...await sourceFiles(root, `${path}/${name}`));
  }
  return nested;
}
export function ownershipRoots(module) {
  return [
    ...module.features.flatMap((feature) => feature.layers.flatMap((layer) =>
      layer.roots.map((root) => ({ kind: "feature", module, feature, layer, root })))),
    ...module.moduleAssembly.map((root) => ({ kind: "assembly", module, root })),
    ...module.exceptions.map((primitive) => ({ kind: "primitive", module, layer: { role: primitive.role }, primitive, root: primitive.path }))
  ];
}
export function classify(path, profile) {
  const owners = profile.modules.flatMap(ownershipRoots).filter(({ root }) => within(path, root));
  if (owners.length !== 1) {return;}
  const owner = owners[0];
  const generated = owner.module.generatedRoots.filter((record) => typeof record === "object" && within(path, record.root));
  return { ...owner, provenance: generated.length ? "generated" : owner.kind === "primitive" ? "primitive" : "source" };
}
export async function decisionEvidence(repositoryRoot, record, problems) {
  for (const field of ["decision"]) {
    if (typeof record[field] !== "string" || record[field].trim() === "") {
      problem(problems, "invalid-exception", `${record.path} lacks ${field}.`);
      return;
    }
  }
  if (await kind(repositoryRoot, record.decision) !== "file") {
    problem(problems, "exception-decision", `${record.path}: missing decision ${record.decision}.`);
    return;
  }
  const decision = await readFile(join(repositoryRoot, record.decision), "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(decision);
  const metadata = frontmatter ? YAML.parse(frontmatter[1]) : undefined;
  if (metadata?.status !== "accepted" || !/^ADR-\d{4}$/u.test(metadata?.id ?? "") || !metadata?.primitiveScopes?.[record.path]) {
    problem(problems, "exception-decision", `${record.path}: decision must be accepted and explicitly name this scope.`);
    return;
  }
  return metadata.primitiveScopes[record.path];
}
async function hasArtifact(repositoryRoot, root) {
  for (const file of await sourceFiles(repositoryRoot, root)) {
    const parsed = parseSync(file, await readFile(join(repositoryRoot, file), "utf8"));
    if (parsed.errors.length) {throw new Error(`Invalid source syntax: ${file}`);}
    if (parsed.program.body.some((node) => {
      if (["ImportDeclaration", "EmptyStatement"].includes(node.type)) { return false; }
      if (node.type === "ExportNamedDeclaration") { return Boolean(node.declaration) || node.specifiers.length > 0; }
      return true;
    })) { return true; }
  }
  return false;
}
async function validateRoots(repositoryRoot, module, problems) {
  const roots = ownershipRoots(module);
  for (const [index, item] of roots.entries()) {
    if (!portable(item.root) || !within(item.root, module.sourceRoot) || item.root === module.sourceRoot) {
      problem(problems, "ownership-root", `${module.id}: invalid ownership root ${item.root}.`);
      continue;
    }
    for (const previous of roots.slice(0, index)) {
      if (within(item.root, previous.root) || within(previous.root, item.root)) {
        problem(problems, "overlapping-ownership", `${previous.root} overlaps ${item.root}.`);
      }
    }
    if (!await hasArtifact(repositoryRoot, item.root)) {
      problem(problems, "empty-layer", `${item.root} has no production artifact.`);
    }
  }
}
async function validateFeature(repositoryRoot, module, feature, problems) {
  if (!roles.has(feature.role)) {problem(problems, "feature-role", `${module.id}/${feature.id}: invalid role.`);}
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(feature.id) || /^(?:shared|common|utils|services|core|infrastructure|.*-primitives|.*-kernel)$/u.test(feature.id)) {
    problem(problems, "feature-identity", `${module.id}/${feature.id}: use a cohesive capability owner.`);
  }
  if (feature.layers.length === 0) {problem(problems, "empty-layer", `${feature.id}: no real layer.`);}
  if (!feature.testRoots?.length) {problem(problems, "test-ownership", `${module.id}/${feature.id}: no focused test mapping.`);}
  for (const root of feature.testRoots ?? []) {
    if (await kind(repositoryRoot, root) === "missing") {problem(problems, "test-ownership", `${feature.id}: missing ${root}.`);}
  }
  for (const layer of feature.layers) {
    if (!layers.has(layer.role) || layer.roots.length === 0) {problem(problems, "layer-role", `${feature.id}: invalid/empty layer ${layer.role}.`);}
    for (const root of layer.roots) {
      if (root.split("/").some((segment) => ["shared", "common", "utils", "services", "core", "infrastructure"].includes(segment))) {
        problem(problems, "generic-ownership", `${root}: broad convenience ownership is not a feature mapping.`);
      }
      if (await kind(repositoryRoot, root) === "directory") {
        await emptyDirectories(repositoryRoot, root, problems);
      }
    }
  }
}
async function emptyDirectories(repositoryRoot, root, problems) {
  const entries = await readdir(join(repositoryRoot, root), { withFileTypes: true });
  if (!await hasArtifact(repositoryRoot, root)) {problem(problems, "empty-layer", `${root}: empty ceremonial directory.`);}
  for (const entry of entries) {
    if (entry.isDirectory()) {await emptyDirectories(repositoryRoot, `${root}/${entry.name}`, problems);}
  }
}
export async function validateModule(repositoryRoot, module, problems, profile = { modules: [module] }) {
  if (!roles.has(module.role)) {problem(problems, "module-role", `${module.id}: invalid role ${module.role}.`);}
  if (!within(module.sourceRoot, module.root) || !within(module.preferredFeatureRoot, module.sourceRoot)) {
    problem(problems, "module-root", `${module.id}: source/creation root escapes module.`);
  }
  if (module.features.length === 0) {problem(problems, "feature-required", `${module.id} has no real feature.`);}
  if (new Set(module.features.map(({ id }) => id)).size !== module.features.length) {problem(problems, "feature-identity", `${module.id}: duplicate feature.`);}
  await validateRoots(repositoryRoot, module, problems);
  for (const feature of module.features) {await validateFeature(repositoryRoot, module, feature, problems);}
  for (const exception of module.exceptions) {
    if (await kind(repositoryRoot, exception.path) !== "file") {problem(problems, "invalid-exception", `${exception.path}: exceptions require one exact file.`);}
    const scope = await decisionEvidence(repositoryRoot, exception, problems);
    await validatePrimitive(repositoryRoot, exception, scope, profile, problems);
  }
  await validateGenerated(repositoryRoot, module, problems);
  const files = await sourceFiles(repositoryRoot, module.sourceRoot);
  if (files.length === 0) {problem(problems, "module-empty", `${module.id}: no production source.`);}
  for (const file of files) {
    if (!classify(file, { modules: [module] })) {problem(problems, "unowned-source", file);}
  }
  if (!module.publicEntrypoints.length) {problem(problems, "missing-entrypoint", `${module.id}: no public entrypoint.`);}
  for (const entrypoint of module.publicEntrypoints) {
    if (!within(entrypoint, module.sourceRoot) || await kind(repositoryRoot, entrypoint) !== "file") {problem(problems, "missing-entrypoint", entrypoint);}
  }
  await validateExports(repositoryRoot, module, problems);
  return files;
}
export const sourceExtension = (path) => /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(path);
export const declarationExtension = (path) => /\.d\.[cm]?ts$/u.test(path);
// Repository-owned compiler layout only; this is not build provenance or a
// second import resolver. Assets stay outside the source projection.
export function sourceTarget(module, target) {
  if (typeof target !== "string" || !target.startsWith("./") || !sourceExtension(target) || target.includes("*")) {return;}
  if (!portable(target.slice(2))) {return;}
  if (!target.startsWith("./dist/")) {return posix.join(module.root, target);}
  return `${module.sourceRoot}/${target.slice(7).replace(/(?:\.d)?\.(?:js|ts)$/u, ".ts").replace(/(?:\.d)?\.(?:mjs|mts)$/u, ".mts").replace(/(?:\.d)?\.(?:cjs|cts)$/u, ".cts")}`;
}
export async function executableSources(repositoryRoot, module) {
  const manifest = JSON.parse(await readFile(join(repositoryRoot, module.root, "package.json"), "utf8"));
  return (typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {}))
    .map((target) => declarationExtension(target) ? undefined : sourceTarget(module, target));
}
async function validateExports(repositoryRoot, module, problems) {
  const manifest = JSON.parse(await readFile(join(repositoryRoot, module.root, "package.json"), "utf8"));
  if (manifest.exports === undefined) {
    problem(problems, "module-export", `${module.id}: an explicit exports map must close private subpaths.`);
  }
  for (const source of await executableSources(repositoryRoot, module)) {
    if (!source || !module.moduleAssembly.includes(source) || await kind(repositoryRoot, source) !== "file") {
      problem(problems, "module-executable", `${module.id}: executable ${source} lacks exact process assembly ownership.`);
    }
  }
  const targets = [];
  function visit(value) {
    if (typeof value === "string") {targets.push(value);}
    else if (value && typeof value === "object") {Object.values(value).forEach(visit);}
  }
  visit(manifest.exports);
  for (const target of targets) {
    if (target.includes("*") && sourceExtension(target)) {problem(problems, "wildcard-export", `${module.id}: ${target}`);}
    if (!sourceExtension(target)) {continue;}
    const source = sourceTarget(module, target);
    if (!source || !module.publicEntrypoints.includes(source)) {problem(problems, "module-export", `${module.id}: undeclared public target ${source ?? target}.`);}
  }
}

// Stable semantic identities belong in accepted decisions. Exact current paths
// belong in the mutable profile; an internal move cannot widen this owner set.
export function consumerIdentity(owner) {
  if (owner?.kind === "feature") {return `${owner.module.id}/${owner.feature.id}`;}
  if (owner?.kind === "assembly") {return `${owner.module.id}/@assembly`;}
}
function validPrimitiveScope(scope) {
  return ["semantics", "owner", "rationale", "purity", "versioning", "reviewTrigger"].every((key) => typeof scope[key] === "string" && scope[key].trim()) &&
    Array.isArray(scope.consumers) && scope.consumers.length > 0 && scope.consumers.every((owner) => typeof owner === "string") &&
    new Set(scope.consumers).size === scope.consumers.length;
}
async function validatePrimitive(repositoryRoot, record, scope, profile, problems) {
  if (record.role !== "domain" || Object.keys(record).some((key) => !["path", "role", "decision", "consumers"].includes(key)) ||
      !Array.isArray(record.consumers) || !record.consumers.length) {
    problem(problems, "invalid-exception", `${record.path}: a pure domain primitive requires semantics and exact consumers.`);
    return;
  }
  if (!scope) {return;}
  if (!validPrimitiveScope(scope)) {
    problem(problems, "exception-decision", `${record.path}: decision needs semantic, ownership, purity/interoperability, versioning and review facts plus closed consumer identities.`);
    return;
  }
  const paths = new Set(), owners = new Set();
  for (const consumer of record.consumers) {
    if (!consumer || Object.keys(consumer).toSorted().join(",") !== "owner,path" || !portable(consumer.path) ||
        !sourceExtension(consumer.path) || paths.has(consumer.path) || await kind(repositoryRoot, consumer.path) !== "file") {
      problem(problems, "primitive-consumer", `${record.path}: require unique existing exact caller paths mapped to owners.`);
      continue;
    }
    paths.add(consumer.path);
    const owner = consumerIdentity(classify(consumer.path, profile));
    if (!owner || consumer.owner !== owner || !scope.consumers.includes(owner)) {
      problem(problems, "primitive-consumer", `${record.path}: ${consumer.path} is not mapped to its accepted module/feature or module assembly identity.`);
    } else {owners.add(owner);}
  }
  for (const owner of scope.consumers) {
    if (!owners.has(owner)) {problem(problems, "primitive-consumer", `${record.path}: accepted consumer ${owner} has no current caller mapping.`);}
  }
}
async function validateGenerated(repositoryRoot, module, problems) {
  const seen = new Set();
  for (const record of module.generatedRoots) {
    if (!record || typeof record !== "object" || !portable(record.root)) {
      problem(problems, "generated-provenance", `${module.id}: generated roots require root, generator and source identities.`);
      continue;
    }
    const owner = classify(record.root, { modules: [module] });
    if (owner?.kind !== "feature" || !record.root.split("/").includes("generated") || seen.has(record.root)) {
      problem(problems, "generated-root", `${record.root}: require isolated, unique feature/layer ownership.`);
    }
    seen.add(record.root);
    if (await kind(repositoryRoot, record.generator) !== "file" || !record.sources?.length) {
      problem(problems, "generated-provenance", `${record.root}: missing generator or sources.`);
    }
    for (const path of record.sources ?? []) {
      if (await kind(repositoryRoot, path) === "missing") {problem(problems, "generated-provenance", `${record.root}: missing source ${path}.`);}
    }
  }
}
