import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inspectCompressedTarArchive, portableEntryIdentity, readRegularArchive, sha256 } from "./pack-artifact-archive.mjs";
import { AjvJsonSchemaReleaseInspector } from "../packages/engineering-foundation/dist/capabilities/contract-json-schema-releases/module.js";
import {
  createPackageArtifactInventory, mapReleasedArtifactBaseline, observedPackageExports,
} from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/module.js";

import { loadCapabilityConfig } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/inbound/configuration/load-capability-config.js";
import { readArtifactBaseline as readBaseline, writeArtifactBaseline as writeBaseline } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/public-api-artifact-baseline.js";
import { loadStrictYamlFile } from "../packages/engineering-foundation/dist/features/configuration-input/node.js";
import { parseStrictYamlSource } from "../packages/engineering-foundation/dist/features/configuration-input/yaml.js";
import { readContainedRegularFile, pathTraversesSymbolicLink } from "../packages/engineering-foundation/dist/source-inventory/node.js";
import { assertSchema } from "../packages/engineering-foundation/dist/schema-catalog.js";
const evidence = { files: { read: readContainedRegularFile }, paths: { traversesSymbolicLink: pathTraversesSymbolicLink }, parseYaml: parseStrictYamlSource };
const readArtifactBaseline = (root, policy) => readBaseline(root, policy, evidence);
const writeArtifactBaseline = (input) => writeBaseline(input, evidence);
const loadPublicApiCompatibilityPolicy = (root, path) => loadCapabilityConfig({ readYaml: loadStrictYamlFile, assertSchema }, root, path);
const digest = (bytes) => `sha256:${sha256(bytes)}`;

function verifyPublishedReceipt(input, bytes) {
  const receipt = input.verifiedProvenance;
  if (receipt?.artifact?.name !== input.packageName || receipt.artifact.version !== input.packageVersion ||
      receipt.artifact.integrity !== input.integrity || receipt.provenance?.commit !== input.sourceCommit ||
      receipt.provenance.sha512 !== createHash("sha512").update(bytes).digest("hex")) {
    throw new Error(`Initial supported fixation requires trusted verified provenance for ${input.packageName}.`);
  }
}

function inspectArchive(input, bytes) {
  if (sha256(bytes) !== input.sha256 ||
      `sha512-${createHash("sha512").update(bytes).digest("base64")}` !== input.integrity) {
    throw new Error(`Initial artifact integrity mismatch: ${input.packageName}.`);
  }
  if (input.status === "supported" && input.packageVersion !== "0.0.0") {
    verifyPublishedReceipt(input, bytes);
  } else if (input.status !== "initial-unreleased" || input.packageVersion !== "0.0.0") {
    throw new Error("Initial fixation requires a verified supported release or a packed initial-unreleased candidate; historical bootstrap is not supported.");
  }
  const files = new Map();
  const identities = new Set();
  for (const entry of inspectCompressedTarArchive(bytes).entries) {
    if (!entry.name.startsWith("package/") || !["0", "5"].includes(entry.type)) {
      throw new Error(`Initial artifact contains a non-package or special member: ${entry.name}.`);
    }
    const identity = portableEntryIdentity(entry.name);
    if (identities.has(identity)) { throw new Error(`Initial artifact contains a duplicate path: ${entry.name}.`); }
    identities.add(identity);
    if (entry.type === "0") { files.set(entry.name.slice(8), Buffer.from(entry.data)); }
  }
  const manifestBytes = files.get("package.json");
  if (manifestBytes === undefined) { throw new Error("Initial artifact has no regular package manifest."); }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.name !== input.packageName || manifest.version !== input.packageVersion) {
    throw new Error(`Initial artifact package identity mismatch: ${input.packageName}.`);
  }
  return { files, manifest, manifestBytes };
}

function archivePolicy(input, manifest, index) {
  const packageRoot = `archives/package-${index}`;
  const observed = observedPackageExports({ manifest, policy: { packageName: input.packageName, packageRoot } });
  return {
    packageName: input.packageName, packageRoot, manifestPath: `${packageRoot}/package.json`,
    releasedBaselinePath: `architecture/public-api/${input.packageName.split("/").at(-1)}.json`,
    tsconfigPath: `${packageRoot}/tsconfig.json`, approvedBreakingChanges: [],
    entrypoints: observed.filter((entry) => entry.kind === "typed").map(({ exportPath, declarationEntryPoint }) => ({ exportPath, declarationEntryPoint })),
    nonTypeExports: observed.filter((entry) => entry.kind !== "typed").map(({ exportPath, kind }) => ({ exportPath, kind })),
  };
}

function assertCandidateSnapshot(input, sourceCandidates, snapshot) {
  if (input.status !== "initial-unreleased") { return; }
  const source = sourceCandidates.find((entry) => entry.packageName === input.packageName);
  if (source?.packageVersion !== snapshot.packageVersion ||
      JSON.stringify(source.wildcardExports) !== JSON.stringify(snapshot.wildcardExports) ||
      JSON.stringify(source.jsonSchemas) !== JSON.stringify(snapshot.jsonSchemas)) {
    throw new Error(`Initial candidate archive differs from current package artifacts: ${input.packageName}.`);
  }
}

