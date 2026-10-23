import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

import { runCommand } from "./pack-test-support.mjs";

type CommandResult = Readonly<{ stdout: string; stderr: string }>;
type RunPnpm = (arguments_: string[], directory: string) => Promise<CommandResult>;
type PackedArtifact = Readonly<{
  archivePath: string;
  archiveFileSpecifier?: string;
  packageName: string;
  packageVersion: string;
}>;
type InstalledQualification = Readonly<{ status: "passed"; cases: number }>;

const packageName = "@agent-teams/release-checks";

// The same public import probe runs against the qualified archive and the
// existing hermetic registry consumer. It imports installed bytes by package
// name; repository source and distribution paths are not consumer fallbacks.
const installedProbe = `
import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as api from "@agent-teams/release-checks";
import * as conformance from "@agent-teams/release-checks/conformance";
import type { CheckReport, ReleaseCandidateInput } from "@agent-teams/release-checks";
import type { ConformanceCase } from "@agent-teams/release-checks/conformance";
const check: (input: ReleaseCandidateInput) => CheckReport = api.checkReleaseCandidate;
void check;
assert.deepEqual(Object.keys(api), ["checkReleaseCandidate"]);
assert.deepEqual(Object.keys(conformance), ["releaseCandidateConformanceCases"]);
const manifest = JSON.parse(await readFile(fileURLToPath(import.meta.resolve("@agent-teams/release-checks/package.json")), "utf8"));
assert.equal(manifest.name, "@agent-teams/release-checks");
assert.equal(manifest.version, process.argv[2]);
for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
  assert.deepEqual(Object.keys(manifest[section] ?? {}), []);
}
assert.deepEqual(manifest.devDependencies, { typescript: "7.0.2" });
const installedRoot = await realpath(join(process.cwd(), "node_modules/@agent-teams/release-checks"));
for (const suffix of ["", "/conformance"]) {
  const entry = await realpath(fileURLToPath(import.meta.resolve("@agent-teams/release-checks" + suffix)));
  assert.ok(entry.startsWith(installedRoot + sep));
}
const cases: readonly ConformanceCase[] = conformance.releaseCandidateConformanceCases;
assert.ok(cases.length > 0);
assert.ok(cases.some(item => item.expected.outcome === "passed"));
assert.ok(cases.some(item => item.expected.outcome === "rejected"));
for (const item of cases) {
  const report = api.checkReleaseCandidate(item.input);
  assert.equal(report.outcome, item.expected.outcome, item.id);
  assert.deepEqual(report.diagnostics.map(diagnostic => diagnostic.code), item.expected.diagnosticCodes, item.id);
  assert.deepEqual(report.packageChanges, item.expected.packageChanges, item.id);
}
const forbidden = "@agent-teams/release-checks/dist/index.js";
await assert.rejects(import(forbidden), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
console.log(JSON.stringify({ status: "passed", cases: cases.length }));
`;

export async function verifyInstalledReleaseChecks(input: Readonly<{
  consumerRoot: string;
  packageVersion: string;
  repositoryRoot: string;
}>): Promise<InstalledQualification> {
  const probe = join(input.consumerRoot, "release-checks-installed.ts");
  await writeFile(probe, installedProbe);
  await writeFile(join(input.consumerRoot, "tsconfig.release-checks.json"), JSON.stringify({
    compilerOptions: { target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext",
      strict: true, skipLibCheck: false, noEmit: true, types: ["node"],
      typeRoots: [join(input.repositoryRoot, "node_modules/@types")] },
    files: ["release-checks-installed.ts"],
  }));
  const compilerRoot = join(input.repositoryRoot, "node_modules/typescript");
  const compiler = JSON.parse(await readFile(join(compilerRoot, "package.json"), "utf8")) as { version: string };
  assert.equal(compiler.version, "7.0.2");
  await runCommand(process.execPath, [join(compilerRoot, "bin/tsc"), "--project", "tsconfig.release-checks.json"], input.consumerRoot);
  const result = await runCommand(process.execPath, [probe, input.packageVersion], input.consumerRoot);
  const report: unknown = JSON.parse(result.stdout);
  assert.ok(report !== null && typeof report === "object");
  assert.equal((report as { status?: unknown }).status, "passed");
  const cases = (report as { cases?: unknown }).cases;
  assert.ok(typeof cases === "number" && Number.isSafeInteger(cases) && cases > 0);
  return { status: "passed", cases };
}

export async function verifyPackedReleaseChecks(input: Readonly<{
  artifact: PackedArtifact | undefined;
  temporaryRoot: string;
  repositoryRoot: string;
  packageManager: string;
  runPnpm: RunPnpm;
}>): Promise<void> {
  const artifact = input.artifact;
  assert.ok(artifact !== undefined && artifact.packageName === packageName);
  const consumerRoot = join(input.temporaryRoot, "release-checks-packed-consumer");
  await mkdir(consumerRoot, { recursive: true });
  await writeFile(join(consumerRoot, "package.json"), `${JSON.stringify({
    name: "release-checks-packed-TEST", private: true, type: "module", packageManager: input.packageManager,
    devDependencies: { [packageName]: artifact.archiveFileSpecifier ?? pathToFileURL(artifact.archivePath).href },
  }, null, 2)}\n`);
  await writeFile(join(consumerRoot, "pnpm-workspace.yaml"), "packages: []\n");
  await input.runPnpm(["install", "--offline", "--ignore-scripts", "--strict-peer-dependencies"], consumerRoot);
  const lock: unknown = parseYaml(await readFile(join(consumerRoot, "pnpm-lock.yaml"), "utf8"));
  assert.ok(lock !== null && typeof lock === "object");
  const packages = (lock as { packages?: unknown }).packages;
  assert.ok(packages !== null && typeof packages === "object");
  const packageKeys = Object.keys(packages);
  assert.equal(packageKeys.length, 1, "The installed runtime closure must contain only release-checks.");
  assert.ok(packageKeys[0]?.startsWith(`${packageName}@`));
  const report = await verifyInstalledReleaseChecks({ consumerRoot, packageVersion: artifact.packageVersion,
    repositoryRoot: input.repositoryRoot });
  process.stdout.write(`Packed release-checks public API and conformance passed: ${JSON.stringify(report)}.\n`);
}
