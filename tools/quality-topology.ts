import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { projectQualitySourceTopology } from "../packages/feature-module-standard/dist/quality-topology.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const profilePath = "architecture/foundation/quality-source-coverage.yaml";
const fmsPath = "architecture/foundation/feature-modules.json";
const topologyPath = "architecture/foundation/quality-source-topology.json";

/** Repository-owned projection; the versioned FMS mapper owns only its data transformation. */
export async function qualityTopologyProjection(root: string): Promise<string> {
  const [profileBytes, fmsBytes] = await Promise.all([
    readFile(resolve(root, profilePath)),
    readFile(resolve(root, fmsPath)),
  ]);
  const profile: unknown = parse(profileBytes.toString("utf8"));
  if (
    profile === null ||
    typeof profile !== "object" ||
    Array.isArray(profile) ||
    !("schemaVersion" in profile) ||
    profile.schemaVersion !== 5 ||
    !("sourcePolicyPath" in profile) ||
    typeof profile.sourcePolicyPath !== "string" ||
    !("topologyPath" in profile) ||
    profile.topologyPath !== topologyPath
  ) {
    throw new Error(
      "Quality topology generation requires the repository v5 profile and topology path.",
    );
  }
  const projected = projectQualitySourceTopology(
    JSON.parse(fmsBytes.toString("utf8")) as unknown,
    profile.sourcePolicyPath,
  );
  const derivedFrom = [
    { path: fmsPath, sha256: createHash("sha256").update(fmsBytes).digest("hex") },
    { path: profilePath, sha256: createHash("sha256").update(profileBytes).digest("hex") },
  ].toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return `${JSON.stringify({ ...projected, derivedFrom }, null, 2)}\n`;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || (args[0] !== "--check" && args[0] !== "--write")) {
    throw new Error("Usage: node tools/quality-topology.ts (--check|--write)");
  }
  const expected = await qualityTopologyProjection(repositoryRoot);
  const target = resolve(repositoryRoot, topologyPath);
  if (args[0] === "--write") {
    await writeFile(target, expected);
  } else if ((await readFile(target, "utf8")) !== expected) {
    throw new Error("Quality topology is stale; run node tools/quality-topology.ts --write.");
  }
}
