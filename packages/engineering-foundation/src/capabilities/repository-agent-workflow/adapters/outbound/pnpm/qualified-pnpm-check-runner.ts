import { isCheckCancelled } from "../../../application/policies/check-cancellation.js";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath, mkdtemp, rm, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve, relative as relativePath, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { CoverageCheck, CoverageExecution, CoverageFacet, ObservationBinding, TestDispatchObservation } from "../../../application/model/check-changed.js";
import type { CheckInputLease, CoverageCheckRunner } from "../../../application/ports/check-changed.js";
import { CoverageExecutionFailure } from "../../../application/ports/check-changed.js";
import type { ExecuteWorkflowProcess } from "../../../application/ports/process-execution.js";
import { parseTestDispatchObservation } from "../../../application/policies/test-dispatch-observation.js";
import { assertConfigRepositoryRelativePath } from "../../../application/configuration-input.js";

export interface PnpmToolIdentity {
  readonly packageRoot: string;
  readonly version: string;
  readonly entrypointSha256: string;
  readonly packageJsonSha256: string;
  readonly packageTreeSha256: string;
  readonly nodeExecutable: string;
  readonly nodeSha256: string;
}
/** Consumer/Host qualifies the transitive commands and prerequisite effects.
 * This record is trusted composition input, never executable workspace config.
 * Files include all relevant enclosing configs/locks, wrappers, and scripts;
 * the Host frozen closure additionally includes dependencies/fixtures/generated
 * inputs. Digests verify identity; they do not qualify command semantics. */
