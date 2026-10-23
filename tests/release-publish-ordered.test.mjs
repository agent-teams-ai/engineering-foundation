import {
  registerSignatureAndRetryCases,
  registerRegistryBoundaryCases,
} from "./support/release-ordered-reconciliation-cases.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DOCUMENT_AUTHORING_PACKAGE,
  DOCS_PACKAGE,
  DOCS_MCP_PACKAGE,
  FOUNDATION_PACKAGE,
  REGISTRY_OBSERVATION_ATTEMPTS,
  REGISTRY_OBSERVATION_RETRY_MILLISECONDS,
  REGISTRY_VISIBILITY_TIMEOUT_MILLISECONDS,
  tarballIntegrity,
} from "../scripts/release-publish-ordered.mjs";
import {
  assertDownloadedTarballIntegrity,
  assertLiveMainHead,
  assertNpmSignatureEvidence,
  changesetsReleaseOutput,
  GITHUB_RECONCILIATION_ATTEMPTS,
  GITHUB_RECONCILIATION_RETRY_MILLISECONDS,
  npmPublishArguments,
  npmSignatureInstallArguments,
  provenanceFrom,
  verifiedProvenanceFromNpmAudit,
} from "../scripts/release-publish-ordered-runtime.mjs";

import {
  STACK_TOOLCHAIN_PACKAGE,
  stackToolchain,
  source,
  MUTATION_PACKAGE,
  DOCS_ADAPTER_PACKAGE,
  CI_INPUT_PROOF_PACKAGE,
  ciInputProof,
  FEATURE_MODULE_STANDARD_PACKAGE,
  featureModuleStandard,
  mutation,
  authoring,
  foundation,
  docs,
  docsAdapter,
  docsMcp,
  artifactProvenance,
  auditEvidence,
  present,
  publishedState,
  harness,
  run,
} from "./support/release-publish-ordered-fixtures.mjs";

test("allows bounded npm provenance propagation without a failed publish attempt", () => {
  assert.equal(
    (REGISTRY_OBSERVATION_ATTEMPTS - 1) * REGISTRY_OBSERVATION_RETRY_MILLISECONDS,
    360_000,
  );
});

test("bounds idempotent GitHub release reconciliation during transient outages", () => {
  assert.equal(
    (GITHUB_RECONCILIATION_ATTEMPTS - 1) * GITHUB_RECONCILIATION_RETRY_MILLISECONDS,
    180_000,
  );
});

test("accepts delayed visibility beyond six minutes with one publish and unchanged downstream gates", async () => {
  let elapsed = 0;
  const runtime = harness(
    publishedState(
      stackToolchain,
      mutation,
      authoring,
      docs,
      docsAdapter,
      docsMcp,
      foundation,
      featureModuleStandard,
    ),
  );
  const snapshot = publishedState(ciInputProof)[ciInputProof.name];
  const publish = runtime.publish;
  runtime.publish = async (value, tag) => {
    await publish(value, tag);
    runtime.states.set(value.name, () => (elapsed < 7 * 60_000 ? { status: "absent" } : snapshot));
  };
  const progress = [];
  await run(runtime, {
    visibilityTimeoutMilliseconds: undefined,
    retryDelayMilliseconds: 60_000,
    now: () => elapsed,
    wait: async (milliseconds) => {
      elapsed += milliseconds;
    },
    reportProgress: (record) => progress.push(record),
  });
  assert.equal(runtime.calls.filter((call) => call.startsWith("publish:")).length, 1);
  assert.equal(runtime.calls.filter((call) => call.startsWith("signature:")).length, 9);
  assert.equal(runtime.calls.filter((call) => call.startsWith("release:")).length, 9);
  assert.ok(elapsed > 360_000 && elapsed < REGISTRY_VISIBILITY_TIMEOUT_MILLISECONDS);
  assert.ok(
    progress.some((record) => record.stage === "npm-publish" && record.status === "acknowledged"),
  );
  assert.ok(
    progress.some((record) => record.stage === "visibility" && record.status === "verified"),
  );
});

