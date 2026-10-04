// @ts-check

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { repositoryRoot } from "./check-test-manifests.mjs";

/** @typedef {import("./coverage-source-layout.mts").CoverageCacheEntry} CoverageCacheEntry */
/** @typedef {import("./coverage-source-layout.mts").CoverageTestSource} CoverageTestSource */
/** @typedef {import("./coverage-source-layout.mts").CoverageTestIdentifier} CoverageTestIdentifier */
/** @typedef {import("./coverage-source-layout.mts").CoverageProjector} CoverageProjector */
/** @typedef {import("./coverage-source-layout.mts").ValidatedCoverage} ValidatedCoverage */

/** @param {string} message @returns {never} */
function fail(message) {
  throw new Error(`Coverage evidence is invalid: ${message}`);
}

/** @param {unknown} value @returns {string | undefined} */
function coverageFileUrl(value) {
  if (typeof value !== "string") {
    return;
  }
  if (isAbsolute(value)) {
    return pathToFileURL(resolve(value)).href;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    if (/^file:/iu.test(value)) {
      fail("invalid local coverage address");
    }
    return;
  }
  if (url.protocol !== "file:") {
    return;
  }
  try {
    if (/%(?:2f|5c)/iu.test(url.pathname)) {
      fail("invalid local coverage address");
    }
    return pathToFileURL(resolve(fileURLToPath(url))).href;
  } catch {
    fail("invalid local coverage address");
  }
}

/** @param {unknown} value @param {{ sourceRoot: string; prefix: string }} root */
function hasSourcePrefix(value, root) {
  return typeof value === "string" && (value.startsWith(root.prefix) ||
    (isAbsolute(value) && value.startsWith(`${root.sourceRoot}${sep}`)));
}

/**
 * @param {unknown} value
 * @param {readonly { sourceRoot: string; prefix: string }[]} knownRoots
 * @param {string} expectedRoot
 */
function assertCoverageSourceAddress(value, knownRoots, expectedRoot) {
  const fileUrl = coverageFileUrl(value);
  if (fileUrl === undefined) {
    return;
  }
  const rawRoot = knownRoots.find((root) => hasSourcePrefix(value, root));
  const normalizedRoot = knownRoots.find(({ prefix }) => fileUrl.startsWith(prefix));
  if (rawRoot !== undefined && rawRoot.sourceRoot !== normalizedRoot?.sourceRoot) {
    fail("paired URL escapes its source root");
  }
  if (normalizedRoot !== undefined && rawRoot === undefined) {
    fail("non-canonical coverage source alias");
  }
  if (normalizedRoot !== undefined && normalizedRoot.sourceRoot !== expectedRoot) {
    fail("raw coverage artifact mixes source roots");
  }
}

// Writers recognize only their checkout; aggregation additionally recognizes
// the fixed producer for this shard. Keep this runtime in the existing .mjs
// transport so covered workers do not initialize Node's TypeScript loader.
/**
 * @param {readonly string[]} expectedTests
 * @param {string} [pairedSourceRoot]
 * @returns {CoverageTestIdentifier}
 */
export function createCoverageSourceLayout(expectedTests, pairedSourceRoot) {
  const sourceRoots = pairedSourceRoot === undefined
    ? [repositoryRoot]
    : [repositoryRoot, pairedSourceRoot];
  const expectedTestByUrl = new Map(
    sourceRoots.flatMap((sourceRoot) => expectedTests.map((testPath) =>
      /** @type {[string, CoverageTestSource]} */ ([
        pathToFileURL(join(sourceRoot, ...testPath.split("/"))).href,
        { sourceRoot, testPath },
      ]))),
  );
  const knownRoots = (pairedSourceRoot === undefined ? sourceRoots : [
    join(repositoryRoot, "a"), join(repositoryRoot, "b"), repositoryRoot,
  ]).map((sourceRoot) => ({
    sourceRoot, prefix: pathToFileURL(`${sourceRoot}${sep}`).href,
  }));
  /** @type {string | undefined} */
  let observedSourceRoot;
  /** @param {unknown} url @returns {url is string} */
  function isExpectedTestUrl(url) {
    return typeof url === "string" && expectedTestByUrl.has(url);
  }

  return (report, filename) => {
    const matchedUrls = [...new Set(report.result.map((script) => script.url))].filter(isExpectedTestUrl);
    const matchedTest = expectedTestByUrl.get(matchedUrls[0]);
    if (matchedUrls.length !== 1 || matchedTest === undefined) {
      fail(`raw coverage file ${filename} does not contain exactly one expected shard test`);
    }
    observedSourceRoot ??= matchedTest.sourceRoot;
    if (observedSourceRoot !== matchedTest.sourceRoot) {
      fail("raw coverage artifact mixes source roots");
    }
    const urls = [
      ...report.result.map((script) => script.url),
      ...Object.entries(report["source-map-cache"] ?? {}).flatMap(([key, cache]) => [
        key, cache?.url, cache?.data?.file,
        ...(Array.isArray(cache?.data?.sources) ? cache.data.sources : []),
      ]),
    ];
    for (const url of urls) {
      assertCoverageSourceAddress(url, knownRoots, matchedTest.sourceRoot);
    }
    return matchedTest;
  };
}

