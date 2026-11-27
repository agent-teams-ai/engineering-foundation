import { createHash } from "node:crypto";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  array,
  command,
  digest,
  evidence,
  fetchBytes,
  jsonEvidence,
  object,
  outputRoot,
  parse,
  requireEqual,
  string,
  utf8,
  type JsonRecord,
} from "./io.ts";

export interface Coordinate {
  readonly name: string;
  readonly role: "direct" | "transitive";
  readonly version: string;
}
export interface ObservedPackage extends Coordinate {
  readonly integrity: string;
  readonly registry: "https://registry.npmjs.org/";
  readonly published_at: string;
  readonly provenance: JsonRecord;
}
export interface PackageCapture {
  readonly coordinate: Coordinate;
  readonly metadata: JsonRecord;
  readonly integrity: string;
  readonly publishedAt: string;
  readonly manifest: JsonRecord;
  readonly archive: string;
  readonly attestationBytes: Buffer;
}
export async function invoke(
  module: JsonRecord,
  name: string,
  arguments_: readonly unknown[],
): Promise<unknown> {
  const operation = module[name];
  if (typeof operation !== "function") {
    throw new Error(`Trusted source export ${name} is unavailable.`);
  }
  const result: unknown = Reflect.apply(operation, undefined, arguments_);
  return await result;
}
function registryUrl(value: unknown, label: string): string {
  const url = string(value, label);
  if (new URL(url).origin !== "https://registry.npmjs.org") {
    throw new Error(`${label} must use the public npm registry.`);
  }
  return url;
}
export function packageMember(capture: PackageCapture, path: string): Buffer {
  if (!/^(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+$/u.test(path) || path.split("/").includes("..")) {
    throw new Error("Selected package member is not a bounded relative path.");
  }
  return command(
    "read-package-member",
    "/usr/bin/tar",
    ["-xOzf", capture.archive, `package/${path}`],
    outputRoot,
  ).stdout;
}
export async function capturePackage(
  coordinate: Coordinate,
  index: number,
  temporaryRoot: string,
): Promise<PackageCapture> {
  const encoded = encodeURIComponent(coordinate.name);
  const metadataBytes = await fetchBytes(
    `https://registry.npmjs.org/${encoded}/${coordinate.version}`,
  );
  const metadata = parse(utf8(metadataBytes), "registry metadata");
  requireEqual(metadata["name"], coordinate.name, "registry package name");
  requireEqual(metadata["version"], coordinate.version, "registry package version");
  const dist = object(metadata["dist"], "registry distribution");
  const integrity = string(dist["integrity"], "registry integrity");
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/u.test(integrity)) {
    throw new Error("Registry integrity must be a single exact SHA-512 SRI.");
  }
  const timesBytes = await fetchBytes(`https://registry.npmjs.org/${encoded}`, 24 * 1024 * 1024);
  const times = object(
    parse(utf8(timesBytes), "registry package history")["time"],
    "publication times",
  );
  const publishedAt = string(times[coordinate.version], "publication time");
  if (!Number.isFinite(Date.parse(publishedAt)) || Date.parse(publishedAt) > Date.now()) {
    throw new Error("Publication time is invalid or future dated.");
  }
  const tarball = registryUrl(dist["tarball"], "package tarball");
  const archiveBytes = await fetchBytes(tarball, 32 * 1024 * 1024);
  requireEqual(
    `sha512-${createHash("sha512").update(archiveBytes).digest("base64")}`,
    integrity,
    "downloaded archive integrity",
  );
  const archive = join(temporaryRoot, `${index}.tgz`);
  writeFileSync(archive, archiveBytes, { flag: "wx", mode: 0o600 });
  const attestationUrl = registryUrl(
    object(dist["attestations"], "attestations")["url"],
    "attestation URL",
  );
  const attestationBytes = await fetchBytes(attestationUrl);
  evidence(`packages/${index}-metadata.json`, metadataBytes);
  evidence(`packages/${index}-times.json`, timesBytes);
  evidence(`packages/${index}-attestations.json`, attestationBytes);
  jsonEvidence(`packages/${index}-archive.json`, {
    name: coordinate.name,
    version: coordinate.version,
    tarball,
    integrity,
    bytes: archiveBytes.byteLength,
    sha256: digest(archiveBytes),
  });
  const list = utf8(
    command("list-package-members", "/usr/bin/tar", ["-tzf", archive], temporaryRoot).stdout,
  )
    .trimEnd()
    .split("\n");
  if (
    list.length === 0 ||
    list.length > 25_000 ||
    new Set(list).size !== list.length ||
    list.some(
      (path) =>
        !path.startsWith("package/") || path.includes("\0") || path.split("/").includes(".."),
    )
  ) {
    throw new Error("Package archive member inventory is not bounded and unique.");
  }
  if (list.filter((path) => path === "package/package.json").length !== 1) {
    throw new Error("Package manifest member is not unique.");
  }
  const partial = {
    coordinate,
    metadata,
    integrity,
    publishedAt,
    archive,
    attestationBytes,
    manifest: {},
  };
  const manifestBytes = packageMember(partial, "package.json");
  const manifest = parse(utf8(manifestBytes), "packed package manifest");
  requireEqual(manifest["name"], coordinate.name, "packed package name");
  requireEqual(manifest["version"], coordinate.version, "packed package version");
  evidence(`packages/${index}-manifest.json`, manifestBytes);
  jsonEvidence(`packages/${index}-members.json`, list);
  return { ...partial, manifest };
}
export async function github(path: string): Promise<JsonRecord> {
  if (!path.startsWith("repos/agent-teams-ai/")) {
    throw new Error("GitHub observation is outside the selected organization repositories.");
  }
  return parse(utf8(await fetchBytes(`https://api.github.com/${path}`)), "GitHub observation");
}
const githubCache = new Map<string, Promise<JsonRecord>>();
function stableGithub(path: string): Promise<JsonRecord> {
  const prior = githubCache.get(path);
  if (prior) {
    return prior;
  }
  const pending = github(path);
  githubCache.set(path, pending);
  return pending;
}
export async function bindVerifiedProvenance(
  capture: PackageCapture,
  verified: readonly unknown[],
  index: number,
): Promise<ObservedPackage> {
  const { coordinate, metadata, integrity, publishedAt } = capture;
  const matching = verified
    .map((value) => object(value, "verified signature"))
    .filter(
      (entry) => entry["name"] === coordinate.name && entry["version"] === coordinate.version,
    );
  if (matching.length !== 1) {
    throw new Error("Exact package has no unique cryptographically verified entry.");
  }
  const entry = matching[0]!;
  requireEqual(entry["registry"], "https://registry.npmjs.org/", "signature registry");
  const registryAttestations = parse(utf8(capture.attestationBytes), "registry attestations");
  const bundles = array(entry["attestationBundles"], "verified attestation bundles");
  if (!isDeepStrictEqual(bundles, registryAttestations["attestations"])) {
    throw new Error("Verified and observed attestation bundles differ.");
  }
  const dist = object(metadata["dist"], "package dist");
  const registryAttestationUrl = registryUrl(
    object(dist["attestations"], "dist attestations")["url"],
    "attestation URL",
  );
  requireEqual(
    object(entry["attestations"], "verified attestation location")["url"],
    registryAttestationUrl,
    "verified attestation location",
  );
  const statements = bundles
    .map((value) => object(value, "attestation bundle"))
    .filter((value) => value["predicateType"] === "https://slsa.dev/provenance/v1");
  if (statements.length !== 1) {
    throw new Error("Verified package needs exactly one SLSA provenance statement.");
  }
  const envelope = object(
    object(statements[0]!["bundle"], "signed bundle")["dsseEnvelope"],
    "DSSE envelope",
  );
  const payload = string(envelope["payload"], "DSSE payload");
  const payloadBytes = Buffer.from(payload, "base64");
  requireEqual(payloadBytes.toString("base64"), payload, "DSSE base64 encoding");
  evidence(`packages/${index}-verified-provenance.json`, payloadBytes);
  const statement = parse(utf8(payloadBytes), "provenance statement");
  const subject = array(statement["subject"], "provenance subjects")
    .map((value) => object(value, "subject"))
    .find(
      (value) =>
        typeof value["name"] === "string" && value["name"].endsWith(`@${coordinate.version}`),
    );
  if (!subject) {
    throw new Error("Provenance subject does not identify the selected version.");
  }
  requireEqual(
    object(subject["digest"], "subject digest")["sha512"],
    Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex"),
    "provenance subject integrity",
  );
  const predicate = object(statement["predicate"], "provenance predicate");
  const definition = object(predicate["buildDefinition"], "build definition");
  const workflow = object(
    object(definition["externalParameters"], "external parameters")["workflow"],
    "source workflow",
  );
  requireEqual(
    workflow["repository"],
    "https://github.com/agent-teams-ai/engineering-foundation",
    "publisher repository",
  );
  requireEqual(workflow["path"], ".github/workflows/release.yml", "publisher workflow");
  const dependencies = array(definition["resolvedDependencies"], "resolved dependencies").map(
    (value) => object(value, "resolved dependency"),
  );
  const commits = dependencies
    .map((value) => object(value["digest"], "resolved digest")["gitCommit"])
    .filter((value): value is string => typeof value === "string");
  if (commits.length !== 1 || !/^[0-9a-f]{40}$/u.test(commits[0]!)) {
    throw new Error("Provenance must select one exact Git commit.");
  }
  const sourceCommit = commits[0]!;
  const invocation = string(
    object(object(predicate["runDetails"], "run details")["metadata"], "run metadata")[
      "invocationId"
    ],
    "invocation ID",
  );
  const runMatch =
    /^https:\/\/github\.com\/agent-teams-ai\/engineering-foundation\/actions\/runs\/([1-9][0-9]*)\/attempts\/([1-9][0-9]*)$/u.exec(
      invocation,
    );
  if (!runMatch) {
    throw new Error("Provenance invocation is not an exact producer run/attempt.");
  }
  const runId = Number(runMatch[1]),
    runAttempt = Number(runMatch[2]);
  if (!Number.isSafeInteger(runId) || !Number.isSafeInteger(runAttempt)) {
    throw new Error("Release run identity is outside its integer bound.");
  }
  const repo = "agent-teams-ai/engineering-foundation";
  const repository = await stableGithub(`repos/${repo}`);
  const branch = await stableGithub(`repos/${repo}/branches/main`);
  requireEqual(repository["id"], 1316243988, "producer repository ID");
  requireEqual(repository["full_name"], repo, "producer repository name");
  requireEqual(repository["default_branch"], "main", "producer default branch");
  requireEqual(branch["protected"], true, "producer protected main");
  const main = string(object(branch["commit"], "producer head")["sha"], "producer head SHA");
  const compare = await stableGithub(`repos/${repo}/compare/${sourceCommit}...${main}`);
  requireEqual(
    object(compare["merge_base_commit"], "release ancestry")["sha"],
    sourceCommit,
    "release ancestry",
  );
  const run = await stableGithub(`repos/${repo}/actions/runs/${runId}/attempts/${runAttempt}`);
  for (const [key, expected] of Object.entries({
    id: runId,
    run_attempt: runAttempt,
    head_sha: sourceCommit,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    path: ".github/workflows/release.yml",
    html_url: `https://github.com/${repo}/actions/runs/${runId}`,
  })) {
    requireEqual(run[key], expected, `release ${key}`);
  }
  const runRepository = object(run["repository"], "release repository");
  requireEqual(runRepository["id"], 1316243988, "release repository ID");
  requireEqual(runRepository["full_name"], repo, "release repository name");
  jsonEvidence(`packages/${index}-release-run.json`, run);
  return {
    ...coordinate,
    integrity,
    registry: "https://registry.npmjs.org/",
    published_at: publishedAt,
    provenance: {
      source_repository: repo,
      source_repository_id: 1316243988,
      source_workflow: ".github/workflows/release.yml",
      source_commit: sourceCommit,
      workflow_run_id: runId,
      workflow_run_attempt: runAttempt,
      registry_attestation_url: registryAttestationUrl,
      workflow_run_url: `https://github.com/${repo}/actions/runs/${runId}`,
      signature_verified: true,
    },
  };
}