for (const returnedAt of [10, 11]) {
  test(`rejects a present reply returned at elapsed ${returnedAt} with deadline 10`, async () => {
    let elapsed = 0;
    const runtime = harness();
    const inspect = runtime.inspect;
    const budgets = [];
    runtime.inspect = async (value, budget) => {
      if (budget !== undefined) {
        budgets.push(budget.remainingMilliseconds);
        if (budgets.length === 1) {
          return { status: "absent" };
        }
        elapsed = returnedAt;
        return publishedState(value)[value.name];
      }
      return inspect(value);
    };
    await assert.rejects(
      run(runtime, {
        visibilityTimeoutMilliseconds: 10,
        retryDelayMilliseconds: 9,
        now: () => elapsed,
        wait: async (milliseconds) => {
          elapsed += milliseconds;
        },
      }),
      /visibility deadline exceeded/u,
    );
    assert.deepEqual(budgets, [10, 1]);
    assert.equal(runtime.calls.filter((call) => call.startsWith("publish:")).length, 1);
    assert.equal(
      runtime.calls.some((call) => /^(signature|release):/u.test(call)),
      false,
    );
  });
}

test("rejects source validation finishing at the strict visibility deadline", async () => {
  let elapsed = 0;
  const runtime = harness();
  const publish = runtime.publish;
  let invoked = false;
  runtime.publish = async (value, tag) => {
    await publish(value, tag);
    invoked = true;
  };
  const timedSource = {
    ...source,
    isTrustedCommit: async (commit) => {
      if (invoked) {
        elapsed = 10;
      }
      return source.isTrustedCommit(commit);
    },
  };
  await assert.rejects(
    run(runtime, { source: timedSource, visibilityTimeoutMilliseconds: 10, now: () => elapsed }),
    /visibility deadline exceeded/u,
  );
  assert.equal(runtime.calls.filter((call) => call.startsWith("publish:")).length, 1);
  assert.equal(
    runtime.calls.some((call) => /^(signature|release):/u.test(call)),
    false,
  );
});

test("persistent unknown visibility expires without another write or provider text in diagnostics", async () => {
  const runtime = harness();
  const inspect = runtime.inspect;
  runtime.inspect = async (value, budget) =>
    budget === undefined
      ? inspect(value)
      : {
          status: "unknown",
          stage: "credential-secret",
          error: new Error("Bearer credential-secret"),
        };
  const records = [];
  await assert.rejects(
    run(runtime, { reportProgress: (record) => records.push(record) }),
    (error) =>
      /remained unknown; visibility deadline exceeded/u.test(error.message) &&
      !error.message.includes("credential-secret"),
  );
  assert.equal(runtime.calls.filter((call) => call.startsWith("publish:")).length, 1);
  assert.equal(
    runtime.calls.some((call) => /^(signature|release):/u.test(call)),
    false,
  );
  assert.doesNotMatch(JSON.stringify(records), /credential-secret|Bearer/u);
});

test("rejects a conflicting visible artifact before waiting or downstream writes", async () => {
  const runtime = harness();
  const publish = runtime.publish;
  runtime.publish = async (value, tag) => {
    await publish(value, tag);
    runtime.states.get(value.name).integrity = tarballIntegrity(Buffer.from("conflict"));
  };
  await assert.rejects(
    run(runtime, { wait: async () => assert.fail("must reject without waiting") }),
    /different tarball SRI/u,
  );
  assert.equal(runtime.calls.filter((call) => call.startsWith("publish:")).length, 1);
  assert.equal(
    runtime.calls.some((call) => /^(signature|release):/u.test(call)),
    false,
  );
});

