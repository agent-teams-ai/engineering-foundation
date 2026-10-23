import {
  assertFindFilters,
  assertNewPreview,
  assertCurrentMethods,
} from "./support/protocol-core-assertions.ts";
import {
  tenantIntent,
  authorityRaceFixtures,
  recoveryReceipt,
  badRelationFoundation,
} from "./support/protocol-fixtures.ts";
import { registerCompiledOutputCases } from "./support/compiled-output-cases.ts";
import { DocsProtocol } from "../dist/features/portable-documentation/application/docs-protocol.js";
import { YamlCompiledOutputReader } from "../dist/features/portable-documentation/adapters/outbound/yaml-compiled-output-reader.js";
import { createCommunityMiniSearchIndex } from "../dist/features/portable-documentation/adapters/outbound/minisearch-adapter.js";
import assert from "node:assert/strict";
import test from "node:test";

import { createDocsProtocolApi } from "../dist/features/docs-command/adapters/inbound/protocol-api.js";

import {
  profile,
  types,
  CATALOG_SEMANTIC_DIGEST,
  descriptor,
  plan,
  harness,
} from "./fixtures/protocol-harness.mjs";

registerCompiledOutputCases();

test("find applies relation filters with AND and stable zero-match success", async () => {
  const { protocol } = harness();
  await assertFindFilters(protocol);
});

test("new preview is non-mutating and preserves unified metadata vocabulary", async () => {
  const { protocol, calls } = harness();
  await assertNewPreview(protocol, calls);
});

test("current protocol methods expose portable v3 profile evidence without legacy wrappers", async () => {
  const current = harness().protocol;
  await assertCurrentMethods(current);
});

test("new omits semantically empty optional metadata identically for preview and apply", async () => {
  const base = {
    consumerRoot: ".",
    profilePath: "docs/docs-protocol.json",
    intent: tenantIntent(),
  };
  const previewHarness = harness();
  const applyHarness = harness();
  const preview = await previewHarness.protocol.newDocumentV2({
    ...base,
    apply: false,
    related: [],
    blockedBy: [],
    codeAnchors: [],
  });
  const applied = await applyHarness.protocol.newDocumentV2({ ...base, apply: true });

  assert.deepEqual([preview.exitCode, applied.exitCode], [0, 0]);
  assert.equal(
    JSON.stringify(previewHarness.calls.plan[0].intent),
    JSON.stringify(applyHarness.calls.plan[0].intent),
  );
  assert.equal(preview.envelope.result.planDigest, applied.envelope.result.planDigest);
  assert.equal("related" in previewHarness.calls.plan[0].intent, false);
  assert.equal("additionalMetadata" in previewHarness.calls.plan[0].intent, false);
});

test("new rejects optional metadata aliases even when callers try to inject empty arrays", async () => {
  for (const key of ["related", "blocked_by", "code_anchors"]) {
    const { protocol, calls } = harness();
    await assert.rejects(
      protocol.newDocumentV2({
        apply: false,
        consumerRoot: ".",
        profilePath: "docs/docs-protocol.json",
        intent: tenantIntent(),
        additionalMetadata: { [key]: [] },
      }),
      new RegExp(`cannot replace governed key ${key}`, "u"),
    );
    assert.equal(calls.plan.length, 0);
  }
});

test("new rejects missing, self, and non-open-decision blockers before planning", async () => {
  for (const blockedBy of [["ADR-9999"], ["ADR-0083"], ["ADR-0001"]]) {
    const { protocol, calls } = harness();
    await assert.rejects(
      protocol.newDocumentV2({
        apply: false,
        consumerRoot: ".",
        profilePath: "architecture/foundation/docs-protocol.yaml",
        intent: tenantIntent(),
        blockedBy,
      }),
    );
    assert.equal(calls.plan.length, 0);
  }
});

