import { createHash } from "node:crypto";
import { lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { assertNotCancelled, publicApiInputError } from "../../../application/policies/public-api-evidence-errors.js";
import type { PublicApiSourceEvidence } from "../../../application/ports/public-api-evidence.js";
import { parseStrictJson } from "@agent-teams/repository-mutation/serialization";
import { isExactVersion } from "../../../../../semantic-version.js";
import type { PublicApiArtifactSnapshot, PublicApiPackagePolicy, PublicApiJsonSchemaSnapshot, PublicApiWildcardExportSnapshot } from "../../../application/model/public-api.js";
import type { JsonSchemaSetInspector, PackageArtifactInventory } from "../../../application/ports/package-artifact-inventory.js";
import { artifactPathIdentity, wildcardExpression } from "../../../application/policies/compare-package-artifact-inventory.js";
import { assertPackageExportCoverage, PackageExportCoverageError, observedPackageExports } from "../../../application/policies/validate-package-export-coverage.js";

const MAX_ENTRIES = 20_000;
const MAX_BYTES = 32 * 1024 * 1024;

function fail(message: string): never {
  publicApiInputError("PUBLIC_API_ARTIFACT_INVENTORY_INVALID", message, "public-api-artifact-inspection");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("Artifact JSON must contain an object.");
  }
  return value as Record<string, unknown>;
}

function discriminators(schema: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const properties = schema["properties"];
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    return {};
  }
  return Object.fromEntries(Object.entries(properties).toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .flatMap<[string, unknown]>(([key, value]) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) { return []; }
      const property = record(value);
      return "const" in property ? [[key, { const: property["const"] }]] :
        "enum" in property ? [[key, { enum: property["enum"] }]] : [];
    }));
}

function rememberIdentity(identities: Set<string>, member: string): void {
  const identity = artifactPathIdentity(member);
  if (identities.has(identity)) { fail(`Portable path collision in wildcard inventory: ${member}.`); }
  identities.add(identity);
}

function isSchemaDefinition(path: string, parsed: unknown): boolean {
  return path.endsWith(".schema.json") ||
    (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) &&
     "$schema" in parsed && typeof parsed.$schema === "string" && /^https?:\/\/json-schema\.org\//u.test(parsed.$schema));
}

async function wildcardFiles(root: string, pattern: string, evidence: PublicApiSourceEvidence, signal?: AbortSignal): Promise<readonly string[]> {
  const expression = wildcardExpression(pattern);
  const prefix = pattern.slice(0, pattern.indexOf("*"));
  const start = prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : "";
  // A root wildcard would traverse dependencies and unbounded unrelated source.
  if (start === "") { fail(`Wildcard inventory requires an explicit directory prefix: ${pattern}.`); }
  const output: string[] = [];
  const identities = new Set<string>();
  let entries = 0;
  const pending = [start];
  while (pending.length > 0) {
    assertNotCancelled(signal);
    const path = pending.pop();
    if (path === undefined) { break; }
    const absolute = resolve(root, path);
    if (await evidence.paths.traversesSymbolicLink(root, absolute)) { fail(`Symbolic link in wildcard inventory: ${path}.`); }
    const before = await lstat(absolute).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") { return null; }
      throw error;
    });
    if (before === null) { continue; }
    if (!before.isDirectory()) { fail(`Wildcard prefix is not a directory: ${path}.`); }
    const handle = await opendir(absolute);
    for await (const entry of handle) {
      assertNotCancelled(signal);
      if (++entries > MAX_ENTRIES) { fail(`Wildcard inventory exceeds ${MAX_ENTRIES} entries.`); }
      const member = `${path}/${entry.name}`;
      rememberIdentity(identities, member);
      if (!entry.isFile() && !entry.isDirectory()) { fail(`Special file in wildcard inventory: ${member}.`); }
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") { fail(`Dependency directory in wildcard inventory: ${member}.`); }
        pending.push(member);
      } else if (expression.test(member)) { output.push(member); }
    }
    const after = await lstat(absolute);
    if (await evidence.paths.traversesSymbolicLink(root, absolute) || before.dev !== after.dev || before.ino !== after.ino ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) { fail(`Wildcard directory changed: ${path}.`); }
  }
  return output.toSorted();
}

async function artifactManifest(root: string, policy: PublicApiPackagePolicy, evidence: PublicApiSourceEvidence) {
      const bytes = await readBytes(evidence, {
        candidate: resolve(root, policy.manifestPath), root, maxBytes: 1024 * 1024
      });
      const manifest = record(parseStrictJson(bytes.toString("utf8")));
      const version = manifest["version"];
      if (manifest["name"] !== policy.packageName || typeof version !== "string" || !isExactVersion(version)) { fail(`Invalid artifact identity: ${policy.packageName}.`); }
      try { assertPackageExportCoverage({ manifest, policy }); }
      catch (error) {
        if (error instanceof PackageExportCoverageError) {
          publicApiInputError("PUBLIC_API_PACKAGE_EXPORTS_INVALID", error.message, "public-api-evidence");
        }
        throw error;
      }
      return { manifest, version, bytes };
}