export interface QualifiedScriptClosure {
  readonly checkId: string;
  readonly scripts: Readonly<Record<string, string>>;
  readonly files: Readonly<Record<string, string>>;
  readonly supplies: readonly CoverageFacet[];
  readonly runnerIdentity: string | null;
  readonly effects: "read-only-inputs-owned-outputs";
  readonly effectiveConfig: { readonly enablePrePostScripts: false; readonly verifyDepsBeforeRun: false; readonly managePackageManagerVersions: false };
}
export interface PnpmCheckQualification {
  readonly tool: PnpmToolIdentity;
  readonly outputRoot: string;
  readonly qualify: (lease: CheckInputLease, check: CoverageCheck) => Promise<QualifiedScriptClosure>;
}
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
export async function fingerprintPnpmPackage(root: string): Promise<string> {
  const hash = createHash("sha256");
  let entries = 0, bytes = 0;
  async function walk(path: string, relative: string, depth: number): Promise<void> {
    if (++entries > 10_000 || depth > 32) {throw new Error("Pinned package exceeds inventory bound.");}
    const metadata = await lstat(path);
    if (metadata.isDirectory()) {
      for (const name of (await readdir(path)).toSorted()) {await walk(join(path, name), `${relative}/${name}`, depth + 1);}
    } else {
      const data = await regular(path);
      bytes += data.length;
      if (bytes > 96 * 1024 * 1024) {throw new Error("Pinned package exceeds byte bound.");}
      hash.update(JSON.stringify([relative, metadata.mode, digest(data)]));
    }
  }
  await walk(root, "", 0);
  return hash.digest("hex");
}
async function regular(path: string, maximum = 16 * 1024 * 1024): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > maximum) {throw new Error("Pinned input is not a bounded regular file.");}
  return readFile(path);
}
async function contained(root: string, path: string): Promise<Buffer> {
  assertConfigRepositoryRelativePath(path);
  let current = root;
  const parts = path.split("/");
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (!(await lstat(current)).isDirectory()) {throw new Error("Input ancestor is not a regular directory.");}
  }
  return regular(join(root, path));
}
function safeOutput(stdout: string, stderr: string): string {
  // Never echo raw tool output: scripts can print credentials. Preserve only a
  // bounded diagnostic summary; callers retain protected raw TEST logs.
  return `stdout chars=${stdout.length}; stderr chars=${stderr.length}`;
}
function disabledConfig(value: unknown): boolean {
  return value !== null && typeof value === "object" && Object.keys(value).length === 3 && ["enablePrePostScripts", "verifyDepsBeforeRun", "managePackageManagerVersions"].every((key) => Object.hasOwn(value, key) && (value as Record<string, unknown>)[key] === false);
}
function readOnlyEffects(value: unknown): boolean { return value === "read-only-inputs-owned-outputs"; }
async function verifyPinnedTool(tool: PnpmToolIdentity, lease: CheckInputLease, outputRoot: string): Promise<string> {
    if (!isAbsolute(tool.packageRoot) || !isAbsolute(tool.nodeExecutable) || !isAbsolute(outputRoot)) {throw new Error("Pinned executable and output paths must be absolute.");}
    if (await realpath(tool.packageRoot) !== tool.packageRoot || await realpath(tool.nodeExecutable) !== tool.nodeExecutable || await realpath(lease.executionRoot) !== lease.executionRoot) {throw new Error("Pinned roots cannot be aliases.");}
    const entrypoint = resolve(tool.packageRoot, "bin/pnpm.mjs");
    const packageBytes = await regular(join(tool.packageRoot, "package.json"));
    const manifest = JSON.parse(packageBytes.toString("utf8")) as { name?: unknown; version?: unknown; bin?: { pnpm?: unknown } };
    if (manifest.name !== "pnpm" || manifest.version !== tool.version || manifest.bin?.pnpm !== "bin/pnpm.mjs" || digest(packageBytes) !== tool.packageJsonSha256 || digest(await contained(tool.packageRoot, "bin/pnpm.mjs")) !== tool.entrypointSha256 || digest(await regular(tool.nodeExecutable, 256 * 1024 * 1024)) !== tool.nodeSha256) {throw new Error("Pinned pnpm executable/package identity mismatch.");}
    if (await fingerprintPnpmPackage(tool.packageRoot) !== tool.packageTreeSha256) {throw new Error("Transitive pnpm package substitution.");}
    return entrypoint;
}
async function verifyScriptClosure(lease: CheckInputLease, check: CoverageCheck, closure: QualifiedScriptClosure, version: string): Promise<void> {
    if (closure.checkId !== check.id || !readOnlyEffects(closure.effects) || !disabledConfig(closure.effectiveConfig) || closure.supplies.some((facet) => !check.supplies.includes(facet))) {throw new Error("Script closure qualification mismatch.");}
    const packageInput = JSON.parse((await contained(lease.executionRoot, "package.json")).toString("utf8")) as { packageManager?: unknown; scripts?: Record<string, unknown> };
    if (packageInput.packageManager !== `pnpm@${version}`) {throw new Error("Consumer pnpm version mismatch.");}
    const names = Object.keys(closure.scripts);
    if (names.length === 0 || names.length > 128 || Object.keys(closure.files).length === 0 || Object.keys(closure.files).length > 256 || !Object.hasOwn(closure.files, "package.json") || [check.script, ...check.prerequisites].some((name) => !names.includes(name))) {throw new Error("Missing explicit/transitive script closure.");}
    for (const name of names) {
      if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/u.test(name) || packageInput.scripts?.[name] !== closure.scripts[name]) {throw new Error("Script closure substitution.");}
    }
    for (const [path, expected] of Object.entries(closure.files)) {if (!/^[a-f0-9]{64}$/u.test(expected) || digest(await contained(lease.executionRoot, path)) !== expected) { throw new Error("Script/config closure substitution."); }}
}
async function readObservation(path: string, check: CoverageCheck, closure: QualifiedScriptClosure, binding: ObservationBinding): Promise<TestDispatchObservation | null> {
  const runnerIdentity = closure.runnerIdentity;
  if (check.observation !== "test-dispatch/v1" || runnerIdentity === null) { return null; }
  try {
    const bytes = await regular(path, 256 * 1024);
    return parseTestDispatchObservation(JSON.parse(bytes.toString("utf8")), binding, runnerIdentity);
  } catch { return null; }
}
function observedFacets(exitCode: number, cancelled: boolean, closure: QualifiedScriptClosure, observation: TestDispatchObservation | null): readonly CoverageFacet[] {
  if (exitCode !== 0 || cancelled) { return []; }
  return closure.supplies.filter((facet) => facet !== "tests" || observation?.outcome === "passed");
}
function outputIsContained(source: string, output: string): boolean {
  const path = relativePath(source, output);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}
