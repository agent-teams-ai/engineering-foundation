import { createHash } from "node:crypto";

import {
  PUBLISHABLE_PACKAGE_DEPENDENCIES,
  PUBLISHABLE_PACKAGES,
} from "./publishable-packages.mjs";

export const FOUNDATION_PACKAGE = "@agent-teams/engineering-foundation";
export const DOCS_PACKAGE = "@agent-teams/docs-protocol";
export const DOCS_MCP_PACKAGE = "@agent-teams/docs-protocol-mcp";
export const REGISTRY_OBSERVATION_ATTEMPTS = 73;
export const REGISTRY_OBSERVATION_RETRY_MILLISECONDS = 5_000;

const RELEASE_GRAPH = Object.freeze(PUBLISHABLE_PACKAGES.map(({ name }) => Object.freeze({
  name,
  dependencies: PUBLISHABLE_PACKAGE_DEPENDENCIES[name] ?? Object.freeze([]),
})));

const delay = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

function fail(message) {
  throw new Error(`Ordered release refused: ${message}`);
}

function canonicalIntegrity(integrity) {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/u.exec(integrity ?? "");
  if (match === null || Buffer.from(match[1], "base64").length !== 64) {
    fail("registry or local tarball has non-canonical SHA-512 SRI");
  }
  return match[1];
}

export function npmPurlName(name) {
  if (typeof name !== "string" ||
      !/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u.test(name)) {
    fail("artifact has a non-canonical npm package name");
  }
  return name.startsWith("@") ? `%40${name.slice(1)}` : name;
}

async function exactSource(provenance, artifact, source) {
  return (
    provenance?.repository === source.repository &&
    provenance.workflow === source.workflow &&
    provenance.ref === source.ref &&
    provenance.dependencyUri === `git+${source.repository}@${source.ref}` &&
    typeof provenance.commit === "string" &&
    await source.isTrustedCommit(provenance.commit) &&
    provenance.subjectName === `pkg:npm/${npmPurlName(artifact.name)}@${artifact.version}` &&
    provenance.sha512 === Buffer.from(canonicalIntegrity(artifact.integrity), "base64").toString("hex")
  );
}

async function assertReusable(artifact, published, source) {
  if (published.integrity !== artifact.integrity) {
    fail(`${artifact.name}@${artifact.version} exists with different tarball SRI; quarantine it and release a new version`);
  }
  if (JSON.stringify(published.manifest) !== JSON.stringify(artifact.manifest)) {
    fail(`${artifact.name}@${artifact.version} exists with a different packed manifest; quarantine it and release a new version`);
  }
  if (!(await exactSource(published.provenance, artifact, source))) {
    fail(`${artifact.name}@${artifact.version} provenance is absent or is not bound to the reviewed source`);
  }
  if (Number.isNaN(Date.parse(published.publishedAt ?? ""))) {
    fail(`${artifact.name}@${artifact.version} has no trustworthy publication timestamp`);
  }
}

async function assertVerifiedAuthority(artifact, published, provenance, source) {
  if (!(await exactSource(provenance, artifact, source))) {
    fail(`${artifact.name}@${artifact.version} cryptographically verified provenance is not bound to the reviewed source`);
  }
  if (JSON.stringify(provenance) !== JSON.stringify(published.provenance)) {
    fail(`${artifact.name}@${artifact.version} raw registry provenance disagrees with npm's verified attestation`);
  }
}

function assertFinalTag(artifact, published, finalTag) {
  const observed = published.distTags?.[finalTag];
  if (observed !== artifact.version) {
    fail(`${artifact.name}@${artifact.version} is not the exact ${finalTag} dist-tag target`);
  }
}

async function observeExact({ artifact, finalTag, inspect, source, attempts, retryDelayMilliseconds }) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await inspect(artifact).catch((error) => ({ status: "unknown", error }));
    if (last.status === "present") {
      await assertReusable(artifact, last, source);
      assertFinalTag(artifact, last, finalTag);
      return last;
    }
    if (last.status !== "absent" && last.status !== "unknown") {
      fail(`${artifact.name}@${artifact.version} inspection returned an invalid state`);
    }
    if (attempt + 1 < attempts) {
      await delay(retryDelayMilliseconds);
    }
  }
  const reason = last?.error?.message === undefined ? last?.status : last.error.message;
  fail(`${artifact.name}@${artifact.version} registry result remained ${reason ?? "unknown"}`);
}

