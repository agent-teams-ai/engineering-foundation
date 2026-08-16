import { createHash } from "node:crypto";

export const FOUNDATION_PACKAGE = "@agent-teams/engineering-foundation";
export const DOCS_PACKAGE = "@agent-teams/docs-protocol";

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

async function exactSource(provenance, artifact, source) {
  return (
    provenance?.repository === source.repository &&
    provenance.workflow === source.workflow &&
    provenance.ref === source.ref &&
    provenance.dependencyUri === `git+${source.repository}@${source.ref}` &&
    typeof provenance.commit === "string" &&
    await source.isTrustedCommit(provenance.commit) &&
    provenance.subjectName === `pkg:npm/${artifact.name.replace("@", "%40")}@${artifact.version}` &&
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

function exactFoundationDependency(docs, foundation) {
  return docs.manifest?.dependencies?.[foundation.name] === foundation.version;
}

function assertReleaseWave({ artifacts, authorizePublish, docs, foundation, reconcileRelease, source,
  verifySignature }) {
  if (foundation === undefined || docs === undefined || artifacts.length !== 2) {
    fail("the release wave must contain exactly Foundation and Docs Protocol");
  }
  if (typeof verifySignature !== "function") {
    fail("an npm cryptographic signature verifier is required");
  }
  if (typeof authorizePublish !== "function" || typeof reconcileRelease !== "function" ||
      typeof source?.isTrustedCommit !== "function") {
    fail("live-main authorization, idempotent release reconciliation and source ancestry verification are required");
  }
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

export async function orderedRelease({
  artifacts,
  authorizePublish,
  finalTag,
  inspect,
  publish,
  verifySignature,
  reconcileRelease,
  source,
  attempts = 12,
  retryDelayMilliseconds = 5_000,
}) {
  const foundation = artifacts.find(({ name }) => name === FOUNDATION_PACKAGE);
  const docs = artifacts.find(({ name }) => name === DOCS_PACKAGE);
  assertReleaseWave({
    artifacts, authorizePublish, docs, foundation, reconcileRelease, source, verifySignature,
  });
  if (!exactFoundationDependency(docs, foundation)) {
    fail("packed Docs Protocol manifest must depend on the exact Foundation release version");
  }
  if (!/^(?:latest|rc)$/u.test(finalTag)) {
    fail("the final npm tag must be exactly latest or rc");
  }

  const foundationBefore = await inspect(foundation).catch(
    (error) => ({ status: "unknown", error }),
  );
  const docsBeforePair = await inspect(docs).catch((error) => ({ status: "unknown", error }));
  await assertInitialObservation({
    artifact: foundation, finalTag, published: foundationBefore, source,
  });
  await assertInitialObservation({ artifact: docs, finalTag, published: docsBeforePair, source });
  if (foundationBefore.status === "absent" && docsBeforePair.status === "present") {
    fail("Docs Protocol exists without its exact Foundation pair; quarantine before releasing");
  }

  const foundationPublished = await publishOrReuse({
    artifact: foundation, attempts, authorizePublish, finalTag, inspect, publish,
    initial: foundationBefore, retryDelayMilliseconds, source,
  });
  const foundationProvenance = await verifySignature(foundation);
  await assertVerifiedAuthority(foundation, foundationPublished, foundationProvenance, source);
  const docsBefore = await inspect(docs).catch((error) => ({ status: "unknown", error }));
  if (docsBefore.status === "present") {
    await assertReusable(docs, docsBefore, source);
    if (Date.parse(docsBefore.publishedAt) < Date.parse(foundationPublished.publishedAt)) {
      fail("Docs Protocol was published before its exact Foundation dependency");
    }
  } else if (docsBefore.status === "unknown") {
    fail(`${docs.name}@${docs.version} preflight result is unknown`);
  }
  if (docsBefore.status === "absent" && foundationProvenance.commit !== source.commit) {
    fail("a missing Docs Protocol version may be published only by the Foundation provenance-owning commit");
  }
  const docsPublished = docsBefore.status === "present"
    ? docsBefore
    : await publishOrReuse({
      artifact: docs, attempts, authorizePublish, finalTag, inspect, publish,
      initial: docsBefore, retryDelayMilliseconds, source,
    });
  assertFinalTag(docs, docsPublished, finalTag);
  if (!exactFoundationDependency({ manifest: docsPublished.manifest }, foundation)) {
    fail("published Docs Protocol tarball manifest does not bind the exact Foundation version");
  }
  if (Date.parse(foundationPublished.publishedAt) > Date.parse(docsPublished.publishedAt)) {
    fail("Foundation published_at must be earlier than or equal to Docs Protocol published_at");
  }
  const docsProvenance = await verifySignature(docs);
  await assertVerifiedAuthority(docs, docsPublished, docsProvenance, source);

  const foundationFinal = await inspectFinalSnapshot({
    artifact: foundation, finalTag, inspect, provenance: foundationProvenance, source,
  });
  const docsFinal = await inspectFinalSnapshot({
    artifact: docs, finalTag, inspect, provenance: docsProvenance, source,
  });
  if (!exactFoundationDependency({ manifest: docsFinal.manifest }, foundation) ||
      Date.parse(foundationFinal.publishedAt) > Date.parse(docsFinal.publishedAt)) {
    fail("the final registry snapshot does not preserve the ordered exact package pair");
  }
  for (const [artifact, provenance] of [
    [foundation, foundationProvenance], [docs, docsProvenance],
  ]) {
    await reconcileRelease(artifact, provenance.commit);
  }
  return {
    docs: {
      ...docs, ...docsFinal, provenance: docsProvenance,
      emitReleaseLine: docsProvenance.commit === source.commit,
    },
    emitReleaseLines: [foundationProvenance, docsProvenance].some(
      (provenance) => provenance.commit === source.commit,
    ),
    foundation: {
      ...foundation, ...foundationFinal, provenance: foundationProvenance,
      emitReleaseLine: foundationProvenance.commit === source.commit,
    },
  };
}

export function tarballIntegrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}
