import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DOCS_PACKAGE,
  FOUNDATION_PACKAGE,
  orderedRelease,
  tarballIntegrity,
} from "../scripts/release-publish-ordered.mjs";
import {
  assertDownloadedTarballIntegrity,
  assertLiveMainHead,
  assertNpmSignatureEvidence,
  changesetsReleaseOutput,
  npmPublishArguments,
  npmSignatureInstallArguments,
  provenanceFrom,
  reconcileGithubRelease,
  verifiedProvenanceFromNpmAudit,
} from "../scripts/release-publish-ordered-runtime.mjs";

const source = {
  commit: "a".repeat(40),
  ref: "refs/heads/main",
  repository: "https://github.com/agent-teams-ai/engineering-foundation",
  workflow: ".github/workflows/release.yml",
  isTrustedCommit: async (commit) => commit === "a".repeat(40),
};
const foundation = artifact(FOUNDATION_PACKAGE, "1.2.3", {});
const docs = artifact(DOCS_PACKAGE, "2.0.0", { [FOUNDATION_PACKAGE]: foundation.version });

function artifact(name, version, dependencies) {
  const manifest = { dependencies, name, version };
  return { integrity: tarballIntegrity(Buffer.from(JSON.stringify(manifest))), manifest, name, version };
}

function argumentField(args, prefix) {
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function artifactProvenance(value, commit = source.commit) {
  const encoded = value.name.replace("@", "%40");
  return {
    commit,
    dependencyUri: `git+${source.repository}@${source.ref}`,
    ref: source.ref,
    repository: source.repository,
    sha512: Buffer.from(value.integrity.slice("sha512-".length), "base64").toString("hex"),
    subjectName: `pkg:npm/${encoded}@${value.version}`,
    workflow: source.workflow,
  };
}

function provenanceStatement(value, provenance = artifactProvenance(value)) {
  return {
    _type: "https://in-toto.io/Statement/v1",
    predicate: { buildDefinition: {
      externalParameters: { workflow: {
        path: provenance.workflow, ref: provenance.ref, repository: provenance.repository,
      } },
      resolvedDependencies: [{
        digest: { gitCommit: provenance.commit }, uri: provenance.dependencyUri,
      }],
    } },
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{
      digest: { sha512: provenance.sha512 }, name: provenance.subjectName,
    }],
  };
}

function auditEvidence(value, provenance = artifactProvenance(value)) {
  const payload = Buffer.from(JSON.stringify(provenanceStatement(value, provenance))).toString("base64");
  return {
    invalid: [],
    missing: [],
    verified: [{
      attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } },
      attestationBundles: [
        { predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1" },
        { bundle: { dsseEnvelope: {
          payload, payloadType: "application/vnd.in-toto+json",
        } }, predicateType: "https://slsa.dev/provenance/v1" },
      ],
      name: value.name,
      version: value.version,
    }],
  };
}

function present(value, publishedAt, tag = "latest") {
  return {
    integrity: value.integrity,
    distTags: { [tag]: value.version },
    manifest: structuredClone(value.manifest),
    provenance: artifactProvenance(value),
    publishedAt,
    status: "present",
  };
}

function harness(initial = {}) {
  const calls = [];
  const states = new Map(Object.entries(initial));
  return {
    authorizePublish: (value) => {
      calls.push(`authorize:${value.name}`);
    },
    calls,
    states,
    inspect: async (value) => {
      calls.push(`inspect:${value.name}`);
      const state = states.get(value.name);
      return typeof state === "function" ? await state(value) : (state ?? { status: "absent" });
    },
    publish: async (value, tag) => {
      calls.push(`publish:${value.name}:${tag}`);
      const timestamp = value.name === FOUNDATION_PACKAGE ? "2026-01-01T00:00:00.000Z" : "2026-01-01T00:00:01.000Z";
      const published = present(value, timestamp, tag);
      states.set(value.name, published);
    },
    reconcileRelease: async (value) => calls.push(`release:${value.name}`),
    verifySignature: async (value) => {
      calls.push(`signature:${value.name}`);
      return structuredClone(states.get(value.name).provenance);
    },
  };
}

