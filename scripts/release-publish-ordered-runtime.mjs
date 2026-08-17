import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  npmPurlName,
  orderedRelease,
  tarballIntegrity,
} from "./release-publish-ordered.mjs";
import { publishablePackageByName } from "./publishable-packages.mjs";

const EXPECTED_NPM_VERSION = "11.16.0";
export const GITHUB_RECONCILIATION_ATTEMPTS = 37;
export const GITHUB_RECONCILIATION_RETRY_MILLISECONDS = 5_000;

const delay = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

export function npmPublishArguments(artifact, tag) {
  const registry = artifact.registry ?? "https://registry.npmjs.org/";
  return [
    "publish", artifact.archivePath, "--access", "public", "--tag", tag,
    "--provenance", "--ignore-scripts", `--registry=${registry}`,
  ];
}

export function npmSignatureInstallArguments(artifact) {
  const registry = artifact.registry ?? "https://registry.npmjs.org/";
  return [
    "install", "--ignore-scripts", "--no-audit", "--fund=false", "--save-exact",
    `--registry=${registry}`, `${artifact.name}@${artifact.version}`,
  ];
}

function executeCommand(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...options,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${executable} ${args[0]} failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function statementFromAttestations(metadata) {
  const entries = metadata?.attestations?.filter(
    (entry) => entry?.predicateType === "https://slsa.dev/provenance/v1",
  );
  if (entries?.length !== 1) {
    return;
  }
  const envelope = entries[0]?.bundle?.dsseEnvelope;
  if (envelope?.payloadType !== "application/vnd.in-toto+json" || typeof envelope.payload !== "string") {
    return;
  }
  try {
    return JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  } catch {
    return;
  }
}

function soleEntry(value) {
  return Array.isArray(value) && value.length === 1 ? value[0] : undefined;
}

function exactDigestEntry(value, key) {
  return value !== null && typeof value === "object" &&
    Object.keys(value).length === 1 && typeof value[key] === "string";
}

function exactGitDependency(definition) {
  const dependency = soleEntry(definition?.resolvedDependencies);
  return typeof dependency?.uri === "string" && exactDigestEntry(dependency.digest, "gitCommit")
    ? dependency
    : undefined;
}

function exactShaSubject(statement) {
  const subject = soleEntry(statement.subject);
  return exactDigestEntry(subject?.digest, "sha512") ? subject : undefined;
}

export function provenanceFrom(statement) {
  if (statement?.["_type"] !== "https://in-toto.io/Statement/v1" ||
      statement.predicateType !== "https://slsa.dev/provenance/v1") {
    return;
  }
  const definition = statement.predicate?.buildDefinition;
  const workflow = definition?.externalParameters?.workflow;
  const dependency = exactGitDependency(definition);
  const subject = exactShaSubject(statement);
  if (dependency === undefined || subject === undefined) {
    return;
  }
  return {
    commit: dependency?.digest?.gitCommit,
    dependencyUri: dependency.uri,
    ref: workflow?.ref,
    repository: workflow?.repository,
    sha512: subject?.digest?.sha512,
    subjectName: subject?.name,
    workflow: workflow?.path,
  };
}

export function assertDownloadedTarballIntegrity(bytes, expectedIntegrity, packageName) {
  const downloadedIntegrity = tarballIntegrity(bytes);
  if (downloadedIntegrity !== expectedIntegrity) {
    throw new Error(`downloaded tarball SRI differs from registry metadata for ${packageName}.`);
  }
}

function exactVerifiedAuditEntry(evidence, artifact) {
  if (!Array.isArray(evidence?.invalid) || evidence.invalid.length !== 0 ||
      !Array.isArray(evidence?.missing) || evidence.missing.length !== 0 ||
      !Array.isArray(evidence?.verified)) {
    throw new Error("npm signature audit did not return clean verification evidence.");
  }
  const matches = evidence.verified.filter(
    (entry) => entry?.name === artifact.name && entry.version === artifact.version,
  );
  const bundles = matches[0]?.attestationBundles;
  const provenanceBundles = bundles?.filter(
    (bundle) => bundle?.predicateType === "https://slsa.dev/provenance/v1",
  );
  const publishBundles = bundles?.filter(
    (bundle) => bundle?.predicateType ===
      "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
  );
  if (matches.length !== 1 || matches[0].attestations?.provenance?.predicateType !==
      "https://slsa.dev/provenance/v1" || provenanceBundles?.length !== 1 ||
      publishBundles?.length !== 1) {
    throw new Error(`npm audit did not cryptographically verify signature and provenance for ${artifact.name}@${artifact.version}.`);
  }
  return { entry: matches[0], provenanceBundle: provenanceBundles[0] };
}

export function assertNpmSignatureEvidence(evidence, artifact) {
  exactVerifiedAuditEntry(evidence, artifact);
}

function statementFromVerifiedBundle(bundle) {
  const envelope = bundle?.bundle?.dsseEnvelope;
  if (envelope?.payloadType !== "application/vnd.in-toto+json" ||
      typeof envelope.payload !== "string") {
    throw new Error("npm verified SLSA bundle has no in-toto DSSE payload.");
  }
  const bytes = Buffer.from(envelope.payload, "base64");
  if (bytes.toString("base64") !== envelope.payload) {
    throw new Error("npm verified SLSA payload is not canonical base64.");
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("npm verified SLSA payload is not JSON.");
  }
}

function expectedIntegrityHex(integrity) {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/u.exec(integrity ?? "");
  const bytes = match === null ? undefined : Buffer.from(match[1], "base64");
  if (match === null || bytes.length !== 64 || bytes.toString("base64") !== match[1]) {
    throw new Error("npm verified provenance received non-canonical artifact SRI.");
  }
  return bytes.toString("hex");
}

export function verifiedProvenanceFromNpmAudit(evidence, artifact, source) {
  const { provenanceBundle } = exactVerifiedAuditEntry(evidence, artifact);
  const provenance = provenanceFrom(statementFromVerifiedBundle(provenanceBundle));
  const expectedSubject = `pkg:npm/${npmPurlName(artifact.name)}@${artifact.version}`;
  if (provenance?.repository !== source.repository || provenance.workflow !== source.workflow ||
      provenance.ref !== source.ref ||
      provenance.dependencyUri !== `git+${source.repository}@${source.ref}` ||
      !/^[a-f0-9]{40}$/u.test(provenance.commit ?? "") ||
      provenance.subjectName !== expectedSubject ||
      provenance.sha512 !== expectedIntegrityHex(artifact.integrity)) {
    throw new Error(`npm verified provenance is not bound to ${artifact.name}@${artifact.version} and its reviewed source.`);
  }
  return provenance;
}

async function verifyNpmSignature(artifact, source) {
  const temporary = await mkdtemp(join(tmpdir(), "ordered-release-signature-"));
  const registry = artifact.registry ?? "https://registry.npmjs.org/";
  try {
    await writeFile(join(temporary, "package.json"), `${JSON.stringify({ private: true })}\n`);
    executeCommand("npm", npmSignatureInstallArguments(artifact), {
      cwd: temporary, timeout: 120_000,
    });
    const evidence = JSON.parse(executeCommand("npm", [
      "audit", "signatures", "--json", "--include-attestations", `--registry=${registry}`,
    ], { cwd: temporary, timeout: 120_000 }));
    return verifiedProvenanceFromNpmAudit(evidence, artifact, source);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}

async function packedManifest(archivePath) {
  return JSON.parse(executeCommand("tar", ["-xOf", archivePath, "package/package.json"]));
}

function packedManifestFromBytes(archive) {
  return JSON.parse(executeCommand(
    "tar",
    ["-xzOf", "-", "package/package.json"],
    { input: archive },
  ));
}

function releaseNotes(changelog, version) {
  const marker = `## ${version}\n`;
  const start = changelog.indexOf(marker);
  if (start < 0) {
    throw new Error(`Changelog has no exact ${version} release entry.`);
  }
  const contentStart = start + marker.length;
  const next = changelog.indexOf("\n## ", contentStart);
  const content = changelog.slice(contentStart, next < 0 ? undefined : next).trim();
  if (content.length === 0) {
    throw new Error(`Changelog entry for ${version} is empty.`);
  }
  return content;
}

async function packArtifacts(cwd, state, destination) {
  const artifacts = [];
  for (const packageInfo of state.packages.public) {
    const catalog = publishablePackageByName(packageInfo.name);
    const report = JSON.parse(executeCommand(
      "pnpm",
      ["pack", "--json", "--pack-destination", destination],
      { cwd: join(cwd, catalog.root) },
    ));
    const item = Array.isArray(report) ? report[0] : report;
    if (item?.name !== packageInfo.name || item.version !== packageInfo.version || typeof item.filename !== "string") {
      throw new Error(`pnpm pack returned unexpected evidence for ${packageInfo.name}.`);
    }
    const archivePath = item.filename;
    if (!archivePath.startsWith(`${destination}/`)) {
      throw new Error(`pnpm pack wrote ${packageInfo.name} outside its release staging directory.`);
    }
    artifacts.push({
      archivePath,
      integrity: tarballIntegrity(await readFile(archivePath)),
      manifest: await packedManifest(archivePath),
      name: packageInfo.name,
      releaseNotes: releaseNotes(await readFile(join(cwd, catalog.changelogPath), "utf8"), packageInfo.version),
      registry: packageInfo.registry,
      version: packageInfo.version,
    });
  }
  return artifacts;
}

function isGitAncestor(cwd, ancestor, descendant) {
  if (!/^[a-f0-9]{40}$/u.test(ancestor)) {
    return false;
  }
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status === 0) {
    return true;
  }
  if (result.status === 1) {
    return false;
  }
  throw new Error(`git ancestry verification failed with ${result.status}.`);
}

function githubJson(args, { allowNotFound = false } = {}) {
  const result = spawnSync("gh", ["api", ...args], { encoding: "utf8" });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (allowNotFound && result.status !== 0 && /HTTP 404/u.test(result.stderr)) {
    return;
  }
  if (result.status !== 0) {
    throw new Error(`gh api failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout.length === 0 ? undefined : JSON.parse(result.stdout);
}

export function assertLiveMainHead(repository, expectedCommit, request = githubJson) {
  const live = request([`repos/${repository}/git/ref/heads/main`]);
  if (live?.ref !== "refs/heads/main" || live.object?.type !== "commit" ||
      live.object.sha !== expectedCommit) {
    throw new Error("Ordered publishing refused because protected main advanced beyond this run.");
  }
}

function assertExistingGithubRelease(release, artifact, tag) {
  if (release.tag_name !== tag || release.name !== tag || release.body !== artifact.releaseNotes ||
      release.prerelease !== artifact.version.includes("-") || release.draft !== false) {
    throw new Error(`Existing GitHub release ${tag} differs from the reviewed changelog evidence.`);
  }
}

function gitObjectCommit(repository, object, request, depth = 0) {
  if (object?.type === "commit" && /^[a-f0-9]{40}$/u.test(object.sha ?? "")) {
    return object.sha;
  }
  if (object?.type !== "tag" || !/^[a-f0-9]{40}$/u.test(object.sha ?? "") || depth >= 4) {
    throw new Error("Git tag does not resolve through a bounded tag chain to one commit.");
  }
  const tag = request([`repos/${repository}/git/tags/${object.sha}`]);
  return gitObjectCommit(repository, tag.object, request, depth + 1);
}

async function reconcileGithubReleaseOnce(artifact, releaseCommit, options) {
  const repository = options.repository ?? process.env.GITHUB_REPOSITORY;
  const request = options.request ?? githubJson;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "")) {
    throw new Error("GitHub release reconciliation requires an exact repository identity.");
  }
  const tag = `${artifact.name}@${artifact.version}`;
  const encodedTag = encodeURIComponent(tag);
  const tagRef = request([`repos/${repository}/git/ref/tags/${encodedTag}`], { allowNotFound: true });
  if (tagRef === undefined) {
    const createdRef = request([
      "--method", "POST", `repos/${repository}/git/refs`,
      "-f", `ref=refs/tags/${tag}`, "-f", `sha=${releaseCommit}`,
    ]);
    if (gitObjectCommit(repository, createdRef?.object, request) !== releaseCommit) {
      throw new Error(`Created Git tag ${tag} is not bound to the trusted release commit.`);
    }
  } else if (gitObjectCommit(repository, tagRef.object, request) !== releaseCommit) {
    throw new Error(`Existing Git tag ${tag} is not bound to the trusted release commit.`);
  }
  const release = request([`repos/${repository}/releases/tags/${encodedTag}`], { allowNotFound: true });
  if (release !== undefined) {
    assertExistingGithubRelease(release, artifact, tag);
    return;
  }
  const createdRelease = request([
    "--method", "POST", `repos/${repository}/releases`,
    "-f", `tag_name=${tag}`, "-f", `name=${tag}`, "-f", `body=${artifact.releaseNotes}`,
    "-F", `prerelease=${artifact.version.includes("-")}`, "-F", "draft=false",
  ]);
  assertExistingGithubRelease(createdRelease, artifact, tag);
}

function isTransientGithubFailure(error) {
  return /HTTP (?:502|503|504)\b/u.test(error?.message ?? "");
}

export async function reconcileGithubRelease(artifact, releaseCommit, options = {}) {
  const attempts = options.attempts ?? GITHUB_RECONCILIATION_ATTEMPTS;
  const retryDelayMilliseconds = options.retryDelayMilliseconds ??
    GITHUB_RECONCILIATION_RETRY_MILLISECONDS;
  const wait = options.wait ?? delay;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await reconcileGithubReleaseOnce(artifact, releaseCommit, options);
    } catch (error) {
      if (!isTransientGithubFailure(error) || attempt + 1 >= attempts) {
        throw error;
      }
      await wait(retryDelayMilliseconds);
    }
  }
}

function registryUrl(artifact, path) {
  const registry = artifact.registry ?? "https://registry.npmjs.org/";
  return new URL(path, registry.endsWith("/") ? registry : `${registry}/`);
}

async function fetchJson(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`registry returned ${response.status} for ${url}`);
  }
  return await response.json();
}

async function inspectVersion(artifact) {
  let response;
  try {
    response = await fetch(registryUrl(artifact, encodeURIComponent(artifact.name)), {
      headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return { error, status: "unknown" };
  }
  if (response.status === 404) {
    return { status: "absent" };
  }
  if (!response.ok) {
    return { error: new Error(`registry returned ${response.status}`), status: "unknown" };
  }
  const packument = await response.json();
  const version = packument?.versions?.[artifact.version];
  if (version === undefined) {
    return { status: "absent" };
  }
  try {
    const archiveResponse = await fetch(version.dist.tarball, { signal: AbortSignal.timeout(10_000) });
    if (!archiveResponse.ok) {
      throw new Error(`tarball download returned ${archiveResponse.status}`);
    }
    const archive = Buffer.from(await archiveResponse.arrayBuffer());
    assertDownloadedTarballIntegrity(archive, version.dist.integrity, artifact.name);
    const manifest = packedManifestFromBytes(archive);
    const attestations = await fetchJson(
      registryUrl(artifact, `-/npm/v1/attestations/${encodeURIComponent(artifact.name)}@${artifact.version}`),
    );
    return {
      distTags: packument["dist-tags"] ?? {},
      integrity: version.dist.integrity,
      manifest,
      provenance: provenanceFrom(statementFromAttestations(attestations)),
      publishedAt: packument.time?.[artifact.version],
      status: "present",
    };
  } catch (error) {
    return { error, status: "unknown" };
  }
}

export async function publishOrderedRelease({ cwd, decision, state }) {
  const source = {
    commit: process.env.GITHUB_SHA,
    ref: process.env.GITHUB_REF,
    repository: `https://github.com/${process.env.GITHUB_REPOSITORY}`,
    workflow: ".github/workflows/release.yml",
    isTrustedCommit: async (commit) => isGitAncestor(cwd, commit, process.env.GITHUB_SHA),
  };
  if (!/^[a-f0-9]{40}$/u.test(source.commit ?? "") || source.ref !== "refs/heads/main" ||
      !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(source.repository)) {
    throw new Error("Ordered publishing requires the exact protected-main GitHub source identity.");
  }
  const npmVersion = executeCommand("npm", ["--version"], { cwd }).trim();
  if (npmVersion !== EXPECTED_NPM_VERSION) {
    throw new Error(`Ordered publishing requires npm ${EXPECTED_NPM_VERSION}, observed ${npmVersion}.`);
  }
  const temporary = await mkdtemp(join(tmpdir(), "ordered-release-pack-"));
  try {
    const artifacts = await packArtifacts(cwd, state, temporary);
    const repository = process.env.GITHUB_REPOSITORY;
    const released = await orderedRelease({
      artifacts,
      authorizePublish: () => assertLiveMainHead(repository, source.commit),
      finalTag: decision.tag ?? "latest",
      inspect: inspectVersion,
      publish: async (artifact, tag) => {
        executeCommand("npm", npmPublishArguments(artifact, tag), { cwd });
      },
      reconcileRelease: reconcileGithubRelease,
      source,
      verifySignature: async (artifact) => await verifyNpmSignature(artifact, source),
    });
    process.stdout.write(changesetsReleaseOutput(released));
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}

export function changesetsReleaseOutput(released) {
  if (!released.emitReleaseLines) {
    return "";
  }
  return [released.foundation, released.docs]
    .filter(({ emitReleaseLine }) => emitReleaseLine)
    .map(({ name, version }) => `New tag: ${name}@${version}\n`)
    .join("");
}
