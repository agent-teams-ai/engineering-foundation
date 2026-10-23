type Version = readonly [number, number, number, string];

export function parseVersion(value: string): Version | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/u.exec(value);
  return match === null
    ? undefined
    : [Number(match[1]), Number(match[2]), Number(match[3]), match.at(4) ?? ""];
}

function compareVersion(left: Version, right: Version): number {
  for (const index of [0, 1, 2] as const) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  if (left[3] === right[3]) {
    return 0;
  }
  if (left[3] === "") {
    return 1;
  }
  if (right[3] === "") {
    return -1;
  }
  return left[3] < right[3] ? -1 : 1;
}

export function acceptsVersion(version: string, requested: string): boolean {
  const actual = parseVersion(version);
  if (actual === undefined) {
    return false;
  }
  const alternatives = requested.split("||").map((part) => part.trim());
  return alternatives.some((alternative) => {
    if (alternative === "*" || alternative === "latest") {
      return true;
    }
    const exact = parseVersion(alternative);
    if (exact !== undefined) {
      return compareVersion(actual, exact) === 0;
    }
    const shorthand = /^(\^|~)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(alternative);
    if (shorthand !== null) {
      const lowerText = shorthand.at(2);
      const lower = lowerText === undefined ? undefined : parseVersion(lowerText);
      if (lower === undefined) {
        return false;
      }
      const upper: Version =
        shorthand[1] === "~"
          ? [lower[0], lower[1] + 1, 0, ""]
          : lower[0] > 0
            ? [lower[0] + 1, 0, 0, ""]
            : lower[1] > 0
              ? [0, lower[1] + 1, 0, ""]
              : [0, 0, lower[2] + 1, ""];
      return compareVersion(actual, lower) >= 0 && compareVersion(actual, upper) < 0;
    }
    const comparators = alternative.split(/\s+/u).filter(Boolean);
    return (
      comparators.length > 0 &&
      comparators.every((comparator) => {
        const match = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(comparator);
        if (match === null) {
          return false;
        }
        const lowerText = match.at(2);
        const lower = lowerText === undefined ? undefined : parseVersion(lowerText);
        if (lower === undefined) {
          return false;
        }
        const difference = compareVersion(actual, lower);
        return match[1] === ">="
          ? difference >= 0
          : match[1] === "<="
            ? difference <= 0
            : match[1] === ">"
              ? difference > 0
              : match[1] === "<"
                ? difference < 0
                : difference === 0;
      })
    );
  });
}

export function requestedVersion(
  specifier: string,
  packageName: string,
  catalogVersions: ReadonlyMap<string, string>,
): string {
  if (specifier === "catalog:") {
    const version = catalogVersions.get(packageName);
    if (version === undefined) {
      throw new Error(`Workspace catalog has no exact version for ${packageName}.`);
    }
    return version;
  }
  return specifier;
}