async function publishInitialProposals(consumerRoot, proposals, create) {
    // Compare every destination before the first create; replay only exact proposals.
    const pending = [];
    for (const proposal of proposals) {
      const existing = await readArtifactBaseline(consumerRoot, proposal.policy);
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(proposal.snapshot)) {
        throw new Error(`Initial artifact baseline already exists with different evidence: ${proposal.policy.packageName}.`);
      }
      if (existing === undefined) { pending.push(proposal); }
    }
    if (create) {
      for (const { policy, snapshot } of pending) {
        await writeArtifactBaseline({ root: consumerRoot, policy, snapshot, mode: "create" });
      }
    }
}

/**
 * Offline release preparation. The caller supplies receipts from its trusted npm
 * signature/provenance verifier; this function verifies their binding, not signatures.
 * All schemas are inspected together in their historical package boundaries.
 */
export async function prepareInitialArtifactBaselines({ consumerRoot, archives, temporaryRoot, create = false }) {
  if (!Array.isArray(archives) || archives.length === 0 || archives.length > 100 ||
      new Set(archives.map((entry) => entry.packageName.split("/").at(-1))).size !== archives.length) {
    throw new Error("Initial artifacts require a bounded set of unique package anchors.");
  }
  const declared = await loadPublicApiCompatibilityPolicy(consumerRoot, "architecture/foundation/public-api-compatibility.yaml");
  if (archives.some((entry) => !declared.packages.some((policy) => policy.packageName === entry.packageName))) {
    throw new Error("Initial artifact must belong to a declared public API package.");
  }
  const candidatePolicies = declared.packages.filter((policy) => archives.some((entry) =>
    entry.status === "initial-unreleased" && entry.packageName === policy.packageName));
  const sourceCandidates = candidatePolicies.length === 0 ? [] :
    await createPackageArtifactInventory(new AjvJsonSchemaReleaseInspector(evidence.files)).inspect(consumerRoot, candidatePolicies);
  const stage = await mkdtemp(join(temporaryRoot, "initial-artifact-fixation-"));
  try {
    const inputs = [];
    let archiveBytes = 0;
    let payloadBytes = 0;
    for (const [index, input] of archives.entries()) {
      const bytes = await readRegularArchive(input.archivePath);
      archiveBytes += bytes.length;
      if (archiveBytes > 32 * 1024 * 1024) { throw new Error("Initial artifact packet exceeds 32 MiB compressed bytes."); }
      const archive = inspectArchive(input, bytes);
      for (const member of archive.files.values()) { payloadBytes += member.length; }
      if (payloadBytes > 64 * 1024 * 1024) { throw new Error("Initial artifact packet exceeds 64 MiB member bytes."); }
      const policy = archivePolicy(input, archive.manifest, index);
      // Materialize only the manifest and wildcard payload; never execute package code.
      const patterns = observedPackageExports({ manifest: archive.manifest, policy })
        .filter((entry) => entry.kind === "wildcard").map((entry) => entry.targetPattern);
      for (const [path, memberBytes] of archive.files) {
        if (path !== "package.json" && !patterns.some((pattern) => {
          const [prefix, suffix] = pattern.split("*");
          return path.startsWith(prefix) && path.endsWith(suffix) && path.length > prefix.length + suffix.length;
        })) { continue; }
        const destination = join(stage, policy.packageRoot, path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, memberBytes, { flag: "wx" });
      }
      inputs.push({ input, archive, policy });
    }
    const inventory = createPackageArtifactInventory(new AjvJsonSchemaReleaseInspector(evidence.files));
    const current = await inventory.inspect(stage, inputs.map(({ policy }) => policy));
    const proposals = current.flatMap((snapshot, index) => {
      if (snapshot.wildcardExports.length === 0) { return []; }
      const { input, archive, policy } = inputs[index];
      assertCandidateSnapshot(input, sourceCandidates, snapshot);
      const members = [...new Set(snapshot.wildcardExports.flatMap((entry) => entry.members))].toSorted();
      const proposed = mapReleasedArtifactBaseline({ ...snapshot, status: input.status, archive: {
        sha256: `sha256:${input.sha256}`, integrity: input.integrity, sourceCommit: input.sourceCommit,
        manifestDigest: digest(archive.manifestBytes),
        memberDigests: members.map((path) => ({ path, digest: digest(archive.files.get(path)) })),
      } }, policy);
      return [{ policy, snapshot: proposed }];
    });
    await publishInitialProposals(consumerRoot, proposals, create);
    return proposals.map(({ snapshot }) => snapshot);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [requestPath, mode] = process.argv.slice(2);
  if (requestPath === undefined || ![undefined, "--create"].includes(mode) || process.argv.length > 4) {
    throw new Error("Usage: node scripts/prepare-public-api-artifact-baselines.mjs <request.json> [--create]");
  }
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  const proposals = await prepareInitialArtifactBaselines({ ...request, create: mode === "--create" });
  process.stdout.write(`${JSON.stringify(proposals, null, 2)}\n`);
}
