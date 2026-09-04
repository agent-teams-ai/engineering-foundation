import { link, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

import { authenticatedMarkdownArchive } from "./markdown-bundle-evidence.mjs";
import { markdownSnapshotPlan } from "./markdown-source-snapshot.mjs";
import { readRegularArchive, sha256 } from "./pack-artifact-archive.mjs";
import { runNpmCommand } from "./pack-test-support.mjs";

async function cachedArchive(path, coordinate) {
  let bytes;
  try { bytes = await readRegularArchive(path); } catch (error) {
    if (error?.code === "ENOENT") { return; }
    throw error;
  }
  authenticatedMarkdownArchive({ ...coordinate, archive: bytes });
  return bytes;
}

async function acquireArchive(coordinate, cacheRoot, runNpm) {
  const cachedPath = join(cacheRoot, `${sha256(coordinate.integrity)}.tgz`);
  const cached = await cachedArchive(cachedPath, coordinate);
  if (cached !== undefined) { return cached; }
  const destination = await mkdtemp(join(cacheRoot, "download-"));
  try {
    // Reuse npm's registry acquisition, retries and content cache, never execute
    // package lifecycle scripts or load the user's npm authentication config.
    const userConfig = join(destination, "empty-user.npmrc");
    const globalConfig = join(destination, "empty-global.npmrc");
    await writeFile(userConfig, "", { flag: "wx" });
    await writeFile(globalConfig, "", { flag: "wx" });
    await runNpm([
      "pack", `${coordinate.name}@${coordinate.version}`, "--ignore-scripts", "--json",
      "--registry=https://registry.npmjs.org/", "--pack-destination", destination,
      "--cache", join(cacheRoot, "npm-cache"), "--userconfig", userConfig, "--globalconfig", globalConfig,
      "--fetch-retries=2", "--fetch-timeout=15000", "--loglevel=error",
    ], destination, {
      timeoutMs: 60_000,
      environment: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !/^(?:npm_config_|npm_token$|node_auth_token$)/iu.test(key))),
    });
    const filename = `${coordinate.name.replace(/^@/u, "").replace("/", "-")}-${coordinate.version}.tgz`;
    const path = join(destination, filename);
    const bytes = await readRegularArchive(path);
    authenticatedMarkdownArchive({ ...coordinate, archive: bytes });
    try { await link(path, cachedPath); } catch (error) {
      if (error?.code !== "EEXIST") { throw error; }
      await cachedArchive(cachedPath, coordinate);
    }
    return bytes;
  } finally { await rm(destination, { recursive: true, force: true }); }
}

// Complete acquisition before any hermetic build begins. The returned reader
// has no network/cache-miss fallback and accepts only this lock's coordinates.
export async function acquireMarkdownArchives({ sourceLockBytes, cacheRoot, runNpm = runNpmCommand }) {
  if (!Buffer.isBuffer(sourceLockBytes) || sourceLockBytes.length > 8 * 1024 * 1024) {
    throw new Error("Markdown archive acquisition requires bounded original lock bytes.");
  }
  const capturedLock = Buffer.from(sourceLockBytes);
  const plan = markdownSnapshotPlan(parse(capturedLock.toString("utf8")));
  await mkdir(cacheRoot, { recursive: true });
  const metadata = await lstat(cacheRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) { throw new Error("Markdown archive cache must be a real directory."); }
  const coordinates = [...new Map([...plan.nodes.values()].map(node => [node.integrity, node])).values()];
  const archives = new Map();
  let index = 0;
  const acquire = async () => {
    while (index < coordinates.length) {
      const coordinate = coordinates[index++];
      const bytes = await acquireArchive(coordinate, cacheRoot, runNpm);
      archives.set(`${coordinate.name}@${coordinate.version}:${coordinate.integrity}`, bytes);
    }
  };
  const results = await Promise.allSettled(Array.from({ length: Math.min(4, coordinates.length) }, acquire));
  const failure = results.find(result => result.status === "rejected");
  if (failure !== undefined) { throw failure.reason; }
  return async ({ name, version, integrity }) => {
    const archive = archives.get(`${name}@${version}:${integrity}`);
    if (archive === undefined) { throw new Error("Original Markdown archive was not acquired before hermetic staging."); }
    return archive;
  };
}
