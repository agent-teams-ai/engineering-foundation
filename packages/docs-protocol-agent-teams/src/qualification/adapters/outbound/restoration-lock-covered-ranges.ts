/** Private covered-archive range admission; refusals retain the caller's diagnostics. */
function atOrAboveRangeMinimum(version: readonly [number, number, number],
  minimum: readonly [number, number, number]): boolean {
  const [major, minor, patch] = version, [loMajor, loMinor, loPatch] = minimum;
  return major > loMajor || major === loMajor && (minor > loMinor || minor === loMinor && patch >= loPatch);
}

function parseCoveredArchiveRange(range: string,
  need: (value: unknown, message: string) => asserts value): {
    modifier: string; minimum: readonly [number, number, number];
  } {
  const match = /^([~^]?)(\d+)\.(\d+)\.(\d+)$/.exec(range);
  need(match !== null && match[1] !== undefined &&
    typeof match[2] === 'string' && match[2].length > 0 &&
    typeof match[3] === 'string' && match[3].length > 0 &&
    typeof match[4] === 'string' && match[4].length > 0, 'unsupported authenticated range: ' + range);
  return { modifier: match[1], minimum: [Number(match[2]), Number(match[3]), Number(match[4])] };
}

export function admitsCoveredArchiveRange(range: string, version: string,
  need: (value: unknown, message: string) => asserts value): boolean {
  if (range === '*') {return true;}
  const { modifier, minimum } = parseCoveredArchiveRange(range, need);
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  const [loMajor, loMinor, loPatch] = minimum;
  const above = atOrAboveRangeMinimum([major, minor, patch], minimum);
  if (modifier === '') {return version === `${loMajor}.${loMinor}.${loPatch}`;}
  if (modifier === '~') {return above && major === loMajor && minor === loMinor;}
  return above && major === loMajor && (loMajor > 0 || minor === loMinor && (loMinor > 0 || patch === loPatch));
}
