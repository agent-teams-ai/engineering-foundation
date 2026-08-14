import assert from "node:assert/strict";
import test from "node:test";

import {
  parseBenchmarkRecords,
  performanceArtifact,
} from "../scripts/run-performance-benchmarks.mjs";

function record(benchmark, count) {
  return {
    benchmark,
    count,
    measurements: {
      medianMilliseconds: count / 10,
      p95Milliseconds: count / 5,
      samples: 25,
    },
  };
}

test("performance signal parser accepts exactly six strict advisory records", () => {
  const expected = [
    { benchmark: "document-catalog-filesystem", count: 100, measurements: { coldMilliseconds: 1, warmMilliseconds: 1 } },
    { benchmark: "document-catalog-filesystem", count: 1_000, measurements: { coldMilliseconds: 1, warmMilliseconds: 1 } },
    { benchmark: "document-catalog-filesystem", count: 5_000, measurements: { coldMilliseconds: 1, warmMilliseconds: 1 } },
    record("document-find-memory", 100),
    record("document-find-memory", 1_000),
    record("document-find-memory", 5_000),
  ];
  const output = expected
    .map((value) => `# FOUNDATION_BENCHMARK ${JSON.stringify(value)}`)
    .join("\n");
  assert.deepEqual(parseBenchmarkRecords(output), expected);
  assert.throws(() => parseBenchmarkRecords(output.split("\n").slice(1).join("\n")), /exact benchmark\/count/u);
  assert.throws(() => parseBenchmarkRecords(output.replace('"count":1000', '"count":100')), /exact benchmark\/count/u);
  assert.throws(() => parseBenchmarkRecords(output.replace('"medianMilliseconds":10', '"medianMilliseconds":-1')), /finite non-negative/u);
});

test("performance artifact is explicitly advisory and source-bound", () => {
  const artifact = performanceArtifact([], {
    GITHUB_REPOSITORY: "example/test",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "2",
    ImageOS: "ubuntu24",
  });
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.advisory, true);
  assert.equal(artifact.repository, "example/test");
  assert.equal(artifact.headSha, "a".repeat(40));
  assert.equal(artifact.runId, "123");
  assert.equal(artifact.runAttempt, "2");
  assert.equal(artifact.environment.runnerImage, "ubuntu24");
});