async function run(runtime, overrides = {}) {
  return await orderedRelease({
    artifacts: [docs, foundation],
    attempts: 2,
    finalTag: "latest",
    retryDelayMilliseconds: 0,
    source,
    ...runtime,
    ...overrides,
  });
}

test("publishes Foundation directly on the final tag and proves it before publishing Docs", async () => {
  const runtime = harness();
  await run(runtime);
  const foundationPublish = runtime.calls.indexOf(`publish:${FOUNDATION_PACKAGE}:latest`);
  const foundationSignature = runtime.calls.indexOf(`signature:${FOUNDATION_PACKAGE}`);
  const docsPublish = runtime.calls.indexOf(`publish:${DOCS_PACKAGE}:latest`);
  const docsSignature = runtime.calls.indexOf(`signature:${DOCS_PACKAGE}`);
  const firstRelease = runtime.calls.indexOf(`release:${FOUNDATION_PACKAGE}`);
  const foundationFinalInspect = runtime.calls.lastIndexOf(`inspect:${FOUNDATION_PACKAGE}`);
  const docsFinalInspect = runtime.calls.lastIndexOf(`inspect:${DOCS_PACKAGE}`);
  assert.ok(foundationPublish >= 0 && foundationPublish < docsPublish);
  assert.ok(foundationPublish < foundationSignature && foundationSignature < docsPublish);
  assert.ok(docsPublish < docsSignature);
  assert.ok(docsSignature < foundationFinalInspect && foundationFinalInspect < docsFinalInspect);
  assert.ok(docsFinalInspect < firstRelease);
  assert.equal(runtime.calls.some((entry) => /^(?:tag|untag):/u.test(entry)), false);
});

test("publishes an RC pair directly on rc without moving latest", async () => {
  const runtime = harness();
  await run(runtime, { finalTag: "rc" });
  assert.equal(runtime.states.get(FOUNDATION_PACKAGE).distTags.rc, foundation.version);
  assert.equal(runtime.states.get(DOCS_PACKAGE).distTags.rc, docs.version);
  assert.equal(runtime.states.get(FOUNDATION_PACKAGE).distTags.latest, undefined);
  assert.equal(runtime.states.get(DOCS_PACKAGE).distTags.latest, undefined);
});

test("refuses every non-governed npm tag before publication", async () => {
  const runtime = harness();
  await assert.rejects(run(runtime, { finalTag: "beta" }), /exactly latest or rc/u);
  assert.equal(runtime.calls.some((entry) => entry.startsWith("publish:")), false);
});

test("refuses the first npm write when protected main advanced during qualification", async () => {
  const runtime = harness();
  runtime.authorizePublish = () => {
    throw new Error("protected main advanced");
  };
  await assert.rejects(run(runtime), /protected main advanced/u);
  assert.equal(runtime.calls.some((entry) => entry.startsWith("publish:")), false);
});

test("refuses Docs publication when protected main advances after Foundation", async () => {
  const runtime = harness();
  let liveMain = source.commit;
  runtime.authorizePublish = () => {
    if (liveMain !== source.commit) {
      throw new Error("protected main advanced");
    }
  };
  runtime.verifySignature = async (value) => {
    runtime.calls.push(`signature:${value.name}`);
    const provenance = structuredClone(runtime.states.get(value.name).provenance);
    if (value.name === FOUNDATION_PACKAGE) {
      liveMain = "b".repeat(40);
    }
    return provenance;
  };
  await assert.rejects(run(runtime), /protected main advanced/u);
  assert.equal(runtime.calls.some((entry) => entry.startsWith(`publish:${FOUNDATION_PACKAGE}`)), true);
  assert.equal(runtime.calls.some((entry) => entry.startsWith(`publish:${DOCS_PACKAGE}`)), false);
});