test("new preview and apply fail closed before Plan when adoption identity is invalid", async () => {
  for (const apply of [false, true]) {
    const { protocol, calls } = harness({
      adoption: {
        async inspect() {
          return [
            {
              ruleId: "docs.adoption.foundation-runtime-identity",
              severity: "error",
              phase: "authority",
              subject: "@agent-teams/engineering-foundation",
              message: "Installed Foundation runtime does not match the adopted exact dependency.",
            },
          ];
        },
      },
    });
    const result = await protocol.newDocumentV2({
      apply,
      consumerRoot: ".",
      profilePath: "architecture/foundation/docs-protocol.yaml",
      intent: tenantIntent(),
    });
    assert.equal(result.envelope.outcome, "violation");
    assert.equal(result.envelope.result.reason, "adoption-invalid");
    assert.equal(
      result.envelope.diagnostics[0].ruleId,
      "docs.adoption.foundation-runtime-identity",
    );
    assert.equal(calls.plan.length, 0);
    assert.equal(calls.apply, 0);
  }
});

test("check reports invalid common relation semantics without executing validators", async () => {
  const { protocol } = harness();
  const originalBuild = protocol;
  // The public check path uses only injected read-only ports. A missing related
  // target in v2 metadata must fail before any consumer validator is invoked.
  const badFoundation = badRelationFoundation(types, descriptor);
  const checked = await createDocsProtocolApi(
    new DocsProtocol({
      compiledOutput: new YamlCompiledOutputReader(),
      searchIndex: createCommunityMiniSearchIndex(),
      adoption: {
        async inspect() {
          return [];
        },
      },
      anchors: {
        async matchedPatterns({ patterns }) {
          return patterns;
        },
      },
      foundation: badFoundation,
      profiles: {
        async read() {
          return profile;
        },
      },
    }),
  ).checkV2({ consumerRoot: ".", profilePath: "architecture/foundation/docs-protocol.yaml" });
  assert.equal(checked.exitCode, 1);
  assert.ok(checked.envelope.diagnostics.some(({ message }) => message.includes("does not exist")));
  assert.ok(originalBuild);
});

