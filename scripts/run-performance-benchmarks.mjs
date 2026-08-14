import { spawn } from "node:child_process";
import { appendFile, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

const marker = "FOUNDATION_BENCHMARK ";
const defaultCounts = Object.freeze([100, 1_000, 5_000]);
const benchmarkContract = Object.freeze({
  "document-catalog-filesystem": Object.freeze(["coldMilliseconds", "warmMilliseconds"]),
  "document-find-memory": Object.freeze(["medianMilliseconds", "p95Milliseconds", "samples"]),
});

function expectedCounts(environment = process.env) {
  return environment.FOUNDATION_PERFORMANCE_COUNTS === undefined
    ? defaultCounts
    : environment.FOUNDATION_PERFORMANCE_COUNTS.split(",").map(Number);
}

export function parseBenchmarkRecords(output) {
  const records = [];
  for (const line of output.split(/\r?\n/u)) {
    const index = line.indexOf(marker);
    if (index === -1) {
      continue;
    }
    const record = JSON.parse(line.slice(index + marker.length));
    if (
      record === null ||
      typeof record !== "object" ||
      typeof record.benchmark !== "string" ||
      !(record.benchmark in benchmarkContract) ||
      !Number.isSafeInteger(record.count) ||
      record.count < 1 ||
      record.measurements === null ||
      typeof record.measurements !== "object" ||
      Array.isArray(record.measurements)
    ) {
      throw new Error("Benchmark emitted an invalid record");
    }
    const measurementKeys = Object.keys(record.measurements).toSorted();
    if (measurementKeys.join("\0") !== [...benchmarkContract[record.benchmark]].toSorted().join("\0")) {
      throw new Error("Benchmark emitted unexpected measurement keys");
    }
    for (const value of Object.values(record.measurements)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error("Benchmark measurement must be a finite non-negative number");
      }
    }
    records.push(record);
  }
  const expectedPairs = Object.keys(benchmarkContract).flatMap((benchmark) =>
    expectedCounts().map((count) => `${benchmark}\0${count}`),
  ).toSorted();
  const actualPairs = records.map(({ benchmark, count }) => `${benchmark}\0${count}`).toSorted();
  if (actualPairs.join("\u0001") !== expectedPairs.join("\u0001")) {
    throw new Error("Benchmark records do not match the exact benchmark/count contract");
  }
  return records;
}

export function performanceArtifact(records, environment = process.env) {
  return {
    schemaVersion: 1,
    advisory: true,
    generatedAt: new Date().toISOString(),
    repository: environment.GITHUB_REPOSITORY ?? null,
    headSha: environment.GITHUB_SHA ?? null,
    runId: environment.GITHUB_RUN_ID ?? null,
    runAttempt: environment.GITHUB_RUN_ATTEMPT ?? null,
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      runnerImage: environment.ImageOS ?? null,
    },
    records,
  };
}

function outputArgument(arguments_) {
  const index = arguments_.findIndex((argument) => argument === "--output");
  return index === -1 ? undefined : arguments_[index + 1];
}

async function run() {
  const child = spawn(process.execPath, [
    "--test",
    "--test-concurrency=1",
    "--test-name-pattern=benchmark",
    "tests/document-catalog.test.mjs",
    "tests/document-find.test.mjs",
  ], {
    cwd: process.cwd(),
    env: { ...process.env, FOUNDATION_PERFORMANCE: "1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
  });
  if (exitCode !== 0) {
    process.exitCode = exitCode;
    return;
  }
  const records = parseBenchmarkRecords(output);
  const artifact = performanceArtifact(records);
  const outputPath = outputArgument(process.argv.slice(2));
  if (outputPath !== undefined) {
    await writeFile(resolvePath(outputPath), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  }
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    const rows = records.map((record) => {
      const values = Object.entries(record.measurements)
        .map(([name, value]) => name === "samples" ? `${name}=${value}` : `${name}=${value.toFixed(1)}ms`)
        .join(", ");
      return `| ${record.benchmark} | ${record.count} | ${values} |`;
    });
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      [`## Advisory performance`, "", "Timings are historical signals, not blocking budgets.", "", "| Benchmark | Documents | Measurements |", "|---|---:|---|", ...rows, ""].join("\n"),
      "utf8",
    );
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolvePath(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  await run();
}