test("a long visibility wait never authorizes a downstream write after main advances", async () => {
  let elapsed = 0;
  let advanced = false;
  const runtime = harness();
  const publish = runtime.publish;
  runtime.publish = async (value, tag) => {
    await publish(value, tag);
    const snapshot = runtime.states.get(value.name);
    runtime.states.set(value.name, () => (elapsed < 7 * 60_000 ? { status: "absent" } : snapshot));
  };
  const signature = runtime.verifySignature;
  runtime.verifySignature = async (value) => {
    const result = await signature(value);
    advanced = true;
    return result;
  };
  runtime.authorizePublish = () => {
    if (advanced) {
      throw new Error("protected main advanced");
    }
  };
  await assert.rejects(
    run(runtime, {
      visibilityTimeoutMilliseconds: undefined,
      retryDelayMilliseconds: 60_000,
      now: () => elapsed,
      wait: async (milliseconds) => {
        elapsed += milliseconds;
      },
    }),
    /protected main advanced/u,
  );
  assert.equal(runtime.calls.filter((call) => call.startsWith("publish:")).length, 1);
  assert.equal(
    runtime.calls.some((call) => call.startsWith("release:")),
    false,
  );
});

test("publishes the exact derived nine-package dependency graph in order", async () => {
  const runtime = harness();
  await run(runtime);
  const ciInputProofPublish = runtime.calls.indexOf(`publish:${CI_INPUT_PROOF_PACKAGE}:latest`);
  const ciInputProofSignature = runtime.calls.indexOf(`signature:${CI_INPUT_PROOF_PACKAGE}`);
  const standardPublish = runtime.calls.indexOf(
    `publish:${FEATURE_MODULE_STANDARD_PACKAGE}:latest`,
  );
  const standardSignature = runtime.calls.indexOf(`signature:${FEATURE_MODULE_STANDARD_PACKAGE}`);
  const mutationPublish = runtime.calls.indexOf(`publish:${MUTATION_PACKAGE}:latest`);
  const mutationSignature = runtime.calls.indexOf(`signature:${MUTATION_PACKAGE}`);
  const authoringPublish = runtime.calls.indexOf(`publish:${DOCUMENT_AUTHORING_PACKAGE}:latest`);
  const authoringSignature = runtime.calls.indexOf(`signature:${DOCUMENT_AUTHORING_PACKAGE}`);
  const foundationPublish = runtime.calls.indexOf(`publish:${FOUNDATION_PACKAGE}:latest`);
  const foundationSignature = runtime.calls.indexOf(`signature:${FOUNDATION_PACKAGE}`);
  const docsPublish = runtime.calls.indexOf(`publish:${DOCS_PACKAGE}:latest`);
  const docsSignature = runtime.calls.indexOf(`signature:${DOCS_PACKAGE}`);
  const adapterPublish = runtime.calls.indexOf(`publish:${DOCS_ADAPTER_PACKAGE}:latest`);
  const adapterSignature = runtime.calls.indexOf(`signature:${DOCS_ADAPTER_PACKAGE}`);
  const mcpPublish = runtime.calls.indexOf(`publish:${DOCS_MCP_PACKAGE}:latest`);
  const mcpSignature = runtime.calls.indexOf(`signature:${DOCS_MCP_PACKAGE}`);
  const firstRelease = runtime.calls.indexOf(`release:${FOUNDATION_PACKAGE}`);
  const foundationFinalInspect = runtime.calls.lastIndexOf(`inspect:${FOUNDATION_PACKAGE}`);
  const docsFinalInspect = runtime.calls.lastIndexOf(`inspect:${DOCS_PACKAGE}`);
  assert.deepEqual(
    runtime.calls.filter((entry) => entry.startsWith("publish:")),
    [
      CI_INPUT_PROOF_PACKAGE,
      MUTATION_PACKAGE,
      DOCUMENT_AUTHORING_PACKAGE,
      DOCS_PACKAGE,
      DOCS_ADAPTER_PACKAGE,
      DOCS_MCP_PACKAGE,
      FOUNDATION_PACKAGE,
      FEATURE_MODULE_STANDARD_PACKAGE,
      STACK_TOOLCHAIN_PACKAGE,
    ].map((name) => `publish:${name}:latest`),
  );
  assert.ok(ciInputProofPublish >= 0 && ciInputProofPublish < ciInputProofSignature);
  assert.ok(ciInputProofSignature < mutationPublish);
  assert.ok(foundationSignature < standardPublish && standardPublish < standardSignature);
  assert.ok(mutationPublish >= 0 && mutationPublish < mutationSignature);
  assert.ok(mutationSignature < authoringPublish && authoringPublish < authoringSignature);
  assert.ok(authoringSignature < foundationPublish && foundationPublish < foundationSignature);
  assert.ok(authoringSignature < docsPublish);
  assert.ok(docsPublish < docsSignature);
  assert.ok(docsSignature < adapterPublish && adapterPublish < adapterSignature);
  assert.ok(adapterSignature < mcpPublish && mcpPublish < mcpSignature);
  assert.ok(docsSignature < docsFinalInspect && docsFinalInspect < foundationFinalInspect);
  assert.ok(foundationFinalInspect < firstRelease);
  assert.equal(
    runtime.calls.some((entry) => /^(?:tag|untag):/u.test(entry)),
    false,
  );
});

