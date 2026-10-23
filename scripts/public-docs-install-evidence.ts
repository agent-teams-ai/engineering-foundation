import { parse as parseYaml } from "yaml";
interface Artifact {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
}
interface Manifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly [key: string]: unknown;
}
interface LockEntry {
  readonly integrity?: unknown;
  readonly version?: unknown;
  readonly resolution?: { readonly integrity?: unknown };
}
interface NativeLockfile {
  readonly lockfileVersion?: unknown;
  readonly packages?: Readonly<Record<string, LockEntry>>;
}
const DEPENDENCY_SECTIONS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "devDependencies",
];
const LOCAL_DEPENDENCY_PROTOCOL = /^(?:file|git\+file|link|workspace):/u;
const LOCAL_LOCKFILE_REFERENCE = /(?:^|@)(?:file|git\+file|link|workspace):/u;
function parsedLockfileEvidence(lockfile: unknown): NativeLockfile {
  let parsedLockfile: unknown;
  try {
    parsedLockfile =
      typeof lockfile === "string"
        ? parseYaml(lockfile, { maxAliasCount: 100, schema: "core" })
        : undefined;
  } catch {
    throw new Error("Public Docs lockfile is not valid JSON or YAML.");
  }
  if (
    typeof parsedLockfile !== "object" ||
    parsedLockfile === null ||
    Array.isArray(parsedLockfile)
  ) {
    throw new Error("Public Docs lockfile is not valid JSON or YAML.");
  }
  return parsedLockfile;
}

function hasLocalLockfileReference(lockfile: unknown): boolean {
  const pending: unknown[] = [lockfile];
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== "object" || current === null) {
      if (typeof current === "string" && LOCAL_LOCKFILE_REFERENCE.test(current)) {
        return true;
      }
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      pending.push(...(current as unknown[]));
      continue;
    }
    for (const [key, value] of Object.entries(current)) {
      if (LOCAL_LOCKFILE_REFERENCE.test(key)) {
        return true;
      }
      pending.push(value);
    }
  }
  return false;
}

function assertNativeArtifactBinding({
  artifacts,
  parsed,
  name,
  version,
}: {
  artifacts: readonly Artifact[];
  parsed: NativeLockfile;
  name: string;
  version: string;
}) {
  const artifact = artifacts.find(
    (candidate) => candidate.name === name && candidate.version === version,
  );
  const entry =
    parsed.lockfileVersion === 3
      ? parsed.packages?.["node_modules/" + name]
      : parsed.lockfileVersion === "9.0"
        ? parsed.packages?.[name + "@" + version]
        : undefined;
  const nativeIntegrity =
    parsed.lockfileVersion === 3 ? entry?.integrity : entry?.resolution?.integrity;
  if (
    artifact === undefined ||
    canonicalIntegrity(nativeIntegrity, name) !== artifact.integrity ||
    (parsed.lockfileVersion === 3 && entry?.version !== version)
  ) {
    throw new Error(
      "Public Docs native lockfile does not bind the observed artifact for " + name + ".",
    );
  }
}

export function assertRegistryOnlyInstallEvidence({
  artifacts,
  lockfile,
  manifests,
}: {
  artifacts?: readonly Artifact[];
  lockfile: unknown;
  manifests: readonly { manifest: Manifest | null | undefined; name: string; version: string }[];
}) {
  const parsed = parsedLockfileEvidence(lockfile);
  if (hasLocalLockfileReference(parsed)) {
    throw new Error("Public Docs lockfile contains a local or workspace dependency.");
  }
  for (const { manifest, name, version } of manifests) {
    if (manifest?.name !== name || manifest.version !== version) {
      throw new Error(`Public install resolved an unexpected identity for ${name}@${version}.`);
    }
    for (const section of DEPENDENCY_SECTIONS) {
      const dependencies: unknown = manifest[section] ?? {};
      if (
        typeof dependencies !== "object" ||
        dependencies === null ||
        Array.isArray(dependencies) ||
        Object.values(dependencies).some(
          (value) => typeof value !== "string" || LOCAL_DEPENDENCY_PROTOCOL.test(value),
        )
      ) {
        throw new Error(`Public install retained a local dependency in ${name} ${section}.`);
      }
    }
    if (artifacts !== undefined) {
      assertNativeArtifactBinding({ artifacts, parsed, name, version });
    }
  }
}

export function canonicalIntegrity(value: unknown, name: string) {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/u.exec((value ?? "") as string);
  const bytes = match === null ? undefined : Buffer.from(match.at(1) ?? "", "base64");
  if (bytes?.length !== 64 || bytes.toString("base64") !== match?.at(1)) {
    throw new Error(`Public npm returned invalid integrity for ${name}.`);
  }
  return value;
}