test("live-main verifier accepts only the exact protected-main commit", () => {
  const exact = () => ({
    object: { sha: source.commit, type: "commit" },
    ref: "refs/heads/main",
  });
  assert.doesNotThrow(() => assertLiveMainHead("agent-teams-ai/engineering-foundation", source.commit, exact));
  assert.throws(
    () => assertLiveMainHead("agent-teams-ai/engineering-foundation", source.commit, () => ({
      object: { sha: "b".repeat(40), type: "commit" }, ref: "refs/heads/main",
    })),
    /protected main advanced/u,
  );
});

test("emits the exact deterministic lines parsed by the pinned Changesets action", () => {
  const output = changesetsReleaseOutput({
    docs: { ...docs, emitReleaseLine: true },
    emitReleaseLines: true,
    foundation: { ...foundation, emitReleaseLine: true },
  });
  assert.equal(
    output,
    `New tag: ${FOUNDATION_PACKAGE}@${foundation.version}\n` +
      `New tag: ${DOCS_PACKAGE}@${docs.version}\n`,
  );
  const pinnedChangesetsActionPattern = /New tag:\s+(@[^/]+\/[^@]+|[^/]+)@([^\s]+)/gu;
  assert.deepEqual(
    [...output.matchAll(pinnedChangesetsActionPattern)].map((match) => ({ name: match[1], version: match[2] })),
    [
      { name: FOUNDATION_PACKAGE, version: foundation.version },
      { name: DOCS_PACKAGE, version: docs.version },
    ],
  );
});

test("rejects downloaded tarball bytes that do not match registry SRI", () => {
  const bytes = Buffer.from("downloaded tarball");
  assert.doesNotThrow(() =>
    assertDownloadedTarballIntegrity(bytes, tarballIntegrity(bytes), FOUNDATION_PACKAGE));
  assert.throws(
    () => assertDownloadedTarballIntegrity(bytes, foundation.integrity, FOUNDATION_PACKAGE),
    /downloaded tarball SRI differs from registry metadata/u,
  );
});

test("accepts only exact npm-verified signature and provenance evidence", () => {
  const evidence = auditEvidence(foundation);
  assert.doesNotThrow(() => assertNpmSignatureEvidence(evidence, foundation));
  assert.deepEqual(
    verifiedProvenanceFromNpmAudit(evidence, foundation, source),
    artifactProvenance(foundation),
  );
  assert.throws(
    () => assertNpmSignatureEvidence({ ...evidence, invalid: [{}] }, foundation),
    /clean verification evidence/u,
  );
  assert.throws(
    () => assertNpmSignatureEvidence({ ...evidence, verified: [] }, foundation),
    /cryptographically verify signature and provenance/u,
  );
  const forged = auditEvidence(foundation, {
    ...artifactProvenance(foundation), subjectName: "pkg:npm/forged@1.0.0",
  });
  assert.throws(
    () => verifiedProvenanceFromNpmAudit(forged, foundation, source),
    /not bound/u,
  );
});

test("parses only one exact npm SLSA source dependency", () => {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicate: { buildDefinition: {
      externalParameters: { workflow: {
        path: source.workflow, ref: source.ref, repository: source.repository,
      } },
      resolvedDependencies: [{
        digest: { gitCommit: source.commit },
        uri: `git+${source.repository}@${source.ref}`,
      }],
    } },
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ digest: { sha512: "ab".repeat(64) }, name: "package" }],
  };
  assert.equal(provenanceFrom(statement).commit, source.commit);
  assert.equal(provenanceFrom(statement).dependencyUri, `git+${source.repository}@${source.ref}`);
  assert.equal(provenanceFrom({ ...statement, _type: "forged" }), undefined);
  assert.equal(provenanceFrom({
    ...statement,
    predicate: { buildDefinition: {
      ...statement.predicate.buildDefinition,
      resolvedDependencies: [
        ...statement.predicate.buildDefinition.resolvedDependencies,
        { digest: { gitCommit: "b".repeat(40) }, uri: "git+https://example.test/extra" },
      ],
    } },
  }), undefined);
});

