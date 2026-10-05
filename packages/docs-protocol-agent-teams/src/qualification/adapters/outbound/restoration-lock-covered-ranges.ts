/** Private covered-archive range admission; refusals retain the caller's diagnostics. */
function atOrAboveRangeMinimum(version: readonly [number, number, number],
  minimum: readonly [number, number, number]): boolean {
  const [major, minor, patch] = version, [loMajor, loMinor, loPatch] = minimum;
  return major > loMajor || major === loMajor && (minor > loMinor || minor === loMinor && patch >= loPatch);
}

export function admitsCoveredArchiveRange(range: string, version: string,
  need: (value: unknown, message: string) => asserts value): boolean {
  if (range === '*') {return true;}
  const match = /^([~^]?)(\d+)\.(\d+)\.(\d+)$/.exec(range);
  need(match && match[1] !== undefined && match[2] && match[3] && match[4], 'unsupported authenticated range: ' + range);
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  const loMajor = Number(match[2]), loMinor = Number(match[3]), loPatch = Number(match[4]);
  const above = atOrAboveRangeMinimum([major, minor, patch], [loMajor, loMinor, loPatch]);
  if (match[1] === '') {return version === `${loMajor}.${loMinor}.${loPatch}`;}
  if (match[1] === '~') {return above && major === loMajor && minor === loMinor;}
  return above && major === loMajor && (loMajor > 0 || minor === loMinor && (loMinor > 0 || patch === loPatch));
}