test("publishes an RC wave directly on rc without moving latest", async () => {
  const runtime = harness();
  await run(runtime, { finalTag: "rc" });
  assert.equal(runtime.states.get(CI_INPUT_PROOF_PACKAGE).distTags.rc, ciInputProof.version);
  assert.equal(
    runtime.states.get(FEATURE_MODULE_STANDARD_PACKAGE).distTags.rc,
    featureModuleStandard.version,
  );
  assert.equal(runtime.states.get(MUTATION_PACKAGE).distTags.rc, mutation.version);
  assert.equal(runtime.states.get(DOCUMENT_AUTHORING_PACKAGE).distTags.rc, authoring.version);
  assert.equal(runtime.states.get(FOUNDATION_PACKAGE).distTags.rc, foundation.version);
  assert.equal(runtime.states.get(DOCS_PACKAGE).distTags.rc, docs.version);
  assert.equal(runtime.states.get(DOCS_ADAPTER_PACKAGE).distTags.rc, docsAdapter.version);
  assert.equal(runtime.states.get(DOCS_MCP_PACKAGE).distTags.rc, docsMcp.version);
  assert.equal(runtime.states.get(CI_INPUT_PROOF_PACKAGE).distTags.latest, undefined);
  assert.equal(runtime.states.get(FEATURE_MODULE_STANDARD_PACKAGE).distTags.latest, undefined);
  assert.equal(runtime.states.get(MUTATION_PACKAGE).distTags.latest, undefined);
  assert.equal(runtime.states.get(DOCUMENT_AUTHORING_PACKAGE).distTags.latest, undefined);
  assert.equal(runtime.states.get(FOUNDATION_PACKAGE).distTags.latest, undefined);
  assert.equal(runtime.states.get(DOCS_PACKAGE).distTags.latest, undefined);
  assert.equal(runtime.states.get(DOCS_ADAPTER_PACKAGE).distTags.latest, undefined);
  assert.equal(runtime.states.get(DOCS_MCP_PACKAGE).distTags.latest, undefined);
});

test("refuses every non-governed npm tag before publication", async () => {
  const runtime = harness();
  await assert.rejects(run(runtime, { finalTag: "beta" }), /exactly latest or rc/u);
  assert.equal(
    runtime.calls.some((entry) => entry.startsWith("publish:")),
    false,
  );
});

test("refuses the first npm write when protected main advanced during qualification", async () => {
  const runtime = harness();
  runtime.authorizePublish = () => {
    throw new Error("protected main advanced");
  };
  await assert.rejects(run(runtime), /protected main advanced/u);
  assert.equal(
    runtime.calls.some((entry) => entry.startsWith("publish:")),
    false,
  );
});

