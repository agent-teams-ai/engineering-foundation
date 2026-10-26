import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const productSourceBase = "15f6175bd2b36876b0d8754ea679167cffaeb2dc";
const title = "binds a breaking approval to its exact fingerprint and immutable ADR identity";
const testPath = "tests/capability-public-api.test.mjs";
const iterations = 10;
const iterationTimeoutMs = 120_000;
const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = process.env["RUNNER_TEMP"];
if (temporary === undefined || !isAbsolute(temporary)) {
  throw new Error("Diagnostic requires an absolute RUNNER_TEMP.");
}
const output = join(temporary, "native-context-postfix-661");
mkdirSync(output, { recursive: true });
const paths = [
  ".github/workflows/ci.yml",
  "scripts/diagnose-native-context.ts",
  "tests/support/capability-fixtures.mjs",
  testPath,
  "tests/support/native-public-api-fixture.ts",
  "packages/engineering-foundation/src/capabilities/public-api-compatibility/adapters/outbound/api-extractor/native-public-api-engine.ts",
  "packages/engineering-foundation/src/capabilities/public-api-compatibility/adapters/outbound/api-extractor/load-pinned-audit-sdk.ts",
  "packages/engineering-foundation/package.json",
  "package.json",
  "bun.lock",
  "pnpm-lock.yaml",
  "packages/engineering-foundation/src/capabilities/public-api-compatibility/application/ports/public-api-signature-equivalence.ts",
  "packages/engineering-foundation/src/capabilities/public-api-compatibility/adapters/outbound/api-extractor/native-type-parenthesis-equivalence.ts",
  "packages/engineering-foundation/src/capabilities/public-api-compatibility/application/policies/evaluate-public-api-compatibility.ts",
  "packages/engineering-foundation/src/capabilities/public-api-compatibility/application/use-cases/analyze-public-api-compatibility.ts",
  "packages/engineering-foundation/src/capabilities/public-api-compatibility/application/use-cases/promote-public-api-baselines.ts",
  "packages/engineering-foundation/src/capabilities/public-api-compatibility/application/use-cases/audit-public-api.ts",
  "packages/engineering-foundation/src/capabilities/public-api-compatibility/application/policies/evaluate-growth-release-compatibility.ts",
  "packages/engineering-foundation/src/capabilities/public-api-compatibility/application/use-cases/admit-sdk-growth.ts",
  "packages/engineering-foundation/src/capabilities/public-api-compatibility/application/policies/compare-package-artifact-inventory.ts",
  "packages/engineering-foundation/tests/public-api-native-async-cases.ts",
  "packages/engineering-foundation/tests/public-api-async-classification-cases.ts",
  "packages/engineering-foundation/tests/public-api-native-projection.test.ts",
  "packages/engineering-foundation/tests/public-api-native-extraction.test.ts",
  "packages/engineering-foundation/tests/public-api-native-transition.test.ts",
  "packages/engineering-foundation/tests/public-api-audit-projection.test.ts",
  "packages/engineering-foundation/tests/public-api-audit-inputs.test.mjs",
  "packages/engineering-foundation/tests/public-api-audit-command.test.mjs",
  "packages/engineering-foundation/tests/public-api-audit-observer.test.ts",
  "packages/engineering-foundation/tests/public-api-artifact-inventory.test.mjs",
  "tests/capability-public-api.test.mjs",
  "tests/public-api-default-type-equivalence.test.mjs",
  "tests/public-api-export-coverage.test.mjs",
  "tests/public-api-evidence-ports.test.mjs",
  "tests/public-api-growth-context.test.mjs",
  "tests/public-api-growth-execution.test.mjs",
  "tests/public-api-native-migration.test.ts",
  "tests/public-api-native-migration-cli.test.ts",
] as const;
function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function selectedHashes() {
  return paths.map((path) => ({ path, sha256: sha256(join(root, path)) }));
}
function snapshot(result: SpawnSyncReturns<string>) {
  return {
    ...result,
    error: result.error === undefined ? null : {
      name: result.error.name,
      code: "code" in result.error && typeof result.error.code === "string" ? result.error.code : null,
    },
  };
}
function gitHead(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL",
  });
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error("Diagnostic could not bind its checkout HEAD.");
  }
  const head = result.stdout.trim();
  if (!/^[a-f0-9]{40}$/u.test(head) || head !== process.env["GITHUB_SHA"]) {
    throw new Error("Diagnostic checkout HEAD differs from GITHUB_SHA.");
  }
  return head;
}
function packageIdentity(path: string) {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as {
    name?: unknown; version?: unknown; gitHead?: unknown;
  };
  return {
    path: realpathSync(path), sha256: sha256(path),
    name: typeof manifest.name === "string" ? manifest.name : null,
    version: typeof manifest.version === "string" ? manifest.version : null,
    gitHead: typeof manifest.gitHead === "string" ? manifest.gitHead : null,
  };
}
function runtimeIdentity(path: string) {
  const physicalPath = realpathSync(path);
  return { path, physicalPath, sha256: sha256(physicalPath) };
}
const head = gitHead();
if (process.platform !== "linux" || process.arch !== "x64" || process.version !== "v26.11.1") {
  throw new Error("Diagnostic requires Linux x64 and physical Node 26.11.1.");
}
const node = runtimeIdentity(process.execPath);
if (node.physicalPath !== process.env["AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE"]) {
  throw new Error("Diagnostic Node differs from the bound physical runtime.");
}
const bunPath = process.env["AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE"];
if (bunPath === undefined || !isAbsolute(bunPath)) {
  throw new Error("Diagnostic requires the selected absolute Bun executable.");
}
const bun = runtimeIdentity(bunPath);
const bunVersion = spawnSync(bun.physicalPath, ["--version"], {
  encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL",
});
writeFileSync(join(output, "bun-version-result.json"), JSON.stringify(snapshot(bunVersion), null, 2) + "\n");
if (bunVersion.status !== 0 || bunVersion.stdout.trim() !== "1.4.3") {
  throw new Error("Diagnostic requires Bun 1.4.3.");
}
const sdkRequire = createRequire(new URL(
  "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/load-pinned-audit-sdk.js",
  import.meta.url,
));
const compilerPath = sdkRequire.resolve("typescript/package.json");
const compiler = packageIdentity(compilerPath);
const compilerRoot = dirname(compilerPath);
const sdkSourceFiles = [
  "dist/api/async/api.js",
  "dist/api/async/client.js",
  "dist/api/sync/api.js",
  "dist/api/sync/client.js",
  "dist/api/syncChannel.js",
].map((relativePath) => {
  const path = realpathSync(join(compilerRoot, relativePath));
  return { relativePath, path, sha256: sha256(path) };
});
const sdkPublicEntrypoints = ["typescript/unstable/async", "typescript/unstable/sync"].map(
  (specifier) => {
    const path = realpathSync(sdkRequire.resolve(specifier));
    return { specifier, path, sha256: sha256(path) };
  },
);
const native = packageIdentity(createRequire(compilerPath).resolve(
  "@typescript/typescript-linux-x64/package.json",
));
const model = packageIdentity(join(dirname(dirname(sdkRequire.resolve("@microsoft/api-extractor-model"))), "package.json"));
if (compiler.version !== "7.0.2" || native.version !== "7.0.2" || model.version !== "7.33.10") {
  throw new Error("Diagnostic native SDK identity is unsupported.");
}
const nativeCompiler = runtimeIdentity(join(dirname(native.path), "lib", "tsc"));
const before = selectedHashes();
writeFileSync(join(output, "metadata.json"), JSON.stringify({
  classification: "diagnostic-only-not-qualification", productSourceBase, head,
  platform: process.platform, arch: process.arch, nodeVersion: process.version,
  nodeVersions: process.versions, node, bun, bunVersion: bunVersion.stdout.trim(),
  sdk: { compiler, native, model, nativeCompiler }, sdkSourceFiles, sdkPublicEntrypoints,
  selectedFileHashes: before,
  title, testPath, iterations, expectedCliCallsPerSuccessfulIteration: 4,
  iterationTimeoutMs, perStreamMaxBufferBytes: 64 * 1024 * 1024,
  runId: process.env["GITHUB_RUN_ID"] ?? null,
  runAttempt: process.env["GITHUB_RUN_ATTEMPT"] ?? null,
}, null, 2) + "\n");
const pattern = "^" + title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") + "$";
const cliResultsPath = join(output, "cli-results.jsonl");
writeFileSync(cliResultsPath, "", { flag: "wx" });
writeFileSync(join(output, "iteration-results.jsonl"), "", { flag: "wx" });
const records = [];
let abandonmentReason: string | null = null;
for (let iteration = 1; iteration <= iterations; iteration += 1) {
  const started = Date.now();
  const result = spawnSync(node.physicalPath, [
    "--test", `--test-name-pattern=${pattern}`, "--test-reporter=tap", testPath,
  ], {
    cwd: root, encoding: "utf8", timeout: iterationTimeoutMs, killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, EF_NATIVE_CONTEXT_DIAGNOSTIC_ITERATION: String(iteration) },
  });
  const prefix = `iteration-${String(iteration).padStart(2, "0")}`;
  writeFileSync(join(output, `${prefix}.stdout.tap`), result.stdout ?? "");
  writeFileSync(join(output, `${prefix}.stderr.log`), result.stderr ?? "");
  const record = { iteration, startedAt: new Date(started).toISOString(),
    elapsedMs: Date.now() - started, result: snapshot(result) };
  writeFileSync(join(output, `${prefix}.result.json`), JSON.stringify(record, null, 2) + "\n");
  appendFileSync(join(output, "iteration-results.jsonl"), JSON.stringify(record) + "\n");
  records.push(record);
  process.stdout.write(`Diagnostic iteration ${iteration}/${iterations}\n`);
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error !== undefined || result.signal !== null) {
    abandonmentReason = "diagnostic-abandoned-uncertain-process-cleanup";
    break;
  }
}
let cliObservations = 0;
try {
  cliObservations = readFileSync(cliResultsPath, "utf8").split("\n").filter(Boolean).length;
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
const failedIterations = records.filter(({ result }) =>
  result.status !== 0 || result.signal !== null || result.error !== null,
).length;
const after = selectedHashes();
const sourceUnchanged = gitHead() === head && JSON.stringify(before) === JSON.stringify(after);
const summary = {
  classification: "diagnostic-only-not-qualification",
  outcome: abandonmentReason !== null ? "diagnostic-abandoned" :
    sourceUnchanged ? "diagnostic-completed" : "diagnostic-source-changed",
  head, productSourceBase, requestedIterations: iterations, completedIterations: records.length,
  abandonedRemaining: abandonmentReason === null ? 0 : iterations - records.length,
  abandonmentReason,
  failedIterations, successfulIterations: records.length - failedIterations,
  expectedCliCallsIfAllIterationsReachAllChecks: 40, actualCliObservations: cliObservations,
  sourceUnchanged, selectedFileHashesAfter: after,
  qualification: false,
};
writeFileSync(join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
process.stdout.write(JSON.stringify(summary) + "\n");
// A completed diagnostic retains failures; this exit is never product qualification.
process.exitCode = abandonmentReason === null && sourceUnchanged && records.length === iterations ? 0 : 1;
