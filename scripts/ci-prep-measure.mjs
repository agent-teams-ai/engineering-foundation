// Disposable EF-M measurement only. This is not a release or consumer qualifier.
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir, totalmem, version } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { readVerifiedArchive, sha256 } from "./pack-artifact-archive.mjs";
import { PUBLISHABLE_PACKAGES } from "./publishable-packages.mjs";
import { createPnpmRunner, measurePrepPhase, runCommand, runNpmCommand, withPrepMeasurement } from "./pack-test-support.mjs";

const baseSHA = "20007b1c96a236c101d9993c8f11bd3d95fe4550";
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const [output, variant] = process.argv.slice(2);
if (process.argv.length !== 4 || !output || !["baseline", "temp-runner"].includes(variant)) {
  throw new Error("Usage: node scripts/ci-prep-measure.mjs <evidence-directory> baseline|temp-runner");
}
const evidenceRoot = resolve(output);
await mkdir(evidenceRoot, { recursive: true });
const eventsPath = join(evidenceRoot, "phases.jsonl");
await writeFile(eventsPath, "", { flag: "wx" });
const phases = [];
const observe = event => {
  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
  if (event.event === "end") {
    const { stdout: _stdout, stderr: _stderr, ...timing } = event;
    phases.push(timing);
    console.log(JSON.stringify(timing));
  }
};
const source = {
  baseSHA, variant, startedAt: new Date().toISOString(),
  os: { platform: platform(), release: release(), version: version(), arch: arch(),
    cpu: cpus()[0]?.model, cpuCount: cpus().length, totalMemoryBytes: totalmem() },
  node: process.version, nodeVersions: process.versions,
  paths: { repositoryRoot, evidenceRoot, effectiveTmpdir: tmpdir(),
    TEMP: process.env.TEMP, TMP: process.env.TMP, RUNNER_TEMP: process.env.RUNNER_TEMP },
  run: { id: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
    sha: process.env.GITHUB_SHA, ref: process.env.GITHUB_REF, runnerImage: process.env.ImageVersion },
};
const archives = [];
let temporaryRoot;
let problem;
const started = performance.now();
try {
  await withPrepMeasurement(observe, async () => {
    await measurePrepPhase("source-toolchain", {}, async () => {
      const git = async args => (await runCommand("git", args, repositoryRoot)).stdout.trim();
      source.sourceCommit = await git(["rev-parse", "HEAD"]);
      if (!/^[a-f0-9]{40}$/u.test(source.sourceCommit) ||
          (process.env.GITHUB_SHA && source.sourceCommit !== process.env.GITHUB_SHA)) {
        throw new Error("Source commit is not the exact dispatched checkout.");
      }
      source.firstParent = await git(["rev-parse", "HEAD^"]);
      if (source.sourceCommit !== baseSHA && source.firstParent !== baseSHA) {
        throw new Error("Measurement must use the exact base or one owner commit directly on that base.");
      }
      const diff = (await runCommand("git", ["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD"], repositoryRoot)).stdout;
      source.trackedDiffSha256 = sha256(diff);
      source.trackedDirty = diff.length > 0;
      source.untrackedPaths = (await git(["ls-files", "--others", "--exclude-standard"])).split("\n").filter(Boolean);
      if (process.env.GITHUB_ACTIONS === "true" && (source.trackedDirty || source.untrackedPaths.length > 0)) {
        throw new Error("Hosted measurement requires a committed, clean source checkout.");
      }
      const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
      source.packageManager = manifest.packageManager;
      source.pnpm = (await createPnpmRunner()(["--version"], repositoryRoot)).stdout.trim();
      source.npm = (await runNpmCommand(["--version"], repositoryRoot)).stdout.trim();
      source.typescript = JSON.parse(await readFile(join(repositoryRoot, "node_modules/typescript/package.json"), "utf8")).version;
      source.exactNode = (await readFile(join(repositoryRoot, ".node-version"), "utf8")).trim();
      if (process.version !== `v${source.exactNode}` || `pnpm@${source.pnpm}` !== source.packageManager) {
        throw new Error("Measurement requires the exact repository Node and packageManager.");
      }
    });
    temporaryRoot = await mkdtemp(join(tmpdir(), "EF-M-TEST-clean-preparation-"));
    source.paths.temporaryRoot = temporaryRoot;
    await writeFile(join(evidenceRoot, "source.json"), `${JSON.stringify(source, null, 2)}\n`, { flag: "wx" });
    const records = await measurePrepPhase("preparation", {}, async () => {
      const { packPublishableArtifacts } = await import("./pack-publishable-artifacts.mjs");
      return packPublishableArtifacts({ temporaryRoot });
    });
    await measurePrepPhase("final-archive-hashes", {}, async () => {
      if (PUBLISHABLE_PACKAGES.length !== 6 || Object.keys(records).length !== 6) {
        throw new Error("The complete six-archive preparation is required.");
      }
      for (const { name } of PUBLISHABLE_PACKAGES) {
        const record = records[name];
        const bytes = await readVerifiedArchive(record.archivePath, record.sha256);
        archives.push({ packageName: name, packageVersion: record.packageVersion,
          archiveName: record.archiveName, sha256: sha256(bytes), bytes: bytes.length,
          buildSupportPackageNames: record.buildSupportPackageNames });
      }
    });
    const builds = phases.filter(event => event.phase === "command" && event.command === "pnpm" &&
      event.args.join(" ") === "run build" && event.outcome === "passed");
    const expected = archives.reduce((count, archive) => count + 2 * archive.buildSupportPackageNames.length, 0);
    if (builds.length !== expected || phases.filter(event => event.phase === "pack" && event.outcome === "passed").length !== 12) {
      throw new Error("Instrumentation did not observe both independent clean builds and packs for every artifact.");
    }
  });
} catch (error) {
  problem = { message: error.message, code: error.code, stack: error.stack };
} finally {
  try {
    if (temporaryRoot) {
      await withPrepMeasurement(observe, () => measurePrepPhase("cleanup", {}, () =>
        rm(temporaryRoot, { recursive: true, force: true })));
    }
  } catch (error) { problem = { message: error.message, priorProblem: problem }; }
  const builds = phases.filter(event => event.phase === "command" && event.command === "pnpm" && event.args.join(" ") === "run build");
  const report = { source, qualificationPassed: problem === undefined && archives.length === 6, problem,
    totalDurationMs: performance.now() - started, buildCommandCount: builds.length,
    durationSemantics: "Inclusive phase durations; parentId identifies nesting. Do not sum parent and child timings.",
    perPackage: PUBLISHABLE_PACKAGES.map(({ name }) => ({ packageName: name,
      buildCommandCount: builds.filter(event => event.packageName === name).length,
      phases: phases.filter(event => event.packageName === name) })),
    phases, archives, windowsHashComparison: "Owner must compare all qualified Windows hash sets outside the workers; a redundant TEMP variant is explicitly skipped in runner.json." };
  await writeFile(join(evidenceRoot, "measurement.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  await writeFile(join(evidenceRoot, "archive-hashes.json"), `${JSON.stringify(archives, null, 2)}\n`, { flag: "wx" });
  if (!report.qualificationPassed) { process.exitCode = 1; }
  console.log(JSON.stringify({ qualificationPassed: report.qualificationPassed, evidenceRoot, buildCommandCount: builds.length }));
}
