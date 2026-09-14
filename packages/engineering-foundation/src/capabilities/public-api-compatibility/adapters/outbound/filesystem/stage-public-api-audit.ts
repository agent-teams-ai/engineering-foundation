import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { auditDigest, auditInputPath, AUDIT_MAX_BYTES } from "./public-api-audit-inputs.js";

/** Single-producer frozen namespace, published only after all writes finish.
 * The caller owns its private parent and excludes external writers throughout
 * observation. chmod is defense in depth, not a cross-platform security boundary.
 */
export interface AuditInputStage {
  readonly root: string;
  readonly files: ReadonlyMap<string, string>;
  revalidate(): Promise<void>;
  release(): Promise<void>;
}

function containedPath(root: string, directory: string, value: string, allowRoot = false): string {
  if (isAbsolute(value) || value.includes("\\") || /^[a-z][a-z0-9+.-]*:/iu.test(value)) {
    throw new Error(`Unsupported SDK input path: ${value}.`);
  }
  const path = resolve(directory, value);
  const local = relative(root, path);
  if ((!allowRoot && local === "") || local === ".." || local.startsWith(`..${sep}`)) {
    throw new Error(`SDK input path escapes verified evidence: ${value}.`);
  }
  return path;
}

function strings(value: unknown): readonly string[] {
  if (typeof value === "string") { return [value]; }
  if (Array.isArray(value)) { return value.flatMap(strings); }
  if (typeof value === "object" && value !== null) { return Object.values(value).flatMap(strings); }
  return [];
}

/** Over-approximate every metadata path the pinned SDK can select from a manifest. */
function metadataPaths(root: string, path: string, bytes: Buffer): readonly string[] {
  const manifest = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  const directory = dirname(path);
  const paths = [join(directory, "tsdoc-metadata.json")];
  if (manifest["tsdocMetadata"] !== undefined) {
    if (typeof manifest["tsdocMetadata"] !== "string") { throw new Error("Unsupported tsdocMetadata path."); }
    paths.push(containedPath(root, directory, manifest["tsdocMetadata"]));
  }
  for (const field of ["exports", "typesVersions", "types", "typings", "main"]) {
    for (const value of strings(manifest[field])) {
      paths.push(join(dirname(containedPath(root, directory, value)), "tsdoc-metadata.json"));
    }
  }
  return paths;
}

function mappedSources(root: string, path: string, bytes: Buffer): readonly string[] {
  const map = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  if (map["version"] !== 3 || map["sections"] !== undefined || !Array.isArray(map["sources"]) ||
      (map["sourceRoot"] !== undefined && typeof map["sourceRoot"] !== "string")) {
    throw new Error("Unsupported declaration source-map structure.");
  }
  const sourceRoot = map["sourceRoot"] ?? "";
  return map["sources"].map((source: unknown) => {
    if (typeof source !== "string") { throw new Error("Unsupported mapped source path."); }
    // Validate both components before joining: join would hide an absolute source.
    const base = sourceRoot === "" ? dirname(path) : containedPath(root, dirname(path), sourceRoot, true);
    return containedPath(root, base, source);
  });
}

async function present(root: string, path: string): Promise<boolean> {
  // Observe absence only after rejecting symlinked ancestors, including dangling links.
  const parts = relative(root, path).split(sep);
  let cursor = root;
  for (const part of parts) {
    cursor = join(cursor, part);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) { throw new Error(`Audit symlink unsupported: ${path}.`); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { return false; }
      throw error;
    }
  }
  return true;
}

export async function stagePublicApiAudit(root: string, allowed: ReadonlyMap<string, string>, stageRoot: string): Promise<AuditInputStage> {
  // Claim a fresh namespace before doing any I/O on its behalf. In particular,
  // a second producer cannot reuse a published stage (also enforced on Windows).
  allowed = new Map(allowed);
  await mkdir(stageRoot, { mode: 0o700 });
  const bytes = new Map<string, Buffer>();
  const observed = new Map<string, boolean>();
  let byteCount = 0;
  for (const [path, digest] of allowed) {
    await auditInputPath(root, relative(root, path).split(sep).join("/"));
    const content = await readFile(path);
    byteCount += content.length;
    if (byteCount > AUDIT_MAX_BYTES) { throw new Error("Audit staging byte budget exhausted."); }
    if (auditDigest(content) !== digest) { throw new Error("Audit staging input digest mismatch."); }
    bytes.set(path, content);
  }
  const dependencies = new Set<string>();
  for (const [path, content] of bytes) {
    if (/\.d\.[cm]?ts$/u.test(path)) { dependencies.add(`${path}.map`); }
    if (basename(path) === "package.json") {
      for (const dependency of metadataPaths(root, path, content)) { dependencies.add(dependency); }
    }
    if (/\.d\.[cm]?ts\.map$/u.test(path)) {
      for (const dependency of mappedSources(root, path, content)) {
        if (!allowed.has(dependency)) { throw new Error(`Undeclared mapped source: ${dependency}.`); }
        dependencies.add(dependency);
      }
    }
  }
  for (const path of dependencies) {
    const exists = await present(root, path);
    observed.set(path, exists);
    if (exists && !allowed.has(path)) { throw new Error(`Undeclared SDK input: ${path}.`); }
  }
  const files = new Map<string, string>();
  const directories = new Set<string>([stageRoot]);
  for (const [path, content] of bytes) {
    const destination = join(stageRoot, relative(root, path));
    await mkdir(dirname(destination), { recursive: true });
    let directory = dirname(destination);
    while (directory !== stageRoot) { directories.add(directory); directory = dirname(directory); }
    await writeFile(destination, content, { flag: "wx", mode: 0o400 });
    files.set(destination, auditDigest(content));
  }
  for (const directory of directories) { await chmod(directory, 0o500); }
  let released = false;
  return { root: stageRoot, files,
    release: async () => {
      released = true;
      for (const directory of directories) { await chmod(directory, 0o700); }
    },
    revalidate: async () => {
    if (released) { throw new Error("Audit stage has been released."); }
    for (const [path, expected] of observed) {
      if (await present(root, path) !== expected || await present(stageRoot, join(stageRoot, relative(root, path))) !== expected) {
        throw new Error("SDK input presence changed during observation.");
      }
    }
    for (const [path, digest] of allowed) {
      await auditInputPath(root, relative(root, path).split(sep).join("/"));
      if (auditDigest(await readFile(path)) !== digest) { throw new Error("Audit input changed during observation."); }
    }
  } };
}