test("refuses downstream publication when protected main advances after Document Authoring", async () => {
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
    if (value.name === DOCUMENT_AUTHORING_PACKAGE) {
      liveMain = "b".repeat(40);
    }
    return provenance;
  };
  await assert.rejects(run(runtime), /protected main advanced/u);
  assert.equal(
    runtime.calls.some((entry) => entry.startsWith(`publish:${DOCUMENT_AUTHORING_PACKAGE}`)),
    true,
  );
  assert.equal(
    runtime.calls.some((entry) => entry.startsWith(`publish:${FOUNDATION_PACKAGE}`)),
    false,
  );
  assert.equal(
    runtime.calls.some((entry) => entry.startsWith(`publish:${DOCS_PACKAGE}`)),
    false,
  );
});

function exactMain() {
  return { object: { sha: source.commit, type: "commit" }, ref: "refs/heads/main" };
}

test("live-main verifier accepts only the exact protected-main commit", () => {
  assert.doesNotThrow(() =>
    assertLiveMainHead("agent-teams-ai/engineering-foundation", source.commit, exactMain),
  );
  assert.throws(
    () =>
      assertLiveMainHead("agent-teams-ai/engineering-foundation", source.commit, () => ({
        object: { sha: "b".repeat(40), type: "commit" },
        ref: "refs/heads/main",
      })),
    /protected main advanced/u,
  );
});

test("emits the exact deterministic lines parsed by the pinned Changesets action", () => {
  const output = changesetsReleaseOutput({
    artifacts: [
      { ...foundation, emitReleaseLine: true },
      { ...docs, emitReleaseLine: true },
      { ...docsMcp, emitReleaseLine: true },
    ],
    emitReleaseLines: true,
  });
  assert.equal(
    output,
    `New tag: ${FOUNDATION_PACKAGE}@${foundation.version}\n` +
      `New tag: ${DOCS_PACKAGE}@${docs.version}\n` +
      `New tag: ${DOCS_MCP_PACKAGE}@${docsMcp.version}\n`,
  );
  const pinnedChangesetsActionPattern = /New tag:\s+(@[^/]+\/[^@]+|[^/]+)@([^\s]+)/gu;
  assert.deepEqual(
    [...output.matchAll(pinnedChangesetsActionPattern)].map((match) => ({
      name: match[1],
      version: match[2],
    })),
    [
      { name: FOUNDATION_PACKAGE, version: foundation.version },
      { name: DOCS_PACKAGE, version: docs.version },
      { name: DOCS_MCP_PACKAGE, version: docsMcp.version },
    ],
  );
});

test("rejects downloaded tarball bytes that do not match registry SRI", () => {
  const bytes = Buffer.from("downloaded tarball");
  assert.doesNotThrow(() =>
    assertDownloadedTarballIntegrity(bytes, tarballIntegrity(bytes), FOUNDATION_PACKAGE),
  );
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
    ...artifactProvenance(foundation),
    subjectName: "pkg:npm/forged@1.0.0",
  });
  assert.throws(() => verifiedProvenanceFromNpmAudit(forged, foundation, source), /not bound/u);
});

test("parses only one exact npm SLSA source dependency", () => {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            path: source.workflow,
            ref: source.ref,
            repository: source.repository,
          },
        },
        resolvedDependencies: [
          {
            digest: { gitCommit: source.commit },
            uri: `git+${source.repository}@${source.ref}`,
          },
        ],
      },
    },
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ digest: { sha512: "ab".repeat(64) }, name: "package" }],
  };
  assert.equal(provenanceFrom(statement).commit, source.commit);
  assert.equal(provenanceFrom(statement).dependencyUri, `git+${source.repository}@${source.ref}`);
  assert.equal(provenanceFrom({ ...statement, _type: "forged" }), undefined);
  assert.equal(
    provenanceFrom({
      ...statement,
      predicate: {
        buildDefinition: {
          ...statement.predicate.buildDefinition,
          resolvedDependencies: [
            ...statement.predicate.buildDefinition.resolvedDependencies,
            { digest: { gitCommit: "b".repeat(40) }, uri: "git+https://example.test/extra" },
          ],
        },
      },
    }),
    undefined,
  );
});