test("uses only OIDC-capable direct npm publish with the final tag", () => {
  const releaseArtifact = {
    ...foundation,
    archivePath: "/tmp/foundation.tgz",
    registry: "https://registry.npmjs.org/",
  };
  assert.deepEqual(npmPublishArguments(releaseArtifact, "rc"), [
    "publish", releaseArtifact.archivePath, "--access", "public", "--tag", "rc",
    "--provenance", "--ignore-scripts", "--registry=https://registry.npmjs.org/",
  ]);
  assert.equal(npmPublishArguments(releaseArtifact, "rc").includes("dist-tag"), false);
  assert.deepEqual(npmSignatureInstallArguments(releaseArtifact), [
    "install", "--ignore-scripts", "--no-audit", "--fund=false", "--save-exact",
    "--registry=https://registry.npmjs.org/", `${FOUNDATION_PACKAGE}@${foundation.version}`,
  ]);
});

test("ordered publisher contains no npm dist-tag command path", async () => {
  const sources = await Promise.all([
    readFile(new URL("../scripts/release-publish-ordered.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/release-publish-ordered-runtime.mjs", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
  ]);
  for (const sourceText of sources) {
    assert.doesNotMatch(sourceText, /["']dist-tag["']/u);
    assert.doesNotMatch(sourceText, /["'](?:add|rm)["'].*dist-tag/su);
    assert.doesNotMatch(sourceText, /NPM_TOKEN|NODE_AUTH_TOKEN/u);
  }
});

test("current release runbook is OIDC-only and contains no retired bootstrap credentials", async () => {
  const releaseDocs = await readFile(new URL("../docs/release.md", import.meta.url), "utf8");
  assert.match(releaseDocs, /All current Foundation and Docs Protocol releases use npm Trusted Publishing/u);
  assert.doesNotMatch(releaseDocs, /2FA|OTP|granular read\/write token|npm login|NPM_TOKEN/iu);
});

test("resumes a Foundation-only prior publish without republishing it", async () => {
  const runtime = harness({
    [FOUNDATION_PACKAGE]: present(foundation, "2026-01-01T00:00:00.000Z"),
  });
  const released = await run(runtime);
  assert.equal(runtime.calls.some((entry) => entry.startsWith(`publish:${FOUNDATION_PACKAGE}`)), false);
  assert.equal(runtime.calls.some((entry) => entry.startsWith(`publish:${DOCS_PACKAGE}`)), true);
  assert.match(changesetsReleaseOutput(released), new RegExp(`New tag: ${FOUNDATION_PACKAGE}`, "u"));
});

test("later unrelated main cannot complete an ancestor Foundation-only pair", async () => {
  const runtime = harness({
    [FOUNDATION_PACKAGE]: present(foundation, "2026-01-01T00:00:00.000Z"),
  });
  const laterSource = {
    ...source,
    commit: "b".repeat(40),
    isTrustedCommit: async (commit) => commit === source.commit,
  };
  await assert.rejects(
    run(runtime, { source: laterSource }),
    /Foundation provenance-owning commit/u,
  );
  assert.equal(runtime.calls.some((entry) => entry.startsWith("publish:")), false);
  assert.equal(runtime.calls.some((entry) => entry.startsWith("authorize:")), false);
});

test("Docs-only ancestor state is quarantined before any Foundation npm write", async () => {
  const runtime = harness({
    [DOCS_PACKAGE]: present(docs, "2026-01-01T00:00:01.000Z"),
  });
  const laterSource = {
    ...source,
    commit: "b".repeat(40),
    isTrustedCommit: async (commit) => commit === source.commit,
  };
  await assert.rejects(run(runtime, { source: laterSource }), /quarantine before releasing/u);
  assert.deepEqual(runtime.calls, [
    `inspect:${FOUNDATION_PACKAGE}`,
    `inspect:${DOCS_PACKAGE}`,
  ]);
});

test("fails when raw registry provenance disagrees with the verified npm audit bundle", async () => {
  const runtime = harness({
    [FOUNDATION_PACKAGE]: present(foundation, "2026-01-01T00:00:00.000Z"),
  });
  const currentCommit = "b".repeat(40);
  runtime.verifySignature = async (value) => artifactProvenance(value, currentCommit);
  await assert.rejects(
    run(runtime, { source: {
      ...source,
      commit: currentCommit,
      isTrustedCommit: async (commit) => [source.commit, currentCommit].includes(commit),
    } }),
    /raw registry provenance disagrees/u,
  );
  assert.equal(runtime.calls.some((entry) => entry.startsWith("publish:")), false);
});

test("reconciles an unknown npm publish response only after exact registry evidence appears", async () => {
  const runtime = harness();
  const originalPublish = runtime.publish;
  runtime.publish = async (value, tag) => {
    await originalPublish(value, tag);
    if (value.name === FOUNDATION_PACKAGE) {
      throw new Error("connection reset after upload");
    }
  };
  await run(runtime);
  assert.equal(runtime.calls.some((entry) => entry.startsWith(`publish:${DOCS_PACKAGE}`)), true);
});

test("Foundation signature failure prevents Docs publication", async () => {
  const runtime = harness();
  runtime.verifySignature = async (value) => {
    runtime.calls.push(`signature:${value.name}`);
    throw new Error("Foundation signature invalid");
  };
  await assert.rejects(run(runtime), /signature invalid/u);
  assert.equal(runtime.calls.some((entry) => entry.startsWith(`publish:${DOCS_PACKAGE}`)), false);
  assert.equal(runtime.calls.some((entry) => entry.startsWith("release:")), false);
});

test("Docs signature failure prevents GitHub release reconciliation and cohort-ready output", async () => {
  const runtime = harness();
  runtime.verifySignature = async (value) => {
    runtime.calls.push(`signature:${value.name}`);
    if (value.name === DOCS_PACKAGE) {
      throw new Error("Docs signature invalid");
    }
    return structuredClone(runtime.states.get(value.name).provenance);
  };
  await assert.rejects(run(runtime), /signature invalid/u);
  assert.equal(runtime.calls.some((entry) => entry.startsWith(`publish:${DOCS_PACKAGE}`)), true);
  assert.equal(runtime.calls.some((entry) => entry.startsWith("release:")), false);
});

for (const [drift, mutate, pattern] of [
  ["final tag", (state) => { state.distTags.latest = "9.9.9"; }, /not the exact latest/u],
  ["tarball SRI", (state) => { state.integrity = tarballIntegrity(Buffer.from("drift")); }, /different tarball SRI/u],
  ["provenance", (state) => { state.provenance.commit = "c".repeat(40); }, /provenance is absent/u],
]) {
  test(`post-signature snapshot rejects ${drift} drift before GitHub reconciliation`, async () => {
    const runtime = harness();
    runtime.verifySignature = async (value) => {
      runtime.calls.push(`signature:${value.name}`);
      const provenance = structuredClone(runtime.states.get(value.name).provenance);
      if (value.name === DOCS_PACKAGE) {
        mutate(runtime.states.get(FOUNDATION_PACKAGE));
      }
      return provenance;
    };
    await assert.rejects(run(runtime), pattern);
    assert.equal(runtime.calls.some((entry) => entry.startsWith("release:")), false);
  });
}

for (const reason of ["signature timeout", "signature result unknown"]) {
  test(`fails closed on ${reason}`, async () => {
    const runtime = harness();
    runtime.verifySignature = async () => {
      throw new Error(reason);
    };
    await assert.rejects(run(runtime), new RegExp(reason, "u"));
    assert.equal(runtime.calls.some((entry) => entry.startsWith(`publish:${DOCS_PACKAGE}`)), false);
  });
}

test("retries signature verification without republishing Foundation", async () => {
  const runtime = harness();
  let attempts = 0;
  runtime.verifySignature = async (value) => {
    runtime.calls.push(`signature:${value.name}`);
    attempts += 1;
    if (attempts === 1) {
      throw new Error("signature service timeout");
    }
    return structuredClone(runtime.states.get(value.name).provenance);
  };
  await assert.rejects(run(runtime), /signature service timeout/u);
  await run(runtime);
  assert.equal(
    runtime.calls.filter((entry) => entry.startsWith(`publish:${FOUNDATION_PACKAGE}`)).length,
    1,
  );
});

test("later unrelated main verifies a trusted ancestor release with zero writes and no action output", async () => {
  const foundationState = present(foundation, "2026-01-01T00:00:00.000Z");
  const docsState = present(docs, "2026-01-01T00:00:01.000Z");
  foundationState.distTags.latest = foundation.version;
  docsState.distTags.latest = docs.version;
  const runtime = harness({
    [DOCS_PACKAGE]: docsState,
    [FOUNDATION_PACKAGE]: foundationState,
  });
  const laterSource = {
    ...source,
    commit: "b".repeat(40),
    isTrustedCommit: async (commit) => commit === source.commit,
  };
  const released = await run(runtime, {
    source: laterSource,
  });
  assert.equal(changesetsReleaseOutput(released), "");
  assert.equal(runtime.calls.some((entry) => /^(?:publish|tag|untag):/u.test(entry)), false);
});

test("emits only the package released by the current commit when Foundation is an older ancestor", async () => {
  const foundationState = present(foundation, "2026-01-01T00:00:00.000Z");
  const docsState = present(docs, "2026-01-01T00:00:01.000Z");
  const currentCommit = "b".repeat(40);
  docsState.provenance.commit = currentCommit;
  foundationState.distTags.latest = foundation.version;
  docsState.distTags.latest = docs.version;
  const runtime = harness({
    [DOCS_PACKAGE]: docsState,
    [FOUNDATION_PACKAGE]: foundationState,
  });
  const mixedSource = {
    ...source,
    commit: currentCommit,
    isTrustedCommit: async (commit) => [source.commit, currentCommit].includes(commit),
  };
  const released = await run(runtime, {
    source: mixedSource,
  });
  assert.equal(changesetsReleaseOutput(released), `New tag: ${DOCS_PACKAGE}@${docs.version}\n`);
  assert.equal(runtime.calls.some((entry) => /^(?:publish|tag|untag):/u.test(entry)), false);
});

test("reconciles a partial GitHub release boundary exactly once per package", async () => {
  const runtime = harness();
  const created = new Set();
  const writes = [];
  let failDocs = true;
  runtime.reconcileRelease = async (value) => {
    if (created.has(value.name)) {
      return;
    }
    if (value.name === DOCS_PACKAGE && failDocs) {
      failDocs = false;
      throw new Error("GitHub release response lost");
    }
    created.add(value.name);
    writes.push(value.name);
  };
  await assert.rejects(run(runtime), /GitHub release response lost/u);
  await run(runtime);
  assert.deepEqual(writes, [FOUNDATION_PACKAGE, DOCS_PACKAGE]);
  assert.equal(runtime.calls.filter((entry) => entry.startsWith("publish:")).length, 2);
});

test("production GitHub reconciliation repairs a lost release response idempotently", async () => {
  const repository = "agent-teams-ai/engineering-foundation";
  const releaseArtifact = { ...foundation, releaseNotes: "Exact release notes" };
  const tag = `${releaseArtifact.name}@${releaseArtifact.version}`;
  let ref;
  let release;
  let loseFirstReleaseResponse = true;
  const writes = [];
  const request = (args) => {
    const route = args[0] === "--method" ? args[2] : args[0];
    if (route.includes("/git/ref/tags/")) {
      return ref;
    }
    if (route.endsWith("/git/refs")) {
      ref = { object: { sha: argumentField(args, "sha="), type: "commit" } };
      writes.push("tag");
      return ref;
    }
    if (route.includes("/releases/tags/")) {
      return release;
    }
    if (route.endsWith("/releases")) {
      release = {
        body: argumentField(args, "body="),
        draft: argumentField(args, "draft=") === "true",
        name: argumentField(args, "name="),
        prerelease: argumentField(args, "prerelease=") === "true",
        tag_name: argumentField(args, "tag_name="),
      };
      writes.push("release");
      if (loseFirstReleaseResponse) {
        loseFirstReleaseResponse = false;
        throw new Error("GitHub response lost");
      }
      return release;
    }
    throw new Error(`Unexpected fake GitHub route: ${route}`);
  };
  await assert.rejects(
    reconcileGithubRelease(releaseArtifact, source.commit, { repository, request }),
    /response lost/u,
  );
  await reconcileGithubRelease(releaseArtifact, source.commit, { repository, request });
  await reconcileGithubRelease(releaseArtifact, source.commit, { repository, request });
  assert.deepEqual(writes, ["tag", "release"]);
  assert.equal(release.tag_name, tag);
  release.draft = true;
  await assert.rejects(
    reconcileGithubRelease(releaseArtifact, source.commit, { repository, request }),
    /differs from the reviewed changelog evidence/u,
  );
});

for (const [name, state] of [
  ["timeout", () => { throw new Error("timeout"); }],
  ["5xx", { error: new Error("registry returned 503"), status: "unknown" }],
  ["unknown shape", { status: "indeterminate" }],
]) {
  test(`fails closed before publish on ${name}`, async () => {
    const runtime = harness({ [FOUNDATION_PACKAGE]: state });
    await assert.rejects(run(runtime), /unknown|invalid state/iu);
    assert.equal(runtime.calls.some((entry) => entry.startsWith("publish:")), false);
  });
}

test("does not guess after persistent 404 following publish", async () => {
  const runtime = harness();
  runtime.publish = async (value, tag) => {
    runtime.calls.push(`publish:${value.name}:${tag}`);
  };
  await assert.rejects(run(runtime), /remained absent/iu);
  assert.equal(runtime.calls.some((entry) => entry.startsWith(`publish:${DOCS_PACKAGE}`)), false);
});

test("rejects immutable-version mismatch and requires quarantine/new version", async () => {
  const mismatch = present(foundation, "2026-01-01T00:00:00.000Z");
  mismatch.integrity = tarballIntegrity(Buffer.from("different"));
  const runtime = harness({ [FOUNDATION_PACKAGE]: mismatch });
  await assert.rejects(run(runtime), /different tarball SRI.*quarantine.*new version/iu);
  assert.equal(runtime.calls.some((entry) => entry.startsWith("publish:")), false);
});

test("rejects Docs published before Foundation without reconciling GitHub releases", async () => {
  const runtime = harness({
    [DOCS_PACKAGE]: present(docs, "2026-01-01T00:00:00.000Z"),
    [FOUNDATION_PACKAGE]: present(foundation, "2026-01-01T00:00:01.000Z"),
  });
  await assert.rejects(run(runtime), /Docs Protocol was published before/iu);
  assert.equal(runtime.calls.some((entry) => entry.startsWith("release:")), false);
});

test("refuses an existing immutable version when the final tag no longer targets it", async () => {
  const foundationState = present(foundation, "2026-01-01T00:00:00.000Z");
  foundationState.distTags.latest = "9.9.9";
  const runtime = harness({ [FOUNDATION_PACKAGE]: foundationState });
  await assert.rejects(run(runtime), /not the exact latest dist-tag target/u);
  assert.equal(runtime.calls.some((entry) => entry.startsWith("publish:")), false);
});

test("rejects local and published Docs manifests without the exact Foundation dependency", async () => {
  const badDocs = artifact(DOCS_PACKAGE, docs.version, { [FOUNDATION_PACKAGE]: "^1.2.3" });
  await assert.rejects(run(harness(), { artifacts: [foundation, badDocs] }), /exact Foundation/iu);

  const publishedDocs = present(docs, "2026-01-01T00:00:01.000Z");
  publishedDocs.manifest.dependencies[FOUNDATION_PACKAGE] = "^1.2.3";
  const runtime = harness({
    [DOCS_PACKAGE]: publishedDocs,
    [FOUNDATION_PACKAGE]: present(foundation, "2026-01-01T00:00:00.000Z"),
  });
  await assert.rejects(run(runtime), /different packed manifest/iu);
});
