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
