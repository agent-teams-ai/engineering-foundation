import { Buffer } from "node:buffer";

export interface ReleasePackageVersion {
  readonly root: string;
  readonly name: string;
  readonly baseVersion: string;
  readonly headVersion: string;
}

const canonicalPrefix = '{\n  "lockfileVersion": 2,\n  "configVersion": 1,\n  "workspaces": {\n';
const packageRoot = /^packages\/[a-z0-9][a-z0-9._-]*$/u;
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const versionToken =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function validVersionTuple(value: ReleasePackageVersion): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 4 &&
    typeof value.root === "string" &&
    packageRoot.test(value.root) &&
    typeof value.name === "string" &&
    packageName.test(value.name) &&
    typeof value.baseVersion === "string" &&
    versionToken.test(value.baseVersion) &&
    typeof value.headVersion === "string" &&
    versionToken.test(value.headVersion)
  );
}

function workspaceAnchor(value: ReleasePackageVersion, version: string): string {
  return (
    `\n    ${JSON.stringify(value.root)}: {\n` +
    `      "name": ${JSON.stringify(value.name)},\n` +
    `      "version": ${JSON.stringify(version)},\n`
  );
}

function retainedRegistrySelection(source: string, value: ReleasePackageVersion): boolean {
  // A same-named package may deliberately be consumed from npm rather than
  // linked as a workspace. Its immutable registry selection is not versioned.
  const rootStart = `${canonicalPrefix}    "": {\n`;
  if (!source.startsWith(rootStart)) {
    return false;
  }
  const rootEnd = source.indexOf("\n    },\n", rootStart.length);
  const root = source.slice(rootStart.length, rootEnd);
  const dependencyStart = root.indexOf('      "devDependencies": {\n');
  const dependencyEnd = root.indexOf("\n      },", dependencyStart);
  if (rootEnd < 0 || dependencyStart < 0 || dependencyEnd < 0) {
    return false;
  }
  const dependencies = root.slice(dependencyStart, dependencyEnd + 1);
  const dependencyPrefix = `        ${JSON.stringify(value.name)}: `;
  const pins = dependencies.split("\n").filter((line) => line.startsWith(dependencyPrefix));
  const pin =
    pins.length === 1 && pins[0]!.endsWith(",") ? pins[0]!.slice(dependencyPrefix.length, -1) : "";
  if (!/^"[^"\\]+"$/u.test(pin) || !versionToken.test(pin.slice(1, -1))) {
    return false;
  }
  const selectedVersion = pin.slice(1, -1);
  const registryStart = source.indexOf('\n  "packages": {\n');
  if (
    registryStart < 0 ||
    source.includes(`\n    ${JSON.stringify(value.root)}: {\n`) ||
    source.slice(0, registryStart).includes(`\n      "name": ${JSON.stringify(value.name)},\n`)
  ) {
    return false;
  }
  const key = `    ${JSON.stringify(value.name)}: `;
  const prefix = `${key}[${JSON.stringify(`${value.name}@${selectedVersion}`)}, "", {`;
  const entries = source
    .slice(registryStart)
    .split("\n")
    .filter((line) => line.startsWith(key));
  if (entries.length !== 1 || !entries[0]!.startsWith(prefix)) {
    return false;
  }
  const integrity = /\}, "sha512-([A-Za-z0-9+/]{86}==)"\],$/u.exec(entries[0]!);
  return (
    integrity !== null && Buffer.from(integrity[1]!, "base64").toString("base64") === integrity[1]
  );
}

function projectWorkspaceVersions(
  source: string,
  versions: readonly ReleasePackageVersion[],
): string | undefined {
  if (!Array.isArray(versions)) {
    return undefined;
  }
  const roots = new Set<string>();
  const names = new Set<string>();
  let expected = source;
  for (const value of versions) {
    if (!validVersionTuple(value) || roots.has(value.root) || names.has(value.name)) {
      return undefined;
    }
    roots.add(value.root);
    names.add(value.name);
    const before = workspaceAnchor(value, value.baseVersion);
    const index = source.indexOf(before);
    if (index < 0 && retainedRegistrySelection(source, value)) {
      continue;
    }
    if (index < 0 || source.lastIndexOf(before) !== index) {
      return undefined;
    }
    expected = expected.replace(before, workspaceAnchor(value, value.headVersion));
  }
  return expected;
}

// The caller binds tuples to its catalog and validated release manifests. The
// trusted base is the pinned Bun serializer's existing lock, not caller JSON.
// Preserve every other byte; parsing or normalizing JSONC would widen this rule.
export function releaseBunLockViolations(
  base: Buffer | undefined,
  head: Buffer | undefined,
  versions: readonly ReleasePackageVersion[],
): string[] {
  if (base === undefined && head === undefined) {
    return [];
  }
  if (!Buffer.isBuffer(base) || !Buffer.isBuffer(head)) {
    return ["release pull request must preserve the existing Bun lockfile"];
  }
  const baseText = base.toString("utf8");
  const headText = head.toString("utf8");
  if (!Buffer.from(baseText, "utf8").equals(base) || !Buffer.from(headText, "utf8").equals(head)) {
    return ["release pull request Bun lock must contain valid UTF-8 bytes"];
  }
  if (!baseText.startsWith(canonicalPrefix) || !headText.startsWith(canonicalPrefix)) {
    return ["release pull request requires canonical Bun lockfileVersion 2/configVersion 1 locks"];
  }
  const expected = projectWorkspaceVersions(baseText, versions);
  if (expected === undefined) {
    return [
      "release pull request Bun lock requires unique exact public workspace version preimages",
    ];
  }
  return Buffer.from(expected, "utf8").equals(head)
    ? []
    : ["release pull request Bun lock may change only the exact released workspace versions"];
}
