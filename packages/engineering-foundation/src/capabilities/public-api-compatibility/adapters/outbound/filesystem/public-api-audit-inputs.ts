import type { PublicApiAuditRequest } from "../../../api.js";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import type { AuditDeclarationInput, AuditPackageInput } from "../../../contract/public-api-audit.js";
import type { AuditFileIdentity } from "../../../application/model/public-api-observation.js";
import type { AuditInputBudget, PublicApiAuditInputs } from "../../../application/ports/public-api-observer.js";
import type { PublicApiPackagePolicy } from "../../../application/model/public-api.js";
import { assertPackageExportCoverage } from "../../../application/policies/validate-package-export-coverage.js";
import { mapReleasedBaseline } from "./public-api-baseline-mapper.js";

export const AUDIT_MAX_FILES = 4096;
export const AUDIT_MAX_BYTES = 32 * 1024 * 1024;
export function auditDigest(bytes: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
/** Native containment also handles the forward slashes emitted by the SDK on Windows. */
export function auditRelativePath(root: string, path: string, paths = { isAbsolute, relative, sep }): string | undefined {
  if (!paths.isAbsolute(path)) { return; }
  const local = paths.relative(root, path);
  if (paths.isAbsolute(local) || local === ".." || local.startsWith(`..${paths.sep}`)) { return; }
  return local;
}
/** Remap only stage-owned paths; external compiler libraries keep their own identity. */
export function remapAuditStagePath(path: string, stageRoot: string, inputRoot: string,
  paths = { isAbsolute, relative, resolve, sep }): string {
  const local = auditRelativePath(stageRoot, path, paths);
  return local === undefined ? path : paths.resolve(inputRoot, local);
}
/** Reject lexical escapes and symlinks, including symlinked parent directories. */
export async function auditInputPath(root: string, path: string): Promise<string> {
  if (!path || isAbsolute(path) || win32.isAbsolute(path) || path.includes(":") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {throw new Error(`Invalid audit path: ${path}.`);}
  const canonicalRoot = await realpath(root);
  const target = resolve(canonicalRoot, path);
  let cursor = canonicalRoot;
  for (const part of path.split("/")) {
    cursor = resolve(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) {throw new Error(`Audit symlink unsupported: ${path}.`);}
  }
  const canonical = await realpath(target);
  const local = relative(canonicalRoot, canonical);
  if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`) || local === "") {throw new Error(`Audit path escapes root: ${path}.`);}
  if (!(await lstat(canonical)).isFile()) {throw new Error(`Audit input is not a regular file: ${path}.`);}
  return canonical;
}
export async function auditRead(root: string, path: string, budget?: AuditInputBudget): Promise<Buffer> {
  if (budget !== undefined && ++budget.files > AUDIT_MAX_FILES) {throw new Error("Audit input file budget exhausted.");}
  const target = await auditInputPath(root, path);
  const size = (await lstat(target)).size;
  if (budget !== undefined) {
    budget.bytes += size;
    if (budget.bytes > AUDIT_MAX_BYTES) {throw new Error("Audit input byte budget exhausted.");}
  }
  if (size > AUDIT_MAX_BYTES) {throw new Error("Audit input byte budget exhausted.");}
  const bytes = await readFile(target);
  if (budget !== undefined) {
    budget.bytes += bytes.length - size;
    if (budget.bytes > AUDIT_MAX_BYTES) {throw new Error("Audit input byte budget exhausted.");}
  }
  if (bytes.length > AUDIT_MAX_BYTES) {throw new Error("Audit input byte budget exhausted.");}
  return bytes;
}
export function auditPackagePolicy(input: AuditPackageInput): PublicApiPackagePolicy {
  return { ...input, packageRoot: dirname(input.manifestPath), releasedBaselinePath: "", approvedBreakingChanges: [] };
}
export class FilesystemPublicApiAuditInputs implements PublicApiAuditInputs {
  readonly assertRequest: (input: unknown) => Promise<void>;
  readonly assertBaseline: (input: unknown) => Promise<void>;
  constructor(assertRequest: (input: unknown) => Promise<void>, assertBaseline: (input: unknown) => Promise<void>) {
    this.assertRequest = assertRequest;
    this.assertBaseline = assertBaseline;
  }
  async load(consumerRoot: string, configPath: string) {
    const bytes = await auditRead(consumerRoot, configPath);
    const input: unknown = JSON.parse(bytes.toString("utf8"));
    await this.assertRequest(input);
    const request = input as PublicApiAuditRequest;
    await this.revalidate(consumerRoot, request);
    return { request, digest: auditDigest(bytes) };
  }
  async baseline(root: string, input: PublicApiAuditRequest["subjects"]["B"]["baselines"][number], budget: AuditInputBudget) {
    const bytes = await auditRead(root, input.path, budget);
    if (auditDigest(bytes) !== input.digest) {throw new Error(`Baseline digest mismatch: ${input.path}.`);}
    const baseline: unknown = JSON.parse(bytes.toString("utf8"));
    await this.assertBaseline(baseline);
    return mapReleasedBaseline(baseline, input);
  }
  async revalidate(root: string, request: PublicApiAuditRequest): Promise<void> {
    const budget = { bytes: 0, files: 0 };
    for (const subject of [request.subjects.A, request.subjects.C]) {await validateSubject(root, subject, budget);}
    const aPaths = new Set(request.subjects.A.files.map((file) => file.path));
    if (request.subjects.C.files.some((file) => aPaths.has(file.path))) {throw new Error("A and C input universes must be disjoint.");}
    await validateCustody(root, request.subjects.A.archive.extractedMembers, request.subjects.A.files, budget);
    await validateCustody(root, request.subjects.C.build.declarations, request.subjects.C.files, budget);
    // Historical bytes are validated by baseline(), inside the per-package boundary.
    // Keep structural duplicate rejection here without coupling B failures to A/C.
    const names = new Set<string>();
    for (const baseline of request.subjects.B.baselines) {
      if (names.has(baseline.packageName)) {throw new Error("Duplicate historical package.");}
      names.add(baseline.packageName);
    }
  }
}
interface InputBudget { bytes: number; files: number }
async function verifyFile(root: string, file: AuditFileIdentity, budget: InputBudget): Promise<void> {
  if (++budget.files > AUDIT_MAX_FILES) {throw new Error("Audit input file budget exhausted.");}
  const bytes = await auditRead(root, file.path);
  budget.bytes += bytes.length;
  if (budget.bytes > AUDIT_MAX_BYTES) {throw new Error("Audit input byte budget exhausted.");}
  if (auditDigest(bytes) !== file.digest) {throw new Error(`Audit digest mismatch: ${file.path}.`);}
}
async function verifyInventory(root: string, files: readonly AuditFileIdentity[], budget: InputBudget): Promise<ReadonlySet<string>> {
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path)) {throw new Error(`Duplicate audit input: ${file.path}.`);}
    paths.add(file.path);
    await verifyFile(root, file, budget);
  }
  return paths;
}
async function validatePackage(root: string, pkg: AuditPackageInput, paths: ReadonlySet<string>): Promise<void> {
  for (const path of [pkg.manifestPath, pkg.tsconfigPath, ...pkg.entrypoints.map((entry) => entry.declarationEntryPoint)]) {
    if (!paths.has(path)) {throw new Error(`Missing declared input digest: ${path}.`);}
  }
  const manifest = JSON.parse((await auditRead(root, pkg.manifestPath)).toString("utf8")) as { name?: unknown; version?: unknown };
  if (manifest.name !== pkg.packageName || manifest.version !== pkg.packageVersion) {throw new Error("Audit package identity mismatch.");}
  assertPackageExportCoverage({ manifest, policy: auditPackagePolicy(pkg) });
}
async function validateSubject(root: string, subject: AuditDeclarationInput, budget: InputBudget): Promise<void> {
  const paths = await verifyInventory(root, subject.files, budget);
  const names = new Set<string>();
  for (const pkg of subject.packages) {
    if (names.has(pkg.packageName)) {throw new Error("Duplicate audit package.");}
    names.add(pkg.packageName);
    await validatePackage(root, pkg, paths);
  }
  const expected = subject.packages.flatMap((pkg) => pkg.entrypoints.map((entry) => JSON.stringify([pkg.packageName, entry.exportPath, entry.declarationEntryPoint]))).toSorted();
  const actual = subject.resolutionUniverse.map((entry) => JSON.stringify([entry.packageName, entry.exportPath, entry.declarationPath])).toSorted();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {throw new Error("Resolution universe must exactly cover this subject's typed exports.");}
}
async function validateCustody(root: string, asserted: readonly AuditFileIdentity[], verified: readonly AuditFileIdentity[], budget: InputBudget): Promise<void> {
  if (asserted.length === 0) {throw new Error("Missing custody inventory.");}
  await verifyInventory(root, asserted, budget);
  for (const file of verified.filter((candidate) => /\.d\.(?:ts|mts|cts)$/u.test(candidate.path))) {
    if (!asserted.some((candidate) => candidate.path === file.path && candidate.digest === file.digest)) {throw new Error("Declaration missing from custody inventory.");}
  }
}
