import { isAbsolute, join, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { repositoryRoot } from "./check-test-manifests.mjs";

interface CoverageCacheEntry {
  url?: unknown;
  data?: { file?: unknown; sources?: unknown } | null;
}

interface CoverageReport {
  result: Array<{ url?: unknown }>;
  "source-map-cache"?: Record<string, CoverageCacheEntry | null> | null;
}

interface CoverageTestSource {
  sourceRoot: string;
  testPath: string;
}

function fail(message: string): never {
  throw new Error(`Coverage evidence is invalid: ${message}`);
}

// This is private CI layout policy: writers recognize only their checkout;
// aggregation additionally recognizes the fixed producer for this shard.
export function createCoverageSourceLayout(expectedTests: readonly string[], pairedSourceRoot?: string) {
  const sourceRoots = pairedSourceRoot === undefined
    ? [repositoryRoot]
    : [repositoryRoot, pairedSourceRoot];
  const expectedTestByUrl = new Map<string, CoverageTestSource>(
    sourceRoots.flatMap((sourceRoot) => expectedTests.map((testPath): [string, CoverageTestSource] => [
      pathToFileURL(join(sourceRoot, ...testPath.split("/"))).href,
      { sourceRoot, testPath },
    ])),
  );
  const knownRoots = (pairedSourceRoot === undefined ? sourceRoots : [
    join(repositoryRoot, "producer-a"), join(repositoryRoot, "producer-b"), repositoryRoot,
  ]).map((sourceRoot) => ({
    sourceRoot, prefix: pathToFileURL(`${sourceRoot}${sep}`).href,
  }));
  let observedSourceRoot: string | undefined;

  return (report: CoverageReport, filename: string): CoverageTestSource => {
    const matchedUrls = [...new Set(report.result.map((script) => script.url))]
      .filter((url): url is string => typeof url === "string" && expectedTestByUrl.has(url));
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
      const fileUrl = typeof url === "string" && isAbsolute(url) ? pathToFileURL(url).href : url;
      const knownRoot = knownRoots.find(({ prefix }) => typeof fileUrl === "string" && fileUrl.startsWith(prefix));
      if (knownRoot !== undefined && knownRoot.sourceRoot !== matchedTest.sourceRoot) {
        fail("raw coverage artifact mixes source roots");
      }
    }
    return matchedTest;
  };
}
