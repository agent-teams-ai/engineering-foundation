import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import { isPureModuleTypeScope } from "../../../application/policies/source-package-ownership.js";

interface MarkerObservation {
  readonly path: string;
  readonly bytes?: Buffer;
  readonly identity?: string;
}

function identity(metadata: NonNullable<ReturnType<typeof lstatSync>>): string {
  return [metadata.dev, metadata.ino, metadata.mode, metadata.size, metadata.mtimeMs, metadata.ctimeMs].join(":");
}

function contained(root: string, path: string): boolean {
  const relation = relative(root, path);
  return !isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`);
}

// Synchronous counterpart of the contained reader's ancestry and named snapshot checks.
function namedMarkerMatches(root: string, path: string, expected: string): boolean {
  if (!contained(root, path)) { return false; }
  let current = root;
  const rootMetadata = lstatSync(current);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) { return false; }
  for (const segment of relative(root, path).split(sep)) {
    current = join(current, segment);
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink() || (current !== path && !metadata.isDirectory())) { return false; }
  }
  const canonical = realpathSync(path);
  if (!contained(root, canonical)) { return false; }
  const named = lstatSync(canonical);
  return named.isFile() && identity(named) === expected;
}

function pureMarkerBytes(bytes: Buffer): boolean {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) { return false; }
    throw error;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    isPureModuleTypeScope(value as Record<string, unknown>);
}

function readMarker(root: string, path: string): MarkerObservation | undefined {
  let descriptor: number | undefined;
  let observedFile = false;
  try {
    const before = lstatSync(path);
    observedFile = true;
    if (!before.isFile() || before.size > 2 * 1024 * 1024) {
      return undefined;
    }
    if (!namedMarkerMatches(root, path, identity(before))) { return undefined; }
    const flags = process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK;
    descriptor = openSync(path, constants.O_RDONLY | flags);
    if (identity(fstatSync(descriptor)) !== identity(before) ||
      !namedMarkerMatches(root, path, identity(before))) { return undefined; }
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(descriptor, bytes, count, bytes.length - count, null);
      if (read === 0) { break; }
      count += read;
    }
    if (count !== before.size || identity(fstatSync(descriptor)) !== identity(before) ||
      !namedMarkerMatches(root, path, identity(before))) { return undefined; }
    const captured = bytes.subarray(0, count);
    if (!pureMarkerBytes(captured)) { return undefined; }
    return { path, bytes: captured, identity: identity(before) };
  } catch (error) {
    // Absence is valid only when no file was opened or initially observed.
    if (!observedFile && descriptor === undefined && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path };
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined && ["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM", "EIO", "EISDIR", "EMFILE", "ENFILE"].includes(code)) {
      return undefined;
    }
    throw error;
  } finally {
    if (descriptor !== undefined) { closeSync(descriptor); }
  }
}

/** Only unchanged pure markers can occur between an output owner and its target. */
export class GeneratedOutputManifestObservations {
  readonly #observations: MarkerObservation[] = [];
  #bytes = 0;
  readonly #canonicalRoot: string;

  constructor(canonicalRoot: string) {
    this.#canonicalRoot = canonicalRoot;
  }

  observe(directory: string): boolean {
    if (this.#observations.length >= 5_000) { return false; }
    const observation = readMarker(this.#canonicalRoot, join(directory, "package.json"));
    if (observation === undefined) { return false; }
    this.#bytes += observation.bytes?.length ?? 0;
    if (this.#bytes > 512 * 1024 * 1024) { return false; }
    this.#observations.push(observation);
    return true;
  }

  stable(): boolean {
    return this.#observations.every((before) => {
      const after = readMarker(this.#canonicalRoot, before.path);
      return after !== undefined && after.identity === before.identity &&
        (before.bytes === undefined ? after.bytes === undefined :
          after.bytes !== undefined && before.bytes.equals(after.bytes));
    });
  }
}