test("uses only OIDC-capable direct npm publish with the final tag", () => {
  const releaseArtifact = {
    ...foundation,
    archivePath: "/tmp/foundation.tgz",
    registry: "https://registry.npmjs.org/",
  };
  assert.deepEqual(npmPublishArguments(releaseArtifact, "rc"), [
    "publish",
    releaseArtifact.archivePath,
    "--access",
    "public",
    "--tag",
    "rc",
    "--provenance",
    "--ignore-scripts",
    "--registry=https://registry.npmjs.org/",
  ]);
  assert.equal(npmPublishArguments(releaseArtifact, "rc").includes("dist-tag"), false);
  assert.deepEqual(npmSignatureInstallArguments(releaseArtifact), [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--fund=false",
    "--save-exact",
    "--registry=https://registry.npmjs.org/",
    `${FOUNDATION_PACKAGE}@${foundation.version}`,
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

test("current runbook isolates the one-time token bootstrap from ordinary OIDC releases", async () => {
  const releaseDocs = await readFile(new URL("../docs/release.md", import.meta.url), "utf8");
  assert.match(
    releaseDocs,
    /All ordinary releases of packages in the reviewed public-package catalog use\s+npm Trusted Publishing/u,
  );
  assert.match(
    releaseDocs,
    /sole exception is the reviewed one-time\s+namespace bootstrap in ADR-0044/u,
  );
  assert.match(releaseDocs, /expires within 24 hours/u);
  assert.match(releaseDocs, /fresh token for each package/u);
  assert.match(releaseDocs, /revoke its one-package token immediately/u);
  assert.match(releaseDocs, /never creates,\s+removes, or moves either tag explicitly/u);
  assert.match(
    releaseDocs,
    /final required phase resolves the canonical public Docs Protocol coordinates/u,
  );
  assert.match(
    releaseDocs,
    /derives the\s+publication order by topologically sorting the exact internal dependencies/u,
  );
  assert.match(
    releaseDocs,
    /closed\s+package DAG owned solely by `scripts\/publishable-packages\.mjs`/u,
  );
  assert.doesNotMatch(releaseDocs, /five-package dependency DAG/u);
  assert.match(releaseDocs, /missing dependency-closed set in\s+reviewed topological order/u);
  assert.match(
    releaseDocs,
    /published package whose required\s+upstream dependency is missing is quarantined/u,
  );
  assert.doesNotMatch(releaseDocs, /long-lived npm credentials|npm login|NPM_TOKEN/iu);
});

test("resumes a Foundation-only prior publish without republishing it", async () => {
  const runtime = harness(
    publishedState(
      stackToolchain,
      ciInputProof,
      featureModuleStandard,
      mutation,
      authoring,
      foundation,
    ),
  );
  const released = await run(runtime);
  assert.equal(
    runtime.calls.some((entry) => entry.startsWith(`publish:${FOUNDATION_PACKAGE}`)),
    false,
  );
  assert.equal(
    runtime.calls.some((entry) => entry.startsWith(`publish:${DOCS_PACKAGE}`)),
    true,
  );
  assert.match(
    changesetsReleaseOutput(released),
    new RegExp(`New tag: ${FOUNDATION_PACKAGE}`, "u"),
  );
});

test("later protected main may publish missing Docs against a verified reusable Foundation", async () => {
  const runtime = harness(
    publishedState(
      stackToolchain,
      ciInputProof,
      featureModuleStandard,
      mutation,
      authoring,
      foundation,
    ),
  );
  const currentCommit = "b".repeat(40);
  const laterSource = {
    ...source,
    commit: currentCommit,
    isTrustedCommit: async (commit) => [source.commit, currentCommit].includes(commit),
  };
  runtime.publish = async (value, tag) => {
    runtime.calls.push(`publish:${value.name}:${tag}`);
    const published = present(value, "2026-01-01T00:00:01.000Z", tag);
    published.provenance = artifactProvenance(value, currentCommit);
    runtime.states.set(value.name, published);
  };

  const released = await run(runtime, { source: laterSource });

  assert.equal(
    runtime.calls.some((entry) => entry.startsWith(`publish:${FOUNDATION_PACKAGE}`)),
    false,
  );
  assert.equal(
    runtime.calls.some((entry) => entry.startsWith(`publish:${DOCS_PACKAGE}:latest`)),
    true,
  );
  assert.equal(
    changesetsReleaseOutput(released),
    `New tag: ${DOCS_PACKAGE}@${docs.version}\n` +
      `New tag: ${DOCS_ADAPTER_PACKAGE}@${docsAdapter.version}\n` +
      `New tag: ${DOCS_MCP_PACKAGE}@${docsMcp.version}\n`,
  );
});

test("reused Foundation cannot publish missing Docs after protected main advances", async () => {
  const runtime = harness(
    publishedState(
      stackToolchain,
      ciInputProof,
      featureModuleStandard,
      mutation,
      authoring,
      foundation,
    ),
  );
  const currentCommit = "b".repeat(40);
  runtime.authorizePublish = () => {
    throw new Error("protected main advanced");
  };

  await assert.rejects(
    run(runtime, {
      source: {
        ...source,
        commit: currentCommit,
        isTrustedCommit: async (commit) => [source.commit, currentCommit].includes(commit),
      },
    }),
    /protected main advanced/u,
  );
  assert.equal(
    runtime.calls.some((entry) => entry.startsWith("publish:")),
    false,
  );
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
    `inspect:${CI_INPUT_PROOF_PACKAGE}`,
    `inspect:${MUTATION_PACKAGE}`,
    `inspect:${DOCUMENT_AUTHORING_PACKAGE}`,
    `inspect:${DOCS_PACKAGE}`,
    `inspect:${DOCS_ADAPTER_PACKAGE}`,
    `inspect:${DOCS_MCP_PACKAGE}`,
    `inspect:${FOUNDATION_PACKAGE}`,
    `inspect:${FEATURE_MODULE_STANDARD_PACKAGE}`,
    `inspect:${STACK_TOOLCHAIN_PACKAGE}`,
  ]);
});

test("fails when raw registry provenance disagrees with the verified npm audit bundle", async () => {
  const runtime = harness(
    publishedState(
      stackToolchain,
      ciInputProof,
      featureModuleStandard,
      mutation,
      authoring,
      foundation,
    ),
  );
  const currentCommit = "b".repeat(40);
  runtime.verifySignature = async (value) => artifactProvenance(value, currentCommit);
  await assert.rejects(
    run(runtime, {
      source: {
        ...source,
        commit: currentCommit,
        isTrustedCommit: async (commit) => [source.commit, currentCommit].includes(commit),
      },
    }),
    /raw registry provenance disagrees/u,
  );
  assert.equal(
    runtime.calls.some((entry) => entry.startsWith("publish:")),
    false,
  );
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
  assert.equal(
    runtime.calls.some((entry) => entry.startsWith(`publish:${DOCS_PACKAGE}`)),
    true,
  );
});

test("CI Input Proof signature failure prevents downstream publication", async () => {
  const runtime = harness();
  runtime.verifySignature = async (value) => {
    runtime.calls.push(`signature:${value.name}`);
    assert.equal(value.name, CI_INPUT_PROOF_PACKAGE);
    throw new Error("CI Input Proof signature invalid");
  };
  await assert.rejects(run(runtime), /signature invalid/u);
  assert.equal(
    runtime.calls.some((entry) => entry.startsWith(`publish:${CI_INPUT_PROOF_PACKAGE}`)),
    true,
  );
  assert.equal(
    runtime.calls.some((entry) => entry.startsWith(`publish:${FEATURE_MODULE_STANDARD_PACKAGE}`)),
    false,
  );
  assert.equal(
    runtime.calls.some((entry) => entry.startsWith(`publish:${MUTATION_PACKAGE}`)),
    false,
  );
  assert.equal(
    runtime.calls.some((entry) => entry.startsWith(`publish:${DOCS_PACKAGE}`)),
    false,
  );
  assert.equal(
    runtime.calls.some((entry) => entry.startsWith("release:")),
    false,
  );
});

registerSignatureAndRetryCases();
registerRegistryBoundaryCases();
