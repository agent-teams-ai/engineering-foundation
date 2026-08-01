const EXACT_SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isExactVersion(value: string): boolean {
  return EXACT_SEMVER_PATTERN.test(value);
}

interface ParsedVersion {
  readonly core: readonly [bigint, bigint, bigint];
  readonly prerelease: readonly string[];
}

function parseExactVersion(value: string): ParsedVersion {
  const match = EXACT_SEMVER_PATTERN.exec(value);
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    throw new TypeError(`Invalid exact semantic version: ${value}.`);
  }
  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease: match[4]?.split(".") ?? []
  };
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareExactVersions(left: string, right: string): number {
  const leftVersion = parseExactVersion(left);
  const rightVersion = parseExactVersion(right);
  for (let index = 0; index < leftVersion.core.length; index += 1) {
    const leftPart = leftVersion.core[index];
    const rightPart = rightVersion.core[index];
    if (leftPart === undefined || rightPart === undefined) {
      throw new TypeError("Invalid internal semantic-version core.");
    }
    if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }
  if (leftVersion.prerelease.length === 0 || rightVersion.prerelease.length === 0) {
    return leftVersion.prerelease.length === rightVersion.prerelease.length
      ? 0
      : leftVersion.prerelease.length === 0
        ? 1
        : -1;
  }
  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    const comparison = compareIdentifier(leftPart, rightPart);
    if (comparison !== 0) {
      return comparison;
    }
  }
  return 0;
}

export type SemanticVersionBump = "major" | "minor" | "patch";

export function semanticVersionBumpBetween(
  released: string,
  candidate: string
): SemanticVersionBump | undefined {
  if (compareExactVersions(released, candidate) >= 0) {
    return undefined;
  }
  const releasedVersion = parseExactVersion(released);
  const candidateVersion = parseExactVersion(candidate);
  if (releasedVersion.core[0] !== candidateVersion.core[0]) {
    return "major";
  }
  if (releasedVersion.core[1] !== candidateVersion.core[1]) {
    return "minor";
  }
  return "patch";
}