export function createQualifiedPnpmCheckRunner(qualification: PnpmCheckQualification, execute: ExecuteWorkflowProcess): CoverageCheckRunner {
  const configArgs = ["--config.enablePrePostScripts=false", "--config.verifyDepsBeforeRun=false", "--config.managePackageManagerVersions=false"];
  async function verify(lease: CheckInputLease, check: CoverageCheck, closure: QualifiedScriptClosure, signal?: AbortSignal): Promise<string> {
    const tool = qualification.tool;
    const entrypoint = await verifyPinnedTool(tool, lease, qualification.outputRoot);
    await verifyScriptClosure(lease, check, closure, tool.version);
    const options = { cwd: lease.executionRoot, ...(signal === undefined ? {} : { signal }) };
    const version = await execute(tool.nodeExecutable, [entrypoint, "--version"], options);
    if (version.exitCode !== 0 || version.stdout.trim() !== tool.version) {throw new Error("Actual pnpm version mismatch.");}
    for (const key of ["enablePrePostScripts", "verifyDepsBeforeRun", "managePackageManagerVersions"]) {
      const config = await execute(tool.nodeExecutable, [entrypoint, ...configArgs, "config", "get", key], options);
      if (config.exitCode !== 0 || config.stdout.trim() !== "false") {throw new Error("Effective lifecycle/install config mismatch.");}
    }
    await lease.assertCurrent(signal);
    return entrypoint;
  }
  return {
    async run({ lease, check, signal }): Promise<CoverageExecution> {
      const closure = await qualification.qualify(lease, check);
      const entrypoint = await verify(lease, check, closure, signal);
      const binding = { invocationId: randomUUID(), sourceIdentity: lease.sourceIdentity, configIdentity: lease.configIdentity, checkId: check.id };
      // Output transport is external to the admitted source/input closure.
      const outputRoot = await realpath(qualification.outputRoot);
      if (outputIsContained(lease.executionRoot, outputRoot)) {throw new Error("Observation output must be outside the source closure.");}
      const transport = await mkdtemp(join(outputRoot, "check-observation-"));
      const observationPath = join(transport, "observation.json");
      const start = performance.now();
      let stdout = "", stderr = "", exitCode = 0;
      const commands: { script: string; exitCode: number | null; durationMs: number }[] = [];
      let admissionRevoked = true;
      let failedAdmission = false;
      let completed: CoverageExecution | undefined;
      let failure: unknown;
      let failed = false;
      const executionFailure = (revoked: boolean) => new CoverageExecutionFailure({ binding, commands, exitCode: exitCode || 1, durationMs: performance.now() - start, cancelled: isCheckCancelled(signal), output: safeOutput(stdout, stderr), observation: null, qualifiedFacets: [] }, revoked);
      try {
        for (const script of [...check.prerequisites, check.script]) {
          if (isCheckCancelled(signal)) {break;}
          await verify(lease, check, closure, signal);
          const args = [entrypoint, ...configArgs, "run", script];
          // Dedicated explicit argv transport to a qualified wrapper, never
          // human stdout parsing, env mutation, or shell interpolation.
          if (script === check.script && check.observation === "test-dispatch/v1") {args.push("--", "--foundation-observation", observationPath, "--foundation-binding", JSON.stringify(binding));}
          const commandStart = performance.now();
          admissionRevoked = false;
          const result = await execute(qualification.tool.nodeExecutable, args, { cwd: lease.executionRoot, ...(signal === undefined ? {} : { signal }) }).catch((error: unknown) => {
            commands.push({ script, exitCode: null, durationMs: performance.now() - commandStart });
            throw error;
          });
          commands.push({ script, exitCode: result.exitCode, durationMs: performance.now() - commandStart });
          stdout = result.stdout; stderr = result.stderr; exitCode = result.exitCode;
          admissionRevoked = true;
          if (exitCode !== 0 || isCheckCancelled(signal)) {break;}
        }
        await verify(lease, check, closure, signal);
        const observation = await readObservation(observationPath, check, closure, binding);
        const qualifiedFacets = observedFacets(exitCode, isCheckCancelled(signal), closure, observation);
        completed = { binding, commands, exitCode, durationMs: performance.now() - start, cancelled: isCheckCancelled(signal), output: safeOutput(stdout, stderr), observation, qualifiedFacets };
      } catch (error) {
        failure = error; failed = true;
        failedAdmission = admissionRevoked;
      }
      // Settle cleanup before returning, preserving an earlier failure instead
      // of allowing finally to overwrite its revocation or execution trace.
      try { await rm(transport, { recursive: true, force: true }); }
      catch (error) { if (!failed) { failure = error; failed = true; } }
      if (failed || completed === undefined) {
        if (commands.length === 0) {throw failure;}
        throw executionFailure(failedAdmission);
      }
      return completed;
    }
  };
}