async function artifactPackageRoot(root: string, policy: Pick<PublicApiPackagePolicy, "packageRoot">, evidence: PublicApiSourceEvidence): Promise<string> {
  const packageRoot = resolve(root, policy.packageRoot);
  const relation = relative(root, packageRoot);
  if (isAbsolute(relation) || relation === ".." || relation.startsWith(`..${sep}`) ||
      await evidence.paths.traversesSymbolicLink(root, packageRoot)) { fail(`Unsafe package root: ${policy.packageRoot}.`); }
  return packageRoot;
}

/** Observe exports independently of package.json files/pack allowlists. */
export async function observePackageWildcardExports(
  root: string, manifest: unknown,
  policy: Pick<PublicApiPackagePolicy, "packageRoot" | "packageName">,
  evidence: PublicApiSourceEvidence, signal?: AbortSignal
): Promise<readonly PublicApiWildcardExportSnapshot[]> {
      if (record(manifest)["exports"] === undefined) { return []; }
      const wildcardExports = [];
      for (const entry of observedPackageExports({ manifest, policy })) {
        if (entry.kind !== "wildcard" || entry.targetPattern === undefined) { continue; }
        // readContainedRegularFile below checks ancestry as well as the final leaf.
        const packageRoot = await artifactPackageRoot(root, policy, evidence);
        const members = await wildcardFiles(packageRoot, entry.targetPattern, evidence, signal);
        wildcardExports.push({ exportPath: entry.exportPath, targetPattern: entry.targetPattern, members });
      }
      return wildcardExports;
}

export class FilesystemPackageArtifactInventory implements PackageArtifactInventory {
  constructor(private readonly jsonSchemas: JsonSchemaSetInspector, private readonly evidence: PublicApiSourceEvidence) {}

  async inspect(consumerRoot: string, policies: readonly PublicApiPackagePolicy[], signal?: AbortSignal): Promise<readonly PublicApiArtifactSnapshot[]> {
    const evidence = this.evidence;
    const root = await realpath(consumerRoot);
    const snapshots: PublicApiArtifactSnapshot[] = [];
    const schemaPaths: string[] = [];
    const observedBytes = new Map<string, Buffer>();
    const manifests = new Map<string, Buffer>();
    let bytesRead = 0;
    for (const policy of policies) {
      assertNotCancelled(signal);
      const { manifest, version, bytes: manifestBytes } = await artifactManifest(root, policy, evidence);
      manifests.set(policy.manifestPath, manifestBytes);
      const wildcardExports = await observePackageWildcardExports(root, manifest, policy, evidence, signal);
      const jsonSchemas: PublicApiJsonSchemaSnapshot[] = [];
      for (const path of [...new Set(wildcardExports.flatMap((entry) => entry.members))].toSorted()) {
        const repositoryPath = `${policy.packageRoot}/${path}`;
        const bytes = await readBytes(evidence, { candidate: resolve(root, repositoryPath), root, maxBytes: MAX_BYTES });
        bytesRead += bytes.byteLength;
        if (bytesRead > MAX_BYTES) { fail(`Artifact inventory exceeds ${MAX_BYTES} bytes.`); }
        observedBytes.set(repositoryPath, bytes);
        if (!path.endsWith(".json")) { continue; }
        const parsed = parseStrictJson(bytes.toString("utf8"));
        if (!isSchemaDefinition(path, parsed)) { continue; }
        const value = record(parsed);
        const id = value["$id"];
        if (typeof id !== "string") { fail(`Schema has no $id: ${repositoryPath}.`); }
        schemaPaths.push(repositoryPath);
        jsonSchemas.push({ path, id, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, discriminators: discriminators(value) });
      }
      snapshots.push({ schemaVersion: 1, packageName: policy.packageName, packageVersion: version,
        status: version === "0.0.0" ? "initial-unreleased" : "release-candidate", wildcardExports, jsonSchemas });
    }
    if (schemaPaths.length > 0) {
      await this.jsonSchemas.inspect({ consumerRoot: root, schemaPaths, fixtures: [], requireMixedExpectations: false,
        ...(signal === undefined ? {} : { signal }) });
    }
    for (const policy of policies) {
      assertNotCancelled(signal);
      const { manifest, bytes } = await artifactManifest(root, policy, evidence);
      const exports = await observePackageWildcardExports(root, manifest, policy, evidence, signal);
      if (manifests.get(policy.manifestPath)?.equals(bytes) !== true ||
          JSON.stringify(exports) !== JSON.stringify(snapshots.find((entry) => entry.packageName === policy.packageName)?.wildcardExports)) {
        fail(`Manifest or wildcard membership changed during inspection: ${policy.packageName}.`);
      }
    }
    for (const [path, bytes] of observedBytes) {
        assertNotCancelled(signal);
        const after = await readBytes(evidence, { candidate: resolve(root, path), root, maxBytes: MAX_BYTES });
        if (!bytes.equals(after)) { fail(`Artifact changed during inspection: ${path}.`); }
    }
    return snapshots;
  }
}

async function readBytes(evidence: PublicApiSourceEvidence, input: Parameters<PublicApiSourceEvidence["files"]["read"]>[0]): Promise<Buffer> {
  return Buffer.from(await evidence.files.read(input));
}
