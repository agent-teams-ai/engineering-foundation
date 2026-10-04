import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { repositoryRoot } from "./check-test-manifests.mjs";

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function projectPairedCoverage(bytes, sourceRoot) {
  const sourcePrefix = pathToFileURL(`${sourceRoot}${sep}`).href;
  const canonicalPrefix = pathToFileURL(`${repositoryRoot}${sep}`).href;
  function project(value) {
    if (typeof value !== "string") {
      return value;
    }
    if (value.startsWith(sourcePrefix)) {
      const url = new URL(value);
      if (!url.href.startsWith(sourcePrefix) || !fileURLToPath(url).startsWith(`${sourceRoot}${sep}`)) {
        throw new Error("Coverage evidence is invalid: paired URL escapes its source root");
      }
      return `${canonicalPrefix}${url.href.slice(sourcePrefix.length)}`;
    }
    if (isAbsolute(value) && value.startsWith(`${sourceRoot}${sep}`)) {
      const path = resolve(value);
      if (!path.startsWith(`${sourceRoot}${sep}`)) {
        throw new Error("Coverage evidence is invalid: paired source path escapes its source root");
      }
      return join(repositoryRoot, path.slice(sourceRoot.length + 1));
    }
    return value;
  }
  const report = JSON.parse(bytes.toString("utf8"));
  for (const script of report.result) {
    script.url = project(script.url);
  }
  if (report["source-map-cache"] !== undefined) {
    const cache = new Map();
    const cacheIdentities = new Set();
    for (const [key, entry] of Object.entries(report["source-map-cache"])) {
      const projectedKey = project(key);
      const keyIdentity = projectedKey.startsWith("file:")
        ? pathToFileURL(fileURLToPath(projectedKey)).href
        : projectedKey;
      if (cacheIdentities.has(keyIdentity)) {
        throw new Error("Coverage evidence is invalid: paired source map key projection collides");
      }
      cacheIdentities.add(keyIdentity);
      if (projectedKey !== key && entry !== null && typeof entry === "object") {
        entry.url = project(entry.url);
        if (entry.data !== null && entry.data !== undefined) {
          const data = entry.data;
          // Node resolves sources to absolute URLs and clears sourceRoot before
          // persisting this cache. Fail closed rather than moving a relative
          // source into governed production code when its generated URL moves.
          const isAbsoluteSource = (source) => typeof source === "string" &&
            (isAbsolute(source) || /^[a-z][a-z\d+.-]*:/iu.test(source));
          if ((data.sourceRoot !== undefined && data.sourceRoot !== "") || !Array.isArray(data.sources) ||
              data.sources.some((source) => !isAbsoluteSource(source)) ||
              (data.sources.length === 0 && data.file !== undefined && !isAbsoluteSource(data.file))) {
            throw new Error("Coverage evidence is invalid: paired source map sources must be absolute with an empty sourceRoot");
          }
          data.sources = data.sources.map(project);
          data.file = project(data.file);
        }
      }
      cache.set(projectedKey, entry);
    }
    report["source-map-cache"] = Object.fromEntries(cache);
  }
  return Buffer.from(`${JSON.stringify(report)}\n`);
}

export async function materializeValidatedRawCoverage(validated, outputDirectory, faultInjector) {
  await faultInjector?.({ phase: "after-validation" });
  for (const { evidence, sourceRoot, validatedFiles } of validated.artifacts) {
    const pairedSourceRoot = join(repositoryRoot, Number(evidence.shard.id) % 2 === 1 ? "producer-a" : "producer-b");
    if (sourceRoot !== repositoryRoot && sourceRoot !== pairedSourceRoot) {
      throw new Error("Coverage evidence is invalid: retained source root is not a fixed shard producer");
    }
    for (const { bytes, name } of validatedFiles) {
      const record = evidence.rawFiles.find(({ path }) => basename(path) === name);
      if (record === undefined || record.sha256 !== digest(bytes) || record.size !== bytes.byteLength) {
        throw new Error(
          `Coverage evidence is invalid: shard ${evidence.shard.id} retained raw bytes differ from validated evidence`,
        );
      }
      const outputBytes = sourceRoot === repositoryRoot ? bytes : projectPairedCoverage(bytes, sourceRoot);
      await writeFile(join(outputDirectory, `${evidence.shard.id}-${name}`), outputBytes, { flag: "wx" });
    }
  }
}
