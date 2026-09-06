import { readFile } from "node:fs/promises";

import {
  digestBytes,
  assertQualifiedDocsCohortBindingV1,
  type ConsumerAssetCatalogV1,
  type CurrentSourceExecutorV1,
  type KnownPriorCohortCatalogEntryV1,
  type ConsumerAssetCatalogReader
} from "../application-api.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const COHORT_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const BUNDLE_PATH = /^assets\/history\/sha256-[0-9a-f]{64}\/(?:caller\.yml|skill\.md)$/u;
const MAXIMUM_CATALOG_BYTES = 2 * 1024 * 1024;
const MAXIMUM_BUNDLE_BYTES = 1024 * 1024;

function record(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${subject} must be one plain object.`);
  }
  return value as Record<string, unknown>;
}

function digest(value: unknown, subject: string): `sha256:${string}` {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new TypeError(`${subject} must be one sha256 digest.`);
  }
  return value as `sha256:${string}`;
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).toSorted().join("\u0000") === [...keys].toSorted().join("\u0000");
}

function packagePair(value: unknown): CurrentSourceExecutorV1["packages"] {
  const packages = record(value, "currentSourceExecutor.packages");
  const docsProtocol = record(packages["docsProtocol"], "currentSourceExecutor.packages.docsProtocol");
  const engineeringFoundation = record(
    packages["engineeringFoundation"],
    "currentSourceExecutor.packages.engineeringFoundation"
  );
  if (!hasExactKeys(packages, ["docsProtocol", "engineeringFoundation"]) ||
    !hasExactKeys(docsProtocol, ["version", "integrity"]) ||
    !hasExactKeys(engineeringFoundation, ["version", "integrity"]) ||
    !SEMVER.test(String(docsProtocol["version"])) ||
    !SEMVER.test(String(engineeringFoundation["version"])) ||
    !INTEGRITY.test(String(docsProtocol["integrity"])) ||
    !INTEGRITY.test(String(engineeringFoundation["integrity"]))) {
    throw new TypeError("Current source executor package pair is invalid.");
  }
  return packages as unknown as CurrentSourceExecutorV1["packages"];
}

function schemas(value: unknown): CurrentSourceExecutorV1["schemas"] {
  const candidate = record(value, "currentSourceExecutor.schemas");
  if (!hasExactKeys(candidate, ["consumerIntegration", "managedState", "docsProtocol"]) ||
    Object.values(candidate).some((entry) => entry !== 1)) {
    throw new TypeError("Current source executor schemas are invalid.");
  }
  return candidate as unknown as CurrentSourceExecutorV1["schemas"];
}

function runtime(value: unknown): CurrentSourceExecutorV1["runtime"] {
  const candidate = record(value, "currentSourceExecutor.runtime");
  if (!hasExactKeys(candidate, ["node", "pnpm", "runtimeClosureDigest"]) ||
    candidate["node"] !== ">=24.18.0 <25" || candidate["pnpm"] !== ">=11.17.0 <12") {
    throw new TypeError("Current source executor runtime is invalid.");
  }
  digest(candidate["runtimeClosureDigest"], "currentSourceExecutor.runtime.runtimeClosureDigest");
  return candidate as unknown as CurrentSourceExecutorV1["runtime"];
}

function cohortIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32 ||
    !value.every((entry: unknown): entry is string => typeof entry === "string" && COHORT_ID.test(entry)) ||
    new Set(value).size !== value.length) {
    throw new TypeError("Current source executor target Cohort IDs are invalid.");
  }
  return value;
}

async function bundleBytes(path: unknown, expected: unknown): Promise<Uint8Array> {
  if (typeof path !== "string" || !BUNDLE_PATH.test(path)) {
    throw new TypeError("Direct-target bundle paths must be content-addressed package assets.");
  }
  const bytes = await readFile(new URL(`../../../${path}`, import.meta.url));
  if (bytes.byteLength > MAXIMUM_BUNDLE_BYTES || digestBytes(bytes) !== digest(expected, path)) {
    throw new TypeError(`Direct-target bundle digest mismatch: ${path}.`);
  }
  return bytes;
}

function currentSource(value: unknown): CurrentSourceExecutorV1 {
  const source = record(value, "currentSourceExecutor");
  if (!hasExactKeys(source, [
    "packages", "schemas", "runtime", "assetCatalogDigest", "skillDigest", "callerWorkflowDigest",
    "agentsRouteDigest", "docsScriptsDigest", "directTargetCohortIds"
  ])) {
    throw new TypeError("Current source executor fields are invalid.");
  }
  return Object.freeze({
    packages: packagePair(source["packages"]),
    schemas: schemas(source["schemas"]),
    runtime: runtime(source["runtime"]),
    assetCatalogDigest: digest(source["assetCatalogDigest"], "currentSourceExecutor.assetCatalogDigest"),
    skillDigest: digest(source["skillDigest"], "currentSourceExecutor.skillDigest"),
    callerWorkflowDigest: digest(source["callerWorkflowDigest"], "currentSourceExecutor.callerWorkflowDigest"),
    agentsRouteDigest: digest(source["agentsRouteDigest"], "currentSourceExecutor.agentsRouteDigest"),
    docsScriptsDigest: digest(source["docsScriptsDigest"], "currentSourceExecutor.docsScriptsDigest"),
    directTargetCohortIds: cohortIds(source["directTargetCohortIds"])
  });
}

async function directTarget(value: unknown): Promise<KnownPriorCohortCatalogEntryV1> {
  const target = record(value, "directTargetBundle");
  const cohort = record(target["cohort"], "directTargetBundle.cohort");
  assertQualifiedDocsCohortBindingV1(cohort);
  const [skill, callerWorkflow] = await Promise.all([
    bundleBytes(target["skillPath"], target["skillDigest"]),
    bundleBytes(target["callerWorkflowPath"], target["callerWorkflowDigest"])
  ]);
  return Object.freeze({
    cohort,
    skill,
    callerWorkflow,
    agentsRouteDigest: digest(target["agentsRouteDigest"], "directTargetBundle.agentsRouteDigest"),
    docsScriptsDigest: digest(target["docsScriptsDigest"], "directTargetBundle.docsScriptsDigest")
  });
}

export async function loadPackageConsumerAssetCatalog(): Promise<ConsumerAssetCatalogV1> {
  const [bytes, transitionBytes, docsManifestBytes] = await Promise.all([
    readFile(new URL("../../../assets/catalog.json", import.meta.url)),
    readFile(new URL("../../../assets/transition-catalog.json", import.meta.url)),
    readFile(new URL("../../../package.json", import.meta.url))
  ]);
  if (bytes.byteLength > MAXIMUM_CATALOG_BYTES) {throw new TypeError("Consumer asset catalog is too large.");}
  if (transitionBytes.byteLength > MAXIMUM_CATALOG_BYTES) {
    throw new TypeError("Consumer transition catalog is too large.");
  }
  const source = record(
    JSON.parse(transitionBytes.toString("utf8")) as unknown,
    "consumer transition catalog"
  );
  if (!hasExactKeys(source, ["schemaVersion", "currentSourceExecutors", "directTargetBundles"]) ||
    source["schemaVersion"] !== 1) {
    throw new TypeError("Consumer transition catalog fields are invalid.");
  }
  const sources = source["currentSourceExecutors"];
  const targets = source["directTargetBundles"];
  if (!Array.isArray(sources) || sources.length > 32 || !Array.isArray(targets) || targets.length > 32) {
    throw new TypeError("Consumer asset catalog executor and target lists must be bounded arrays.");
  }
  const docsVersion = record(JSON.parse(docsManifestBytes.toString("utf8")), "Docs package")["version"];
  const currentSourceExecutors = sources.map(currentSource).filter(({ packages }) =>
    packages.docsProtocol.version === docsVersion
  );
  const directTargetBundles = await Promise.all(targets.map(directTarget));
  const directTargetIds = new Set(directTargetBundles.map(({ cohort }) => cohort.cohortId));
  if (directTargetIds.size !== directTargetBundles.length || currentSourceExecutors.some(
    ({ directTargetCohortIds }) => directTargetCohortIds.some((id) => !directTargetIds.has(id))
  )) {
    throw new TypeError("Consumer transition catalog target Cohort identities must be unique.");
  }
  return Object.freeze({
    catalogDigest: digestBytes(bytes),
    transitionCatalogDigest: digestBytes(transitionBytes),
    currentSourceExecutors: Object.freeze(currentSourceExecutors),
    directTargetBundles: Object.freeze(directTargetBundles)
  });
}

export const packageConsumerAssetCatalogReader: ConsumerAssetCatalogReader =
  Object.freeze({ read: loadPackageConsumerAssetCatalog });
