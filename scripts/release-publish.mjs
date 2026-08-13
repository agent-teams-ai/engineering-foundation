import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const allowedPrereleaseTag = "rc";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function releasePublishPolicy({ packageVersion, preState }) {
  const prerelease = packageVersion.includes("-");
  if (!prerelease) {
    if (preState !== undefined) {
      throw new Error("Stable publication is forbidden while Changesets prerelease state exists.");
    }
    return { tag: undefined };
  }
  if (
    !isRecord(preState) ||
    preState.mode !== "pre" ||
    preState.tag !== allowedPrereleaseTag ||
    !new RegExp(`-${allowedPrereleaseTag}\\.\\d+$`, "u").test(packageVersion)
  ) {
    throw new Error("Prerelease publication requires exact Changesets rc mode and an -rc.N package version.");
  }
  return { tag: allowedPrereleaseTag };
}

export function changesetsPublishArguments() {
  return ["changeset", "publish"];
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function main() {
  const manifest = await readJson("packages/engineering-foundation/package.json");
  let preState;
  try {
    preState = await readJson(".changeset/pre.json");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  releasePublishPolicy({
    packageVersion: manifest.version,
    preState,
  });
  const publishArguments = changesetsPublishArguments();
  const result = spawnSync("pnpm", publishArguments, { stdio: "inherit" });
  if (result.error !== undefined) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  await main();
}