test("new apply delegates the exact Foundation plan once", async () => {
  const { protocol, calls } = harness();
  const result = await protocol.newDocumentV2({
    apply: true,
    consumerRoot: ".",
    profilePath: "docs/docs-protocol.json",
    intent: tenantIntent(),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.envelope.result.writeState, "applied");
  assert.equal(calls.apply, 1);
});

test("new withholds reachability when the published catalog misses the expected postimage", async () => {
  const { protocol, calls } = harness({
    catalogs: [undefined, undefined, { semanticDigest: `sha256:${"8".repeat(64)}` }],
  });
  const result = await protocol.newDocumentV2({
    apply: true,
    consumerRoot: ".",
    profilePath: "docs/docs-protocol.json",
    intent: tenantIntent(),
  });
  assert.equal(result.envelope.outcome, "execution-failure");
  assert.equal(result.envelope.result.reachability, undefined);
  assert.equal(result.envelope.diagnostics.at(-1).ruleId, "docs.new.catalog-postimage-mismatch");
  assert.equal(calls.apply, 1);
});

test("new reports published recovery state and directory evidence truthfully", async () => {
  const receipt = recoveryReceipt();
  const { protocol } = harness({ applyReceipt: receipt });
  const result = await protocol.newDocumentV2({
    apply: true,
    consumerRoot: ".",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    intent: tenantIntent(),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.result.writeState, "published-recovery-required");
  assert.equal(result.envelope.result.reachability, undefined);
  assert.equal(result.envelope.result.receipt.commit.publication, "published");
  assert.equal(
    result.envelope.result.receipt.directoryMaterialization.state,
    "created-and-retained",
  );
});

test("advisory anchors warn without gating while required anchors fail closed", async () => {
  const base = {
    apply: false,
    consumerRoot: ".",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    intent: tenantIntent(),
  };
  const advisory = await harness({ matchedPatterns: [] }).protocol.newDocumentV2({
    ...base,
    codeAnchors: [{ pattern: "src/advisory.ts", enforcement: "advisory" }],
  });
  assert.equal(advisory.exitCode, 0);
  assert.equal(advisory.envelope.diagnostics[0].severity, "warning");
  assert.equal(advisory.envelope.diagnostics[0].ruleId, "docs.code-anchor.advisory-unmatched");
  await assert.rejects(
    harness({ matchedPatterns: [] }).protocol.newDocumentV2({
      ...base,
      codeAnchors: [{ pattern: "src/required.ts", enforcement: "required" }],
    }),
    /Required code anchor/u,
  );
});

test("required anchors are recaptured immediately before apply and block a stale authority", async () => {
  let captures = 0;
  const { protocol, calls } = harness({
    anchors: {
      async matchedPatterns({ patterns }) {
        captures += 1;
        return captures === 1 ? patterns : [];
      },
    },
  });
  const result = await protocol.newDocumentV2({
    apply: true,
    consumerRoot: ".",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    intent: tenantIntent(),
    codeAnchors: [{ pattern: "src/required.ts", enforcement: "required" }],
  });
  assert.equal(captures, 2);
  assert.equal(calls.apply, 0);
  assert.equal(result.envelope.outcome, "authority-stale");
  assert.equal(result.envelope.result.writeState, "blocked");
  assert.equal(result.envelope.result.reachability, undefined);
  assert.equal(result.envelope.diagnostics.at(-1).ruleId, "docs.code-anchor.required-stale");
});

test("advisory anchor drift remains a single stable warning and does not gate publication", async () => {
  let captures = 0;
  const { protocol, calls } = harness({
    anchors: {
      async matchedPatterns({ patterns }) {
        captures += 1;
        return captures === 1 ? patterns : [];
      },
    },
  });
  const result = await protocol.newDocumentV2({
    apply: true,
    consumerRoot: ".",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    intent: tenantIntent(),
    codeAnchors: [{ pattern: "src/advisory.ts", enforcement: "advisory" }],
  });
  assert.equal(captures, 3);
  assert.equal(calls.apply, 1);
  assert.equal(result.envelope.outcome, "success");
  assert.equal(
    result.envelope.diagnostics.filter(
      ({ ruleId }) => ruleId === "docs.code-anchor.advisory-unmatched",
    ).length,
    1,
  );
});

test("check bounds corpus anchor aggregation and emits one deterministic budget diagnostic", async () => {
  const documents = Array.from({ length: 17 }, (_unused, documentIndex) => ({
    ...descriptor({
      id: `ADR-${String(documentIndex + 100).padStart(4, "0")}`,
      repositoryPath: `docs/decisions/${documentIndex}.md`,
      related: [],
      blockedBy: [],
    }),
    metadata: {
      code_anchors: Array.from({ length: 256 }, (_entry, anchorIndex) => ({
        enforcement: "advisory",
        pattern: `src/d${documentIndex}/file-${anchorIndex}.ts`,
      })),
    },
  }));
  let observedPatterns = 0;
  const { protocol } = harness({
    catalogs: [
      {
        projectId: "fixture-project",
        status: "complete",
        diagnostics: [],
        documents,
        identityProjection: [],
        ownerIds: [],
        authority: {},
        semanticDigest: CATALOG_SEMANTIC_DIGEST,
      },
    ],
    anchors: {
      async matchedPatterns({ patterns }) {
        observedPatterns = patterns.length;
        return patterns;
      },
    },
  });
  const result = await protocol.checkV2({
    consumerRoot: ".",
    profilePath: "architecture/foundation/docs-protocol.yaml",
  });
  assert.equal(observedPatterns, 1_024);
  assert.equal(result.envelope.outcome, "violation");
  assert.equal(
    result.envelope.diagnostics.filter(
      ({ ruleId }) => ruleId === "docs.code-anchor.corpus-budget-exceeded",
    ).length,
    1,
  );
  assert.ok(result.envelope.diagnostics.length <= 256);
});

test("find binds the referenced current Foundation profile before querying", async () => {
  let queried = false;
  const foundation = {
    async describe() {
      throw new Error("Foundation authoring profile schemaVersion must be 3");
    },
    async find() {
      queried = true;
      return [];
    },
  };
  const protocol = createDocsProtocolApi(
    new DocsProtocol({
      compiledOutput: new YamlCompiledOutputReader(),
      searchIndex: createCommunityMiniSearchIndex(),
      adoption: {
        async inspect() {
          return [];
        },
      },
      anchors: {
        async matchedPatterns() {
          return [];
        },
      },
      foundation,
      profiles: {
        async read() {
          return profile;
        },
      },
    }),
  );
  await assert.rejects(
    protocol.findV2({
      consumerRoot: ".",
      profilePath: "architecture/foundation/docs-protocol.yaml",
      query: {},
    }),
    /schemaVersion must be 3/u,
  );
  assert.equal(queried, false);
});

test("direct API rejects invalid relation filters and bounded authoring collections", async () => {
  const { protocol, calls } = harness();
  await assert.rejects(
    protocol.findV2({
      consumerRoot: ".",
      profilePath: "architecture/foundation/docs-protocol.yaml",
      query: { related: " ADR-0001" },
    }),
    /canonical document ID/u,
  );
  assert.equal(calls.find, 0);

  const base = {
    apply: false,
    consumerRoot: ".",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    intent: tenantIntent(),
  };
  await assert.rejects(
    protocol.newDocumentV2({
      ...base,
      related: Array.from(
        { length: 257 },
        (_value, index) => `ADR-${String(index).padStart(4, "0")}`,
      ),
    }),
    /exceeds 256/u,
  );
  await assert.rejects(
    protocol.newDocumentV2({
      ...base,
      codeAnchors: Array.from({ length: 257 }, (_value, index) => ({
        pattern: `src/file-${index}.ts`,
        enforcement: "required",
      })),
    }),
    /exceeds 256/u,
  );
  const oversizedMetadata = Object.fromEntries(
    Array.from({ length: 10_001 }, (_value, index) => [`key_${index}`, index]),
  );
  await assert.rejects(
    protocol.newDocumentV2({ ...base, additionalMetadata: oversizedMetadata }),
    /exceeds 10000/u,
  );
  const sparse = [];
  sparse.length = 2;
  sparse[1] = "present";
  await assert.rejects(
    protocol.newDocumentV2({ ...base, additionalMetadata: { sparse } }),
    /sparse/u,
  );
  const accessor = {};
  Object.defineProperty(accessor, "computed", {
    enumerable: true,
    get() {
      return "value";
    },
  });
  await assert.rejects(
    protocol.newDocumentV2({ ...base, additionalMetadata: accessor }),
    /data property/u,
  );
  assert.equal(calls.plan.length, 0);
});

test("new fails authority-stale across profile and blocker-status races without applying or advising an index", async () => {
  const { initialDescription, changedDescription, baseCatalog, changedCatalog } =
    authorityRaceFixtures(types, descriptor);
  const { protocol, calls } = harness({
    descriptions: [initialDescription, changedDescription],
    catalogs: [baseCatalog, changedCatalog],
  });
  const result = await protocol.newDocumentV2({
    apply: true,
    consumerRoot: ".",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    intent: tenantIntent(),
    blockedBy: ["OD-001"],
  });
  assert.equal(result.envelope.outcome, "authority-stale");
  assert.equal(result.envelope.result.writeState, "blocked");
  assert.equal(result.envelope.result.reachability, undefined);
  assert.equal(calls.apply, 0);
});

test("new fails authority-stale when Plan is bound to a different authority snapshot", async () => {
  const mismatchedPlan = plan({
    schemaVersion: 1,
    type: "adr",
    id: "ADR-0083",
    title: "Tenant isolation",
    owner: "architecture/tooling",
    summary: "Defines tenant isolation.",
  });
  mismatchedPlan.authority.profileSemanticDigest = `sha256:${"8".repeat(64)}`;
  mismatchedPlan.authority.catalogPreimageSemanticDigest = `sha256:${"9".repeat(64)}`;
  const { protocol, calls } = harness({ plan: mismatchedPlan });
  const result = await protocol.newDocumentV2({
    apply: true,
    consumerRoot: ".",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    intent: tenantIntent(),
  });
  assert.equal(result.envelope.outcome, "authority-stale");
  assert.equal(calls.apply, 0);
});

test("compiled preview uses injected output decoding before pure projection", async () => {
  let observed;
  const { protocol } = harness({
    compiledOutput: {
      read(output) {
        observed = output;
        return {
          content: "provider-decoded content",
          frontmatter: "id: ADR-0083",
          metadata: { id: "ADR-0083" },
        };
      },
    },
  });
  const result = await protocol.newDocumentV2({
    apply: false,
    consumerRoot: ".",
    profilePath: "docs.config.yaml",
    intent: tenantIntent(),
  });
  assert.equal(result.envelope.result.compiled.document.content, "provider-decoded content");
  assert.equal(observed.digest, plan({}).output.digest);
  assert.deepEqual(result.envelope.result.compiled.metadata, { id: "ADR-0083" });
});