async function publishOrReuse(options) {
  const initial = options.initial ??
    await options.inspect(options.artifact).catch((error) => ({ status: "unknown", error }));
  if (initial.status === "present") {
    await assertReusable(options.artifact, initial, options.source);
    assertFinalTag(options.artifact, initial, options.finalTag);
    return initial;
  }
  if (initial.status === "unknown") {
    fail(`${options.artifact.name}@${options.artifact.version} preflight result is unknown`);
  }
  if (initial.status !== "absent") {
    fail(`${options.artifact.name}@${options.artifact.version} preflight returned an invalid state`);
  }
  const authorization = options.authorizePublish(options.artifact);
  if (authorization !== undefined) {
    fail("the live main publication authorization must complete synchronously");
  }
  try {
    await options.publish(options.artifact, options.finalTag);
  } catch {
    // npm can lose the response after accepting an immutable version. Reconcile below.
  }
  return await observeExact(options);
}

async function assertInitialObservation({ artifact, finalTag, published, source }) {
  if (published.status === "present") {
    await assertReusable(artifact, published, source);
    assertFinalTag(artifact, published, finalTag);
    return;
  }
  if (published.status === "absent") {
    return;
  }
  const reason = published.error?.message ?? published.status;
  fail(`${artifact.name}@${artifact.version} pair preflight is unknown (${reason ?? "invalid state"})`);
}

function exactReleaseDependency(artifact, dependency) {
  return artifact.manifest?.dependencies?.[dependency.name] === dependency.version;
}

function assertReleaseWave({ artifacts, authorizePublish, reconcileRelease, source,
  verifySignature }) {
  const releaseNames = RELEASE_GRAPH.map(({ name }) => name);
  const dependencyConfigNames = Object.keys(PUBLISHABLE_PACKAGE_DEPENDENCIES);
  if (new Set(releaseNames).size !== releaseNames.length ||
      dependencyConfigNames.length !== releaseNames.length ||
      dependencyConfigNames.some((name) => !releaseNames.includes(name)) ||
      RELEASE_GRAPH.some((entry, index) => entry.dependencies.some(
        (dependency) => releaseNames.indexOf(dependency) < 0 || releaseNames.indexOf(dependency) >= index,
      ))) {
    fail("the publishable package dependency graph must be complete, unique, and topologically ordered");
  }
  const artifactsByName = new Map(artifacts.map((artifact) => [artifact.name, artifact]));
  if (artifactsByName.size !== artifacts.length || artifacts.length !== RELEASE_GRAPH.length ||
      RELEASE_GRAPH.some(({ name }) => !artifactsByName.has(name))) {
    fail(`the release wave must contain exactly ${RELEASE_GRAPH.map(({ name }) => name).join(", ")}`);
  }
  for (const entry of RELEASE_GRAPH) {
    const artifact = artifactsByName.get(entry.name);
    for (const dependencyName of entry.dependencies) {
      if (!exactReleaseDependency(artifact, artifactsByName.get(dependencyName))) {
        fail(`${artifact.name} must depend on the exact ${dependencyName} release version`);
      }
    }
  }
  if (typeof verifySignature !== "function") {
    fail("an npm cryptographic signature verifier is required");
  }
  if (typeof authorizePublish !== "function" || typeof reconcileRelease !== "function" ||
      typeof source?.isTrustedCommit !== "function") {
    fail("live-main authorization, idempotent release reconciliation and source ancestry verification are required");
  }
  return artifactsByName;
}

async function inspectFinalSnapshot({ artifact, finalTag, inspect, provenance, source }) {
  const published = await inspect(artifact).catch((error) => ({ status: "unknown", error }));
  if (published.status !== "present") {
    fail(`${artifact.name}@${artifact.version} final registry snapshot is not present`);
  }
  await assertReusable(artifact, published, source);
  await assertVerifiedAuthority(artifact, published, provenance, source);
  assertFinalTag(artifact, published, finalTag);
  return published;
}

