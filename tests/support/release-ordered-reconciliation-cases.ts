import assert from "node:assert/strict";
import test from "node:test";

import {
  DOCUMENT_AUTHORING_PACKAGE,
  DOCS_PACKAGE,
  DOCS_MCP_PACKAGE,
  FOUNDATION_PACKAGE,
  tarballIntegrity,
} from "../../scripts/release-publish-ordered.mjs";
import {
  changesetsReleaseOutput,
  reconcileGithubRelease,
} from "../../scripts/release-publish-ordered-runtime.mjs";

import { main as runPublishedCompatibility } from "../../scripts/published-compatibility-e2e.mjs";

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
  artifact,
  argumentField,
  present,
  publishedState,
  harness,
  run,
} from "./release-publish-ordered-fixtures.mjs";

export function registerSignatureAndRetryCases(): void {
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
    assert.equal(
      runtime.calls.some((entry) => entry.startsWith(`publish:${DOCS_PACKAGE}`)),
      true,
    );
    assert.equal(
      runtime.calls.some((entry) => entry.startsWith("release:")),
      false,
    );
  });

  for (const [drift, mutate, pattern] of [
    [
      "final tag",
      (
        state: NonNullable<
          ReturnType<typeof harness>["states"] extends Map<string, infer Value> ? Value : never
        >,
      ) => {
        state.distTags.latest = "9.9.9";
      },
      /not the exact latest/u,
    ],
    [
      "tarball SRI",
      (
        state: NonNullable<
          ReturnType<typeof harness>["states"] extends Map<string, infer Value> ? Value : never
        >,
      ) => {
        state.integrity = tarballIntegrity(Buffer.from("drift"));
      },
      /different tarball SRI/u,
    ],
    [
      "provenance",
      (
        state: NonNullable<
          ReturnType<typeof harness>["states"] extends Map<string, infer Value> ? Value : never
        >,
      ) => {
        state.provenance.commit = "c".repeat(40);
      },
      /provenance is absent/u,
    ],
  ] as const) {
    test(`post-signature snapshot rejects ${drift} drift before GitHub reconciliation`, async () => {
      const runtime = harness();
      runtime.verifySignature = async (value) => {
        runtime.calls.push(`signature:${value.name}`);
        const provenance = structuredClone(runtime.states.get(value.name).provenance);
        if (value.name === DOCS_PACKAGE) {
          mutate(runtime.states.get(DOCUMENT_AUTHORING_PACKAGE));
        }
        return provenance;
      };
      await assert.rejects(run(runtime), pattern);
      assert.equal(
        runtime.calls.some((entry) => entry.startsWith("release:")),
        false,
      );
    });
  }

  for (const reason of ["signature timeout", "signature result unknown"]) {
    test(`fails closed on ${reason}`, async () => {
      const runtime = harness();
      runtime.verifySignature = async () => {
        throw new Error(reason);
      };
      await assert.rejects(run(runtime), new RegExp(reason, "u"));
      assert.equal(
        runtime.calls.some((entry) => entry.startsWith(`publish:${DOCS_PACKAGE}`)),
        false,
      );
    });
  }

  test("retries signature verification without republishing Foundation", async () => {
    const runtime = harness();
    let attempts = 0;
    runtime.verifySignature = async (value) => {
      runtime.calls.push(`signature:${value.name}`);
      if (value.name === FOUNDATION_PACKAGE && ++attempts === 1) {
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

  test("nine published npm versions reach reconciliation after preflight on a later main without npm writes", async () => {
    const runtime = harness(
      publishedState(
        stackToolchain,
        ciInputProof,
        featureModuleStandard,
        mutation,
        authoring,
        foundation,
        docs,
        docsAdapter,
        docsMcp,
      ),
    );
    const historical: string[] = [];
    await runPublishedCompatibility({
      args: [],
      qualifyPublicDocs: async () => {
        throw new Error("GitHub tags remain absent before reconciliation");
      },
      ...Object.fromEntries(
        ["verifyBootstrap", "verifyTransactions", "verifyAuthoring", "verifyScaffolding"].map(
          (name) => [
            name,
            async () => {
              historical.push(name);
              return [];
            },
          ],
        ),
      ),
      write: () => true,
    });
    assert.deepEqual(historical, [
      "verifyBootstrap",
      "verifyTransactions",
      "verifyAuthoring",
      "verifyScaffolding",
    ]);
    const laterSource = {
      ...source,
      commit: "b".repeat(40),
      isTrustedCommit: async (commit: string) => commit === source.commit,
    };
    const released = await run(runtime, {
      source: laterSource,
    });
    assert.equal(runtime.calls.filter((call) => call.startsWith("release:")).length, 9);
    assert.equal(changesetsReleaseOutput(released), "");
    assert.equal(
      runtime.calls.some((entry) => /^(?:publish|tag|untag):/u.test(entry)),
      false,
    );
  });

  test("emits only the package released by the current commit when Foundation is an older ancestor", async () => {
    const initial = publishedState(
      stackToolchain,
      ciInputProof,
      featureModuleStandard,
      mutation,
      authoring,
      foundation,
      docs,
      docsAdapter,
      docsMcp,
    );
    const currentCommit = "b".repeat(40);
    initial[DOCS_PACKAGE].provenance.commit = currentCommit;
    const runtime = harness(initial);
    const mixedSource = {
      ...source,
      commit: currentCommit,
      isTrustedCommit: async (commit: string) => [source.commit, currentCommit].includes(commit),
    };
    const released = await run(runtime, {
      source: mixedSource,
    });
    assert.equal(changesetsReleaseOutput(released), `New tag: ${DOCS_PACKAGE}@${docs.version}\n`);
    assert.equal(
      runtime.calls.some((entry) => /^(?:publish|tag|untag):/u.test(entry)),
      false,
    );
  });

  test("reconciles a partial GitHub release boundary exactly once per package", async () => {
    const runtime: Omit<ReturnType<typeof harness>, "reconcileRelease"> & {
      reconcileRelease: (value: { name: string }) => Promise<unknown>;
    } = harness();
    const created = new Set();
    const writes: string[] = [];
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
    assert.deepEqual(writes, [
      CI_INPUT_PROOF_PACKAGE,
      MUTATION_PACKAGE,
      DOCUMENT_AUTHORING_PACKAGE,
      DOCS_PACKAGE,
      DOCS_ADAPTER_PACKAGE,
      DOCS_MCP_PACKAGE,
      FOUNDATION_PACKAGE,
      FEATURE_MODULE_STANDARD_PACKAGE,
      STACK_TOOLCHAIN_PACKAGE,
    ]);
    assert.equal(runtime.calls.filter((entry) => entry.startsWith("publish:")).length, 9);
  });
}

export function registerRegistryBoundaryCases(): void {
  test("production GitHub reconciliation repairs a lost release response idempotently", async () => {
    const repository = "agent-teams-ai/engineering-foundation";
    const releaseArtifact = { ...foundation, releaseNotes: "Exact release notes" };
    const tag = `${releaseArtifact.name}@${releaseArtifact.version}`;
    let ref: { object: { sha: string; type: string } } | undefined;
    let release:
      | {
          body: string;
          draft: boolean;
          prerelease: boolean;
          tag_name: string;
          target_commitish?: string;
          name: string;
        }
      | undefined;
    let loseFirstReleaseResponse = true;
    const writes: string[] = [];
    const request = (args: string[]) => {
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
    assert.equal(release!.tag_name, tag);
    release!.draft = true;
    await assert.rejects(
      reconcileGithubRelease(releaseArtifact, source.commit, { repository, request }),
      /differs from the reviewed changelog evidence/u,
    );
  });

  test("production GitHub reconciliation re-observes state after a transient 503", async () => {
    const repository = "agent-teams-ai/engineering-foundation";
    const releaseArtifact = { ...foundation, releaseNotes: "Exact release notes" };
    let ref: { object: { sha: string; type: string } } | undefined;
    let release:
      | {
          body: string;
          draft: boolean;
          prerelease: boolean;
          tag_name: string;
          target_commitish?: string;
          name: string;
        }
      | undefined;
    let transient = true;
    const writes: string[] = [];
    const waits: number[] = [];
    const request = (args: string[]) => {
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
          draft: false,
          name: argumentField(args, "name="),
          prerelease: releaseArtifact.version.includes("-"),
          tag_name: argumentField(args, "tag_name="),
        };
        writes.push("release");
        if (transient) {
          transient = false;
          throw new Error("gh api failed: HTTP 503");
        }
        return release;
      }
      throw new Error(`Unexpected fake GitHub route: ${route}`);
    };
    await reconcileGithubRelease(releaseArtifact, source.commit, {
      attempts: 2,
      repository,
      request,
      retryDelayMilliseconds: 7,
      wait: async (milliseconds: number) => waits.push(milliseconds),
    });
    assert.deepEqual(writes, ["tag", "release"]);
    assert.deepEqual(waits, [7]);
  });

  for (const [name, state] of [
    [
      "timeout",
      () => {
        throw new Error("timeout");
      },
    ],
    ["5xx", { error: new Error("registry returned 503"), status: "unknown" }],
    ["unknown shape", { status: "indeterminate" }],
  ]) {
    test(`fails closed before publish on ${name}`, async () => {
      const runtime = harness({ [FOUNDATION_PACKAGE]: state });
      await assert.rejects(run(runtime), /unknown|invalid state/iu);
      assert.equal(
        runtime.calls.some((entry) => entry.startsWith("publish:")),
        false,
      );
    });
  }

  test("does not guess after persistent 404 following publish", async () => {
    const runtime = harness();
    runtime.publish = async (value, tag) => {
      runtime.calls.push(`publish:${value.name}:${tag}`);
    };
    await assert.rejects(run(runtime), /remained absent/iu);
    assert.equal(
      runtime.calls.some((entry) => entry.startsWith(`publish:${DOCS_PACKAGE}`)),
      false,
    );
  });

  test("rejects immutable-version mismatch and requires quarantine/new version", async () => {
    const mismatch = present(foundation, "2026-01-01T00:00:00.000Z");
    mismatch.integrity = tarballIntegrity(Buffer.from("different"));
    const runtime = harness({ [FOUNDATION_PACKAGE]: mismatch });
    await assert.rejects(run(runtime), /different tarball SRI.*quarantine.*new version/iu);
    assert.equal(
      runtime.calls.some((entry) => entry.startsWith("publish:")),
      false,
    );
  });

  test("rejects Docs published before Document Authoring without reconciling GitHub releases", async () => {
    const initial = publishedState(
      stackToolchain,
      ciInputProof,
      featureModuleStandard,
      mutation,
      authoring,
      foundation,
      docs,
    );
    initial[DOCS_PACKAGE].publishedAt = "2026-01-01T00:00:00.500Z";
    const runtime = harness(initial);
    await assert.rejects(run(runtime), /docs-protocol.*published before.*document-authoring/iu);
    assert.equal(
      runtime.calls.some((entry) => entry.startsWith("release:")),
      false,
    );
  });

  test("refuses an existing immutable version when the final tag no longer targets it", async () => {
    const foundationState = present(foundation, "2026-01-01T00:00:00.000Z");
    foundationState.distTags.latest = "9.9.9";
    const runtime = harness({ [FOUNDATION_PACKAGE]: foundationState });
    await assert.rejects(run(runtime), /not the exact latest dist-tag target/u);
    assert.equal(
      runtime.calls.some((entry) => entry.startsWith("publish:")),
      false,
    );
  });

  test("rejects local and published Docs manifests without the exact Document Authoring dependency", async () => {
    const badDocs = artifact(DOCS_PACKAGE, docs.version, {
      [DOCUMENT_AUTHORING_PACKAGE]: "^0.1.0",
      [MUTATION_PACKAGE]: mutation.version,
    });
    await assert.rejects(
      run(harness(), {
        artifacts: [
          stackToolchain,
          ciInputProof,
          featureModuleStandard,
          mutation,
          authoring,
          foundation,
          badDocs,
          docsAdapter,
          docsMcp,
        ],
      }),
      /docs-protocol.*exact.*document-authoring/iu,
    );

    const publishedDocs = present(docs, "2026-01-01T00:00:01.000Z");
    publishedDocs.manifest.dependencies[DOCUMENT_AUTHORING_PACKAGE] = "^0.1.0";
    const initial = publishedState(
      stackToolchain,
      ciInputProof,
      featureModuleStandard,
      mutation,
      authoring,
      foundation,
    );
    initial[DOCS_PACKAGE] = publishedDocs;
    const runtime = harness(initial);
    await assert.rejects(run(runtime), /different packed manifest/iu);
  });
}
