import { realpath } from "node:fs/promises";
import { publicApiInputError } from "../../../application/policies/public-api-evidence-errors.js";
import type { PublicApiRepositoryEvidence } from "../../../application/ports/public-api-evidence.js";
import { parseStrictJson } from "@agent-teams/repository-mutation/serialization";
import { isExactVersion } from "../../../../../semantic-version.js";
import { publicApiArtifactBaselineAnchorPath, publicApiBaselineAnchorPath,
  type PublicApiArtifactSnapshot, type PublicApiPackagePolicy, type PublicApiJsonSchemaSnapshot
} from "../../../application/model/public-api.js";
import { artifactPathIdentity, wildcardExpression } from "../../../application/policies/compare-package-artifact-inventory.js";
import { readPublicApiEvidenceFile, writePublicApiEvidenceFile } from "./public-api-evidence-files.js";

function invalid(message: string): never {
  publicApiInputError("PUBLIC_API_ARTIFACT_BASELINE_INVALID", message, "public-api-evidence");
}

function record(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key) && !optional.includes(key)) || keys.some((key) => !(key in value))) {
    invalid(`Artifact baseline must contain exactly: ${keys.join(", ")}.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) { invalid("Artifact baseline string is invalid."); }
  return value;
}

function path(value: unknown): string {
  const output = string(value);
  artifactPathIdentity(output);
  return output;
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length > 20_000) { invalid("Artifact baseline collection must be an array."); }
  return value;
}

function assertSorted(values: readonly string[]): void {
  if (values.some((value, index) => index > 0 && (values[index - 1] ?? "") >= value)) {
    invalid("Artifact baseline collections must be unique and sorted.");
  }
}

function schema(value: unknown): PublicApiJsonSchemaSnapshot {
  const item = record(value, ["path", "id", "digest", "discriminators"]);
  const digest = string(item["digest"]);
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) { invalid("Invalid schema digest."); }
  const id = string(item["id"]);
  try { if (new URL(id).hash !== "") { invalid("Schema $id cannot contain a fragment."); } }
  catch { invalid("Schema $id must be an absolute URI."); }
  const fields = item["discriminators"];
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) { invalid("Invalid schema discriminators."); }
  for (const entry of Object.values(fields)) {
    const definition: unknown = entry;
    if (typeof definition !== "object" || definition === null || Array.isArray(definition) ||
        Object.keys(definition).length !== 1 || !("const" in definition || ("enum" in definition && Array.isArray(definition["enum"])))) {
      invalid("Invalid schema discriminator observation.");
    }
  }
  return { path: path(item["path"]), id, digest: digest as `sha256:${string}`, discriminators: fields as Record<string, unknown> };
}

export function mapReleasedArtifactBaseline(input: unknown, policy: PublicApiPackagePolicy): PublicApiArtifactSnapshot {
  if (Buffer.byteLength(`${JSON.stringify(input, null, 2)}\n`, "utf8") > 4 * 1024 * 1024) {
    invalid("Artifact baseline exceeds the 4 MiB readable record limit.");
  }
  const value = record(input, ["schemaVersion", "packageName", "packageVersion", "status", "wildcardExports", "jsonSchemas"], ["archive"]);
  const packageVersion = string(value["packageVersion"]);
  if (value["schemaVersion"] !== 1 || value["packageName"] !== policy.packageName || !isExactVersion(packageVersion)) {
    invalid("Artifact baseline identity does not match the package.");
  }
  const status = value["status"];
  if (status !== "supported" && status !== "historical-bootstrap" && status !== "release-candidate" && status !== "initial-unreleased") { invalid("Invalid artifact status."); }
  if ((packageVersion === "0.0.0") !== (status === "historical-bootstrap" || status === "initial-unreleased")) { invalid("Bootstrap 0.0.0 must be explicitly historical or initially unreleased, never supported."); }
  const wildcardExports = array(value["wildcardExports"]).map((entry) => {
    const wildcard = record(entry, ["exportPath", "targetPattern", "members"]);
    const exportPath = string(wildcard["exportPath"]);
    if (!exportPath.startsWith("./")) { invalid("Wildcard export must begin with ./."); }
    wildcardExpression(exportPath.slice(2));
    const targetPattern = string(wildcard["targetPattern"]);
    const expression = wildcardExpression(targetPattern);
    const members = array(wildcard["members"]).map(path);
    assertSorted(members);
    if (new Set(members.map(artifactPathIdentity)).size !== members.length) { invalid("Portable artifact member collision."); }
    if (members.some((member) => !expression.test(member))) { invalid("Artifact member does not match its wildcard target."); }
    return { exportPath, targetPattern, members };
  });
  assertSorted(wildcardExports.map((entry) => entry.exportPath));
  const jsonSchemas = array(value["jsonSchemas"]).map(schema);
  assertSorted(jsonSchemas.map((entry) => entry.path));
  const members = new Set(wildcardExports.flatMap((entry) => entry.members));
  if (jsonSchemas.some((entry) => !members.has(entry.path)) || new Set(jsonSchemas.map((entry) => entry.id)).size !== jsonSchemas.length ||
      [...members].some((member) => member.endsWith(".schema.json") && !jsonSchemas.some((entry) => entry.path === member))) {
    invalid("Schema inventory must cover exported schema members with unique $ids.");
  }
  const archive = value["archive"] === undefined ? undefined : archiveEvidence(value["archive"], [...members].toSorted(), jsonSchemas);
  return { schemaVersion: 1, packageName: policy.packageName, packageVersion, status, wildcardExports, jsonSchemas,
    ...(archive === undefined ? {} : { archive }) };

}

function archiveEvidence(input: unknown, members: readonly string[], schemas: readonly PublicApiJsonSchemaSnapshot[]): NonNullable<PublicApiArtifactSnapshot["archive"]> {
  const value = record(input, ["sha256", "integrity", "manifestDigest", "sourceCommit", "memberDigests"]);
  const sha256 = string(value["sha256"]);
  const manifestDigest = string(value["manifestDigest"]);
  const integrity = string(value["integrity"]);
  const sourceCommit = string(value["sourceCommit"]);
  if (!/^sha256:[a-f0-9]{64}$/u.test(sha256) || !/^sha256:[a-f0-9]{64}$/u.test(manifestDigest) ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(integrity) || !/^[a-f0-9]{40}$/u.test(sourceCommit)) {
    invalid("Invalid archive integrity or source identity.");
  }
  const memberDigests = array(value["memberDigests"]).map((entry) => {
    const member = record(entry, ["path", "digest"]);
    const digest = string(member["digest"]);
    if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) { invalid("Invalid archive member digest."); }
    return { path: path(member["path"]), digest: digest as `sha256:${string}` };
  });
  if (JSON.stringify(memberDigests.map((entry) => entry.path)) !== JSON.stringify(members) ||
      schemas.some((definition) => memberDigests.find((entry) => entry.path === definition.path)?.digest !== definition.digest)) {
    invalid("Archive digests must exactly bind the wildcard and schema inventory.");
  }
  return { sha256: sha256 as `sha256:${string}`, manifestDigest: manifestDigest as `sha256:${string}`, integrity, sourceCommit, memberDigests };
}

function anchor(policy: PublicApiPackagePolicy): string {
  if (policy.releasedBaselinePath !== publicApiBaselineAnchorPath(policy.packageName)) {
    invalid("Artifact baseline requires the stable package baseline anchor.");
  }
  return publicApiArtifactBaselineAnchorPath(policy.packageName);
}

export async function readArtifactBaselineBytes(root: string, policy: PublicApiPackagePolicy, evidence: PublicApiRepositoryEvidence): Promise<Buffer | undefined> {
  const bytes = await readPublicApiEvidenceFile({ root: await realpath(root), repositoryPath: anchor(policy),
    phase: "public-api-evidence", maxBytes: 4 * 1024 * 1024, allowMissing: true }, evidence.files);
  return bytes;
}

export async function readArtifactBaseline(root: string, policy: PublicApiPackagePolicy, evidence: PublicApiRepositoryEvidence): Promise<PublicApiArtifactSnapshot | undefined> {
  const bytes = await readArtifactBaselineBytes(root, policy, evidence);
  return bytes === undefined ? undefined : mapReleasedArtifactBaseline(parseStrictJson(bytes.toString("utf8")), policy);
}

export async function writeArtifactBaseline(input: {
  readonly root: string; readonly policy: PublicApiPackagePolicy; readonly snapshot: PublicApiArtifactSnapshot;
  readonly mode: "create" | "replace"; readonly signal?: AbortSignal; readonly expectedBytes?: Buffer;
}, evidence: PublicApiRepositoryEvidence): Promise<void> {
  const baselinePath = anchor(input.policy);
  const snapshot = mapReleasedArtifactBaseline(input.snapshot, input.policy);
  await writePublicApiEvidenceFile(input.root, baselinePath, snapshot, { mode: input.expectedBytes === undefined ? input.mode : { expectedBytes: input.expectedBytes }, ...(input.signal === undefined ? {} : { signal: input.signal }) }, evidence);
}