async function observeInitialWave({ artifactsByName, finalTag, inspect, source }) {
  const initialByName = new Map();
  for (const entry of RELEASE_GRAPH) {
    const artifact = artifactsByName.get(entry.name);
    const initial = await inspect(artifact).catch((error) => ({ status: "unknown", error }));
    await assertInitialObservation({ artifact, finalTag, published: initial, source });
    initialByName.set(entry.name, initial);
  }
  for (const entry of RELEASE_GRAPH) {
    if (initialByName.get(entry.name).status !== "present") {
      continue;
    }
    for (const dependencyName of entry.dependencies) {
      if (initialByName.get(dependencyName).status === "absent") {
        fail(`${entry.name} exists without its exact ${dependencyName} dependency; quarantine before releasing`);
      }
    }
  }
}

export async function orderedRelease({
  artifacts,
  authorizePublish,
  finalTag,
  inspect,
  publish,
  verifySignature,
  reconcileRelease,
  source,
  attempts = REGISTRY_OBSERVATION_ATTEMPTS,
  retryDelayMilliseconds = REGISTRY_OBSERVATION_RETRY_MILLISECONDS,
}) {
  const artifactsByName = assertReleaseWave({
    artifacts, authorizePublish, reconcileRelease, source, verifySignature,
  });
  if (!/^(?:latest|rc)$/u.test(finalTag)) {
    fail("the final npm tag must be exactly latest or rc");
  }

  await observeInitialWave({ artifactsByName, finalTag, inspect, source });

  const publishedByName = new Map();
  const provenanceByName = new Map();
  for (const entry of RELEASE_GRAPH) {
    const artifact = artifactsByName.get(entry.name);
    const before = await inspect(artifact).catch((error) => ({ status: "unknown", error }));
    if (before.status === "unknown") {
      fail(`${artifact.name}@${artifact.version} preflight result is unknown`);
    }
    if (before.status === "present") {
      await assertReusable(artifact, before, source);
    }
    const published = before.status === "present"
      ? before
      : await publishOrReuse({
        artifact, attempts, authorizePublish, finalTag, inspect, publish,
        initial: before, retryDelayMilliseconds, source,
      });
    assertFinalTag(artifact, published, finalTag);
    for (const dependencyName of entry.dependencies) {
      const dependency = artifactsByName.get(dependencyName);
      const dependencyPublished = publishedByName.get(dependencyName);
      if (!exactReleaseDependency({ manifest: published.manifest }, dependency)) {
        fail(`${artifact.name} tarball manifest does not bind the exact ${dependencyName} version`);
      }
      if (Date.parse(dependencyPublished.publishedAt) > Date.parse(published.publishedAt)) {
        fail(`${artifact.name} was published before its exact ${dependencyName} dependency`);
      }
    }
    const provenance = await verifySignature(artifact);
    await assertVerifiedAuthority(artifact, published, provenance, source);
    publishedByName.set(entry.name, published);
    provenanceByName.set(entry.name, provenance);
  }

  const releasedArtifacts = [];
  const finalByName = new Map();
  for (const entry of RELEASE_GRAPH) {
    const artifact = artifactsByName.get(entry.name);
    const provenance = provenanceByName.get(entry.name);
    const final = await inspectFinalSnapshot({
      artifact, finalTag, inspect, provenance, source,
    });
    for (const dependencyName of entry.dependencies) {
      if (!exactReleaseDependency({ manifest: final.manifest }, artifactsByName.get(dependencyName)) ||
          Date.parse(finalByName.get(dependencyName).publishedAt) > Date.parse(final.publishedAt)) {
        fail(`the final registry snapshot does not preserve ${dependencyName} -> ${artifact.name}`);
      }
    }
    finalByName.set(entry.name, final);
    releasedArtifacts.push({
      ...artifact, ...final, provenance,
      emitReleaseLine: provenance.commit === source.commit,
    });
  }
  for (const artifact of releasedArtifacts) {
    await reconcileRelease(artifact, artifact.provenance.commit);
  }
  const byName = new Map(releasedArtifacts.map((artifact) => [artifact.name, artifact]));
  return {
    artifacts: releasedArtifacts,
    docs: byName.get(DOCS_PACKAGE),
    docsMcp: byName.get(DOCS_MCP_PACKAGE),
    emitReleaseLines: releasedArtifacts.some(({ emitReleaseLine }) => emitReleaseLine),
    foundation: byName.get(FOUNDATION_PACKAGE),
  };
}

export function tarballIntegrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}
