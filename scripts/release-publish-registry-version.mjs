const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const rcVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.(0|[1-9]\d*)$/u;

export function parseStableVersion(version) {
  const match = stableVersionPattern.exec(version);
  return match === null ? undefined : match.slice(1).map(BigInt);
}

export function parseRcVersion(version) {
  const match = rcVersionPattern.exec(version);
  return match === null ? undefined : {
    core: match.slice(1, 4).map(BigInt), iteration: BigInt(match[4]),
  };
}

export function compareVersionCore(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] > right[index] ? 1 : -1;
    }
  }
  return 0;
}

export function parsePublishedVersion(version) {
  const stable = parseStableVersion(version);
  if (stable !== undefined) {
    return { core: stable, iteration: undefined };
  }
  return parseRcVersion(version);
}

export function comparePublishedVersions(left, right) {
  const coreComparison = compareVersionCore(left.core, right.core);
  if (coreComparison !== 0) {
    return coreComparison;
  }
  if (left.iteration === undefined || right.iteration === undefined) {
    if (left.iteration === right.iteration) {
      return 0;
    }
    return left.iteration === undefined ? 1 : -1;
  }
  if (left.iteration === right.iteration) {
    return 0;
  }
  return left.iteration > right.iteration ? 1 : -1;
}