/** @param {Uint8Array} bytes @returns {string} */
function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** @param {unknown} source @returns {source is string} */
function isAbsoluteSource(source) {
  return typeof source === "string" &&
    (isAbsolute(source) || /^[a-z][a-z\d+.-]*:/iu.test(source));
}

/** @param {unknown} entry @param {CoverageProjector} project */
function projectSourceMapEntry(entry, project) {
  if (entry === null || typeof entry !== "object") {
    return;
  }
  const cacheEntry = /** @type {CoverageCacheEntry} */ (entry);
  cacheEntry.url = project(cacheEntry.url);
  const data = cacheEntry.data;
  if (data === null || data === undefined) {
    return;
  }
  // Node resolves sources to absolute URLs and clears sourceRoot before
  // persisting this cache. Fail closed rather than moving a relative
  // source into governed production code when its generated URL moves.
  if ((data.sourceRoot !== undefined && data.sourceRoot !== "") || !Array.isArray(data.sources) ||
      data.sources.some((source) => !isAbsoluteSource(source)) ||
      (data.sources.length === 0 && data.file !== undefined && !isAbsoluteSource(data.file))) {
    throw new Error("Coverage evidence is invalid: paired source map sources must be absolute with an empty sourceRoot");
  }
  data.sources = data.sources.map(project);
  data.file = project(data.file);
}

/** @param {Buffer} bytes @param {string} sourceRoot @returns {Buffer} */
function projectPairedCoverage(bytes, sourceRoot) {
  const sourcePrefix = pathToFileURL(`${sourceRoot}${sep}`).href;
  const canonicalPrefix = pathToFileURL(`${repositoryRoot}${sep}`).href;
  const sourceAddress = { sourceRoot, prefix: sourcePrefix };
  /** @template Value @param {Value} value @returns {Value | string} */
  function project(value) {
    if (typeof value !== "string") {
      return value;
    }
    const fileUrl = coverageFileUrl(value);
    if (fileUrl === undefined) {
      return value;
    }
    const hasRawPrefix = hasSourcePrefix(value, sourceAddress);
    if (hasRawPrefix && !fileUrl.startsWith(sourcePrefix)) {
      fail("paired URL escapes its source root");
    }
    if (fileUrl.startsWith(sourcePrefix)) {
      if (!hasRawPrefix) {
        fail("non-canonical coverage source alias");
      }
      const projectedUrl = `${canonicalPrefix}${fileUrl.slice(sourcePrefix.length)}`;
      if (isAbsolute(value)) {
        return fileURLToPath(projectedUrl);
      }
      const url = new URL(value);
      return `${projectedUrl}${url.search}${url.hash}`;
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
      const keyIdentity = coverageFileUrl(projectedKey) ?? projectedKey;
      if (cacheIdentities.has(keyIdentity)) {
        throw new Error("Coverage evidence is invalid: paired source map key projection collides");
      }
      cacheIdentities.add(keyIdentity);
      if (projectedKey !== key) {
        projectSourceMapEntry(entry, project);
      }
      cache.set(projectedKey, entry);
    }
    report["source-map-cache"] = Object.fromEntries(cache);
  }
  return Buffer.from(`${JSON.stringify(report)}\n`);
}

/**
 * @param {ValidatedCoverage} validated
 * @param {string} outputDirectory
 * @param {(event: { phase: "after-validation" }) => void | Promise<void>} [faultInjector]
 */
export async function materializeValidatedRawCoverage(validated, outputDirectory, faultInjector) {
  await faultInjector?.({ phase: "after-validation" });
  for (const { evidence, sourceRoot, validatedFiles } of validated.artifacts) {
    const pairedSourceRoot = join(repositoryRoot, Number(evidence.shard.id) % 2 === 1 ? "a" : "b");
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
