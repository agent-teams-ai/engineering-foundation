import { inspectCompressedTarArchive, sha256 } from "./pack-artifact-archive.mjs";
export function describeArchiveDifference(
  firstBytes: Buffer,
  secondBytes: Buffer,
  packageName: string,
): string {
  let firstEntries;
  let secondEntries;
  try {
    firstEntries = inspectCompressedTarArchive(firstBytes, packageName).entries;
    secondEntries = inspectCompressedTarArchive(secondBytes, packageName).entries;
  } catch (error) {
    return `archive structure inspection failed: ${error instanceof Error ? error.message : "unknown error"}`;
  }
  if (firstEntries.length !== secondEntries.length) {
    return `entry counts differ (${firstEntries.length} != ${secondEntries.length})`;
  }
  for (let index = 0; index < firstEntries.length; index += 1) {
    const first = firstEntries[index];
    const second = secondEntries[index];
    if (first === undefined || second === undefined) {
      return `entry ${index} is missing from the inspected archive structure`;
    }
    if (first.name !== second.name || first.type !== second.type || first.size !== second.size) {
      return `entry ${index} metadata differs (${first.name}:${first.type}:${first.size} != ${second.name}:${second.type}:${second.size})`;
    }
    const firstDigest = sha256(first.data);
    const secondDigest = sha256(second.data);
    if (firstDigest !== secondDigest) {
      return `entry ${first.name} content differs (${firstDigest} != ${secondDigest})`;
    }
  }
  return "payload entries match; tar headers or gzip metadata differ";
}
