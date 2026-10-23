import { constants as fsConstants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { relative, sep, isAbsolute, resolve } from "node:path";
const PORTABLE_ARTIFACT_PATH =
  /^(?!\/)(?!.*\\)(?!.*\/\/)(?!.*\/$)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._@/-]+$/u;
function fail(message: string): never {
  throw new Error(`Publishable artifact staging is invalid: ${message}`);
}
function portableSegmentIdentity(segment: string, source: string): string {
  if (/[\p{Cc}<>:"|?*]/u.test(segment) || /[. ]$/u.test(segment)) {
    fail(`${source} is not portable across supported filesystems`);
  }
  const identity = segment.normalize("NFKC").toUpperCase();
  const firstDot = identity.indexOf(".");
  const deviceStem = (firstDot < 0 ? identity : identity.slice(0, firstDot)).replace(/[. ]+$/u, "");
  if (identity === "" || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(deviceStem)) {
    fail(`${source} is not portable across supported filesystems`);
  }
  return identity;
}

export async function readBoundedManifest(
  path: string,
  label: string,
): Promise<Record<string, unknown>> {
  const handle = await open(path, fsConstants.O_RDONLY | optionalOpenFlag(fsConstants.O_NOFOLLOW));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 1024 * 1024) {
      fail(`${label} is not a bounded regular manifest`);
    }
    const bytes = Buffer.alloc(before.size);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const overflow = Buffer.alloc(1);
    const { bytesRead: overflowBytes } = await handle.read(overflow, 0, 1, bytes.length);
    const after = await handle.stat();
    if (
      bytesRead !== bytes.length ||
      overflowBytes !== 0 ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      fail(`${label} changed while being read`);
    }
    try {
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        fail(`${label} is not a manifest object`);
      }
      return Object.fromEntries(Object.entries(parsed));
    } catch (error) {
      fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    await handle.close();
  }
}

export function manifestReleaseTargets(manifest: Record<string, unknown>): Set<string> {
  const targets = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.startsWith("./") && !value.includes("*") && value !== "./package.json") {
        targets.add(value.slice(2));
      }
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) {
        visit(child);
      }
    }
  };
  visit(manifest.bin);
  visit(manifest.exports);
  return targets;
}

export function pathIdentity(path: string): string {
  return path
    .split(/[\\/]/u)
    .filter(Boolean)
    .map((segment) => portableSegmentIdentity(segment, path))
    .join("/");
}

export function containsPath(parent: string, candidate: string): boolean {
  const remainder = relative(parent, candidate);
  return (
    remainder === "" ||
    (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder))
  );
}

export function validateRequiredArtifactPaths(
  requiredArtifactPaths: unknown,
  packageNames: ReadonlySet<string>,
): void {
  if (
    requiredArtifactPaths === null ||
    typeof requiredArtifactPaths !== "object" ||
    Array.isArray(requiredArtifactPaths)
  ) {
    fail("requiredArtifactPaths must be a package-name keyed object");
  }
  const pathsByName = Object.fromEntries<unknown>(Object.entries(requiredArtifactPaths));
  const names = Object.keys(pathsByName);
  for (const name of packageNames) {
    if (!Object.hasOwn(pathsByName, name)) {
      fail(`required artifact policy is missing package ${name}`);
    }
  }
  for (const name of names) {
    if (!packageNames.has(name)) {
      fail(`required artifact policy names unknown package ${name}`);
    }
    const paths = pathsByName[name];
    if (!Array.isArray(paths) || paths.length === 0) {
      fail(`required artifact policy for ${name} must be a non-empty array`);
    }
    const identities = new Set();
    for (const path of paths) {
      if (typeof path !== "string" || !PORTABLE_ARTIFACT_PATH.test(path)) {
        fail(`required artifact policy for ${name} contains an unsafe path`);
      }
      const identity = pathIdentity(path);
      if (identities.has(identity)) {
        fail(`required artifact policy for ${name} contains duplicate or colliding paths`);
      }
      identities.add(identity);
    }
  }
}

export async function assertPhysicalPublishablePackageRoots(
  repositoryRoot: string,
  packages: readonly { root: string; name: string }[],
): Promise<void> {
  const physicalRepositoryRoot = await realpath(repositoryRoot);
  const roots: { identity: string; name: string }[] = [];
  for (const entry of packages) {
    const physicalRoot = await realpath(resolve(repositoryRoot, entry.root));
    if (
      physicalRoot === physicalRepositoryRoot ||
      !containsPath(physicalRepositoryRoot, physicalRoot)
    ) {
      fail(`${entry.name} package root physically escapes the repository`);
    }
    const identity = pathIdentity(relative(physicalRepositoryRoot, physicalRoot));
    for (const other of roots) {
      if (
        identity === other.identity ||
        identity.startsWith(`${other.identity}/`) ||
        other.identity.startsWith(`${identity}/`)
      ) {
        fail(`${entry.name} and ${other.name} have physically colliding package roots`);
      }
    }
    roots.push({ identity, name: entry.name });
  }
}

function optionalOpenFlag(value: number | undefined): number {
  return value ?? 0;
}
