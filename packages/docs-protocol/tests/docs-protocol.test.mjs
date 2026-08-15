import assert from "node:assert/strict";
import test from "node:test";

import { DocsProtocol } from "../dist/application/docs-protocol.js";
import { parseDocsProtocolProfile } from "../dist/domain/profile-policy.js";

const profile = parseDocsProtocolProfile({
  schemaVersion: 1,
  protocol: { id: "agent-teams.docs-protocol", version: 1 },
  foundationProfile: { path: "architecture/foundation/document-authoring.yaml", schemaVersion: 2, metadataSidecarPolicy: "foundation-profile-v2-strict-merge" },
  agentWorkflow: { skillPath: ".agents/skills/docs-authoring/SKILL.md" },
  semanticValidatorIds: ["documentation.domain-semantics"]
});

const types = [{
  type: "adr",
  initialStatus: "proposed",
  allowedOwnerIds: ["architecture/tooling"],
  identity: { format: "adr-four-digits" },
  heading: { kind: "id-colon-title" },
  placement: { kind: "collection" },
  requiredMetadata: ["id", "type", "status", "owner", "summary"],
  reachability: { kind: "manual-fixed-index", indexPath: "docs/decisions/README.md" }
}];

const PROFILE_SEMANTIC_DIGEST = `sha256:${"6".repeat(64)}`;
const CATALOG_SEMANTIC_DIGEST = `sha256:${"7".repeat(64)}`;

function descriptor(overrides = {}) {
  return {
    id: "ADR-0002",
    type: "adr",
    status: "accepted",
    owner: "architecture/tooling",
    summary: "Second decision",
    title: "Second",
    repositoryPath: "docs/decisions/0002-second.md",
    source: "markdown-tree",
    related: ["ADR-0001"],
    blockedBy: ["ADR-0003"],
    ...overrides
  };
}

function plan(intent) {
  return {
    schemaVersion: 2,
    protocolVersion: 2,
    compiler: { id: "@agent-teams/engineering-foundation", version: "0.17.0-rc.0", buildIdentity: `sha256:${"1".repeat(64)}` },
    projectId: "fixture-project",
    intent,
    intentDigest: `sha256:${"2".repeat(64)}`,
    authority: {
      profileSemanticDigest: PROFILE_SEMANTIC_DIGEST,
      catalogPreimageSemanticDigest: CATALOG_SEMANTIC_DIGEST,
      expectedCatalogPostimageSemanticDigest: CATALOG_SEMANTIC_DIGEST
    },
    selectedOwner: {},
    identityProjection: {},
    referencedDocuments: [],
    destination: "docs/decisions/0083-tenant-isolation.md",
    expectedParent: { path: "docs/decisions", state: "directory", ancestry: "real-directories" },
    parentMaterialization: { policy: "create-missing-real-directories", missingDirectories: [] },
    destinationPrecondition: { state: "absent" },
    output: {},
    requiredAdapterCapabilities: ["create-directories-no-replace/v1", "create-file-no-replace/v1"],
    diagnostics: [],
    planDigest: `sha256:${"3".repeat(64)}`
  };
}

function harness(options = {}) {
  const calls = { apply: 0, buildCatalog: 0, describe: 0, find: 0, plan: [] };
  const defaultDescription = { authority: { templates: [] }, projectId: "fixture-project", profileSchemaVersion: 2, semanticDigest: PROFILE_SEMANTIC_DIGEST, metadataSchemaPath: "docs/metadata.schema.json", metadataSidecar: { kind: "none" }, ownerIds: ["architecture/tooling"], types, authorityPaths: [] };
  const defaultCatalog = { projectId: "fixture-project", status: "complete", diagnostics: [], documents: [
    { ...descriptor({ id: "ADR-0001", repositoryPath: "docs/decisions/0001-first.md" }), metadata: {} },
    { ...descriptor({ id: "OD-001", type: "open-decision", status: "open", repositoryPath: "docs/open-decisions/OD-001.md" }), metadata: {} }
  ], identityProjection: [], ownerIds: ["architecture/tooling"], authority: {}, semanticDigest: CATALOG_SEMANTIC_DIGEST };
  const foundation = {
    async describe() {
      const value = options.descriptions?.[calls.describe] ?? defaultDescription;
      calls.describe += 1;
      return value;
    },
    async buildCatalog() {
      const value = options.catalogs?.[calls.buildCatalog] ?? defaultCatalog;
      calls.buildCatalog += 1;
      return value;
    },
    async find() {
      calls.find += 1;
      return [descriptor(), descriptor({ id: "ADR-0004", repositoryPath: "docs/decisions/0004-fourth.md", related: [] })];
    },
    async inspect() { return { schemaVersion: 1, state: "idle", diagnostics: [] }; },
    async plan(input) { calls.plan.push(input); return options.plan ?? plan(input.intent); },
    async apply(input) {
      calls.apply += 1;
      return options.applyReceipt ?? {
        schemaVersion: 1,
        protocolVersion: 1,
        planDigest: input.plan.planDigest,
        adapter: { id: "foundation.filesystem/v1", contractVersion: 1 },
        destination: input.plan.destination,
        outcome: "applied",
        resultDigest: `sha256:${"4".repeat(64)}`,
        commit: { state: "committed", publication: "published", atomicity: "single-file-atomic-create", recoverability: "not-required" },
        diagnostics: [],
        receiptDigest: `sha256:${"5".repeat(64)}`
      };
    },
    async recover() { throw new Error("not used"); }
  };
  return {
    calls,
    protocol: new DocsProtocol({ adoption: options.adoption ?? { async inspect() { return []; } }, anchors: options.anchors ?? { async matchedPatterns({ patterns }) { return options.matchedPatterns ?? patterns; } }, foundation, profiles: { async read() { return profile; } } })
  };
}

test("find applies relation filters with AND and stable zero-match success", async () => {
  const { protocol } = harness();
  const found = await protocol.find({ consumerRoot: ".", profilePath: "docs/docs-protocol.json", query: { type: "adr", related: "ADR-0001", blockedBy: "ADR-0003" } });
  assert.equal(found.exitCode, 0);
  assert.deepEqual(found.envelope.result.documents.map(({ id }) => id), ["ADR-0002"]);
  const empty = await protocol.find({ consumerRoot: ".", profilePath: "docs/docs-protocol.json", query: { related: "ADR-9999" } });
  assert.equal(empty.exitCode, 0);
  assert.equal(empty.envelope.result.matches, 0);
});

test("new preview is non-mutating and preserves unified metadata vocabulary", async () => {
  const { protocol, calls } = harness();
  const result = await protocol.newDocument({
    apply: false,
    consumerRoot: ".",
    profilePath: "docs/docs-protocol.json",
    intent: { type: "adr", id: "ADR-0083", title: "Tenant isolation", owner: "architecture/tooling", summary: "Defines tenant isolation." },
    related: ["ADR-0001"],
    blockedBy: ["OD-001"],
    codeAnchors: [{ pattern: "src/tenant.ts", enforcement: "required" }],
    additionalMetadata: { evidence: ["test:tenant"] }
  });
  assert.equal(result.envelope.result.writeState, "preview");
  assert.equal(result.envelope.result.reservation, "none");
  assert.equal(calls.apply, 0);
  assert.deepEqual(calls.plan[0].intent.additionalMetadata, {
    evidence: ["test:tenant"],
    blocked_by: ["OD-001"],
    code_anchors: [{ enforcement: "required", pattern: "src/tenant.ts" }]
  });
  assert.deepEqual(calls.plan[0].intent.related, ["ADR-0001", "OD-001"]);
  assert.equal(calls.plan[0].parentPolicy, "create-missing-real-directories");
  assert.deepEqual(result.envelope.result.reachability, {
    state: "manual-required",
    indexPath: "docs/decisions/README.md",
    markdownLink: "[ADR-0083: Tenant isolation](0083-tenant-isolation.md)"
  });
});

test("new omits semantically empty optional metadata identically for preview and apply", async () => {
  const base = { consumerRoot: ".", profilePath: "docs/docs-protocol.json", intent: { type: "adr", id: "ADR-0083", title: "Tenant isolation", owner: "architecture/tooling", summary: "Defines tenant isolation." } };
  const previewHarness = harness();
  const applyHarness = harness();
  const preview = await previewHarness.protocol.newDocument({
    ...base,
    apply: false,
    related: [],
    blockedBy: [],
    codeAnchors: []
  });
  const applied = await applyHarness.protocol.newDocument({ ...base, apply: true });

  assert.deepEqual([preview.exitCode, applied.exitCode], [0, 0]);
  assert.equal(JSON.stringify(previewHarness.calls.plan[0].intent), JSON.stringify(applyHarness.calls.plan[0].intent));
  assert.equal(preview.envelope.result.planDigest, applied.envelope.result.planDigest);
  assert.equal("related" in previewHarness.calls.plan[0].intent, false);
  assert.equal("additionalMetadata" in previewHarness.calls.plan[0].intent, false);
});

test("new rejects optional metadata aliases even when callers try to inject empty arrays", async () => {
  for (const key of ["related", "blocked_by", "code_anchors"]) {
    const { protocol, calls } = harness();
    await assert.rejects(protocol.newDocument({
      apply: false,
      consumerRoot: ".",
      profilePath: "docs/docs-protocol.json",
      intent: { type: "adr", id: "ADR-0083", title: "Tenant isolation", owner: "architecture/tooling", summary: "Defines tenant isolation." },
      additionalMetadata: { [key]: [] }
    }), new RegExp(`cannot replace governed key ${key}`, "u"));
    assert.equal(calls.plan.length, 0);
  }
});

test("new rejects missing, self, and non-open-decision blockers before planning", async () => {
  for (const blockedBy of [["ADR-9999"], ["ADR-0083"], ["ADR-0001"]]) {
    const { protocol, calls } = harness();
    await assert.rejects(protocol.newDocument({
      apply: false,
      consumerRoot: ".",
      profilePath: "architecture/foundation/docs-protocol.yaml",
      intent: { type: "adr", id: "ADR-0083", title: "Tenant isolation", owner: "architecture/tooling", summary: "Defines tenant isolation." },
      blockedBy
    }));
    assert.equal(calls.plan.length, 0);
  }
});

test("new preview and apply fail closed before Plan when adoption identity is invalid", async () => {
  for (const apply of [false, true]) {
    const { protocol, calls } = harness({
      adoption: {
        async inspect() {
          return [{ ruleId: "docs.adoption.foundation-runtime-identity", severity: "error", phase: "authority", subject: "@agent-teams/engineering-foundation", message: "Installed Foundation runtime does not match the adopted exact dependency." }];
        }
      }
    });
    const result = await protocol.newDocument({
      apply,
      consumerRoot: ".",
      profilePath: "architecture/foundation/docs-protocol.yaml",
      intent: { type: "adr", id: "ADR-0083", title: "Tenant isolation", owner: "architecture/tooling", summary: "Defines tenant isolation." }
    });
    assert.equal(result.envelope.outcome, "violation");
    assert.equal(result.envelope.result.reason, "adoption-invalid");
    assert.equal(result.envelope.diagnostics[0].ruleId, "docs.adoption.foundation-runtime-identity");
    assert.equal(calls.plan.length, 0);
    assert.equal(calls.apply, 0);
  }
});

test("check reports invalid common relation semantics without executing validators", async () => {
  const { protocol } = harness();
  const originalBuild = protocol;
  // The public check path uses only injected read-only ports. A missing related
  // target in v2 metadata must fail before any consumer validator is invoked.
  const badFoundation = {
    async describe() { return { authority: {}, projectId: "fixture-project", profileSchemaVersion: 2, metadataSchemaPath: "docs/metadata.schema.json", metadataSidecar: { kind: "none" }, ownerIds: ["architecture/tooling"], types, authorityPaths: [] }; },
    async buildCatalog() { return { projectId: "fixture-project", status: "complete", diagnostics: [], documents: [{ ...descriptor(), metadata: { related: ["ADR-9999"] } }], identityProjection: [], ownerIds: [], authority: {} }; },
    async inspect() { return { schemaVersion: 1, state: "idle", diagnostics: [] }; },
    async find() { return []; }, async plan() { throw new Error("not used"); }, async apply() { throw new Error("not used"); }, async recover() { throw new Error("not used"); }
  };
  const checked = await new DocsProtocol({ adoption: { async inspect() { return []; } }, anchors: { async matchedPatterns({ patterns }) { return patterns; } }, foundation: badFoundation, profiles: { async read() { return profile; } } }).check({ consumerRoot: ".", profilePath: "architecture/foundation/docs-protocol.yaml" });
  assert.equal(checked.exitCode, 1);
  assert.ok(checked.envelope.diagnostics.some(({ message }) => message.includes("does not exist")));
  assert.ok(originalBuild);
});

test("new apply delegates the exact Foundation plan once", async () => {
  const { protocol, calls } = harness();
  const result = await protocol.newDocument({
    apply: true,
    consumerRoot: ".",
    profilePath: "docs/docs-protocol.json",
    intent: { type: "adr", id: "ADR-0083", title: "Tenant isolation", owner: "architecture/tooling", summary: "Defines tenant isolation." }
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.envelope.result.writeState, "applied");
  assert.equal(calls.apply, 1);
});

test("new withholds reachability when the published catalog misses the expected postimage", async () => {
  const { protocol, calls } = harness({ catalogs: [undefined, undefined, { semanticDigest: `sha256:${"8".repeat(64)}` }] });
  const result = await protocol.newDocument({
    apply: true,
    consumerRoot: ".",
    profilePath: "docs/docs-protocol.json",
    intent: { type: "adr", id: "ADR-0083", title: "Tenant isolation", owner: "architecture/tooling", summary: "Defines tenant isolation." }
  });
  assert.equal(result.envelope.outcome, "execution-failure");
  assert.equal(result.envelope.result.reachability, undefined);
  assert.equal(result.envelope.diagnostics.at(-1).ruleId, "docs.new.catalog-postimage-mismatch");
  assert.equal(calls.apply, 1);
});

test("new reports published recovery state and directory evidence truthfully", async () => {
  const receipt = {
    schemaVersion: 2,
    protocolVersion: 2,
    planDigest: `sha256:${"3".repeat(64)}`,
    adapter: { id: "foundation.filesystem/v1", contractVersion: 1 },
    destination: "docs/decisions/0083-tenant-isolation.md",
    outcome: "recovery-required",
    commit: {
      state: "recovery-required",
      publication: "published",
      fileAtomicity: "single-file-atomic-create",
      recoverability: "preserved-for-recovery"
    },
    directoryMaterialization: {
      state: "created-and-retained",
      plannedDirectories: ["docs/decisions"],
      observedCreatedDirectories: ["docs/decisions"]
    },
    diagnostics: [],
    receiptDigest: `sha256:${"6".repeat(64)}`
  };
  const { protocol } = harness({ applyReceipt: receipt });
  const result = await protocol.newDocument({
    apply: true,
    consumerRoot: ".",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    intent: { type: "adr", id: "ADR-0083", title: "Tenant isolation", owner: "architecture/tooling", summary: "Defines tenant isolation." }
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.result.writeState, "published-recovery-required");
  assert.equal(result.envelope.result.reachability, undefined);
  assert.equal(result.envelope.result.receipt.commit.publication, "published");
  assert.equal(result.envelope.result.receipt.directoryMaterialization.state, "created-and-retained");
});

test("advisory anchors warn without gating while required anchors fail closed", async () => {
  const base = {
    apply: false,
    consumerRoot: ".",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    intent: { type: "adr", id: "ADR-0083", title: "Tenant isolation", owner: "architecture/tooling", summary: "Defines tenant isolation." }
  };
  const advisory = await harness({ matchedPatterns: [] }).protocol.newDocument({
    ...base,
    codeAnchors: [{ pattern: "src/advisory.ts", enforcement: "advisory" }]
  });
  assert.equal(advisory.exitCode, 0);
  assert.equal(advisory.envelope.diagnostics[0].severity, "warning");
  assert.equal(advisory.envelope.diagnostics[0].ruleId, "docs.code-anchor.advisory-unmatched");
  await assert.rejects(
    harness({ matchedPatterns: [] }).protocol.newDocument({ ...base, codeAnchors: [{ pattern: "src/required.ts", enforcement: "required" }] }),
    /Required code anchor/u
  );
});

test("required anchors are recaptured immediately before apply and block a stale authority", async () => {
  let captures = 0;
  const { protocol, calls } = harness({
    anchors: {
      async matchedPatterns({ patterns }) {
        captures += 1;
        return captures === 1 ? patterns : [];
      }
    }
  });
  const result = await protocol.newDocument({
    apply: true,
    consumerRoot: ".",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    intent: { type: "adr", id: "ADR-0083", title: "Tenant isolation", owner: "architecture/tooling", summary: "Defines tenant isolation." },
    codeAnchors: [{ pattern: "src/required.ts", enforcement: "required" }]
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
      }
    }
  });
  const result = await protocol.newDocument({
    apply: true,
    consumerRoot: ".",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    intent: { type: "adr", id: "ADR-0083", title: "Tenant isolation", owner: "architecture/tooling", summary: "Defines tenant isolation." },
    codeAnchors: [{ pattern: "src/advisory.ts", enforcement: "advisory" }]
  });
  assert.equal(captures, 3);
  assert.equal(calls.apply, 1);
  assert.equal(result.envelope.outcome, "success");
  assert.equal(result.envelope.diagnostics.filter(({ ruleId }) => ruleId === "docs.code-anchor.advisory-unmatched").length, 1);
});

test("check bounds corpus anchor aggregation and emits one deterministic budget diagnostic", async () => {
  const documents = Array.from({ length: 17 }, (_unused, documentIndex) => ({
    ...descriptor({ id: `ADR-${String(documentIndex + 100).padStart(4, "0")}`, repositoryPath: `docs/decisions/${documentIndex}.md`, related: [], blockedBy: [] }),
    metadata: {
      code_anchors: Array.from({ length: 256 }, (_entry, anchorIndex) => ({
        enforcement: "advisory",
        pattern: `src/d${documentIndex}/file-${anchorIndex}.ts`
      }))
    }
  }));
  let observedPatterns = 0;
  const { protocol } = harness({
    catalogs: [{ projectId: "fixture-project", status: "complete", diagnostics: [], documents, identityProjection: [], ownerIds: [], authority: {}, semanticDigest: CATALOG_SEMANTIC_DIGEST }],
    anchors: { async matchedPatterns({ patterns }) { observedPatterns = patterns.length; return patterns; } }
  });
  const result = await protocol.check({ consumerRoot: ".", profilePath: "architecture/foundation/docs-protocol.yaml" });
  assert.equal(observedPatterns, 1_024);
  assert.equal(result.envelope.outcome, "violation");
  assert.equal(result.envelope.diagnostics.filter(({ ruleId }) => ruleId === "docs.code-anchor.corpus-budget-exceeded").length, 1);
  assert.ok(result.envelope.diagnostics.length <= 256);
});

test("find binds the referenced Foundation profile to schema v2 before querying", async () => {
  let queried = false;
  const foundation = {
    async describe() { throw new Error("Foundation authoring profile schemaVersion must be 2"); },
    async find() { queried = true; return []; }
  };
  const protocol = new DocsProtocol({
    adoption: { async inspect() { return []; } },
    anchors: { async matchedPatterns() { return []; } },
    foundation,
    profiles: { async read() { return profile; } }
  });
  await assert.rejects(
    protocol.find({ consumerRoot: ".", profilePath: "architecture/foundation/docs-protocol.yaml", query: {} }),
    /schemaVersion must be 2/u
  );
  assert.equal(queried, false);
});

test("direct API rejects invalid relation filters and bounded authoring collections", async () => {
  const { protocol, calls } = harness();
  await assert.rejects(
    protocol.find({ consumerRoot: ".", profilePath: "architecture/foundation/docs-protocol.yaml", query: { related: " ADR-0001" } }),
    /canonical document ID/u
  );
  assert.equal(calls.find, 0);

  const base = {
    apply: false,
    consumerRoot: ".",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    intent: { type: "adr", id: "ADR-0083", title: "Tenant isolation", owner: "architecture/tooling", summary: "Defines tenant isolation." }
  };
  await assert.rejects(protocol.newDocument({ ...base, related: Array.from({ length: 257 }, (_value, index) => `ADR-${String(index).padStart(4, "0")}`) }), /exceeds 256/u);
  await assert.rejects(protocol.newDocument({ ...base, codeAnchors: Array.from({ length: 257 }, (_value, index) => ({ pattern: `src/file-${index}.ts`, enforcement: "required" })) }), /exceeds 256/u);
  const oversizedMetadata = Object.fromEntries(Array.from({ length: 10_001 }, (_value, index) => [`key_${index}`, index]));
  await assert.rejects(protocol.newDocument({ ...base, additionalMetadata: oversizedMetadata }), /exceeds 10000/u);
  const sparse = [];
  sparse.length = 2;
  sparse[1] = "present";
  await assert.rejects(protocol.newDocument({ ...base, additionalMetadata: { sparse } }), /sparse/u);
  const accessor = {};
  Object.defineProperty(accessor, "computed", { enumerable: true, get() { return "value"; } });
  await assert.rejects(protocol.newDocument({ ...base, additionalMetadata: accessor }), /data property/u);
  assert.equal(calls.plan.length, 0);
});

test("new fails authority-stale across profile and blocker-status races without applying or advising an index", async () => {
  const initialDescription = { authority: { templates: [] }, projectId: "fixture-project", profileSchemaVersion: 2, semanticDigest: PROFILE_SEMANTIC_DIGEST, metadataSchemaPath: "docs/metadata.schema.json", metadataSidecar: { kind: "none" }, ownerIds: ["architecture/tooling"], types, authorityPaths: [] };
  const changedDescription = { ...initialDescription, semanticDigest: `sha256:${"8".repeat(64)}`, types: [{ ...types[0], initialStatus: "accepted", reachability: { kind: "not-required", reason: "changed" } }] };
  const baseCatalog = { projectId: "fixture-project", status: "complete", diagnostics: [], documents: [{ ...descriptor({ id: "OD-001", type: "open-decision", status: "open", repositoryPath: "docs/open-decisions/OD-001.md" }), metadata: {} }], identityProjection: [], ownerIds: ["architecture/tooling"], authority: {}, semanticDigest: CATALOG_SEMANTIC_DIGEST };
  const changedCatalog = { ...baseCatalog, semanticDigest: `sha256:${"9".repeat(64)}`, documents: [{ ...baseCatalog.documents[0], status: "resolved" }] };
  const { protocol, calls } = harness({ descriptions: [initialDescription, changedDescription], catalogs: [baseCatalog, changedCatalog] });
  const result = await protocol.newDocument({
    apply: true,
    consumerRoot: ".",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    intent: { type: "adr", id: "ADR-0083", title: "Tenant isolation", owner: "architecture/tooling", summary: "Defines tenant isolation." },
    blockedBy: ["OD-001"]
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
    summary: "Defines tenant isolation."
  });
  mismatchedPlan.authority.profileSemanticDigest = `sha256:${"8".repeat(64)}`;
  mismatchedPlan.authority.catalogPreimageSemanticDigest = `sha256:${"9".repeat(64)}`;
  const { protocol, calls } = harness({ plan: mismatchedPlan });
  const result = await protocol.newDocument({
    apply: true,
    consumerRoot: ".",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    intent: { type: "adr", id: "ADR-0083", title: "Tenant isolation", owner: "architecture/tooling", summary: "Defines tenant isolation." }
  });
  assert.equal(result.envelope.outcome, "authority-stale");
  assert.equal(calls.apply, 0);
});

test("doctor preserves transaction diagnostics and recover ignores mutable profiles", async () => {
  let profileReads = 0;
  let transactionFormat = "document-authoring-envelope-v3";
  const recoveryReceipt = {
    schemaVersion: 2,
    protocolVersion: 2,
    planDigest: `sha256:${"3".repeat(64)}`,
    adapter: { id: "foundation.filesystem/v1", contractVersion: 1 },
    destination: "docs/decisions/generated/0002-recovery.md",
    outcome: "applied",
    resultDigest: `sha256:${"4".repeat(64)}`,
    commit: { state: "committed", publication: "published", fileAtomicity: "single-file-atomic-create", recoverability: "not-required" },
    directoryMaterialization: { state: "created-and-retained", plannedDirectories: ["docs/decisions/generated"], observedCreatedDirectories: ["docs/decisions/generated"] },
    diagnostics: [],
    receiptDigest: `sha256:${"5".repeat(64)}`
  };
  const foundation = {
    async inspectEnvironment() {
      return { installedFoundationVersion: "0.17.0-rc.0", installedFoundationBuildIdentity: `sha256:${"1".repeat(64)}`, filesystem: { basis: "platform-contract", strictDirectoryDurability: "platform-supported" } };
    },
    async inspect() {
      return { schemaVersion: 2, state: "recoverable", operationKind: "document-authoring", format: transactionFormat, foundationVersion: "0.17.0-rc.0", foundationBuildIdentity: `sha256:${"1".repeat(64)}`, recovery: { commandId: "docs-recover", exactFoundationVersion: "0.17.0-rc.0", exactFoundationBuildIdentity: `sha256:${"1".repeat(64)}` }, diagnostics: [] };
    },
    async recover() { return recoveryReceipt; }
  };
  const protocol = new DocsProtocol({
    adoption: { async inspect() { return []; } },
    anchors: { async matchedPatterns() { return []; } },
    foundation,
    profiles: { async read() { profileReads += 1; throw new Error("corrupt profile"); } }
  });
  const doctor = await protocol.doctor({ consumerRoot: ".", profilePath: "architecture/foundation/docs-protocol.yaml" });
  assert.equal(doctor.envelope.outcome, "recovery-required");
  assert.equal(doctor.envelope.result.transaction.state, "recoverable");
  assert.match(doctor.envelope.diagnostics[0].message, /corrupt profile/u);

  transactionFormat = "document-authoring-envelope-v4";
  const v4Doctor = await protocol.doctor({ consumerRoot: ".", profilePath: "architecture/foundation/docs-protocol.yaml" });
  assert.equal(v4Doctor.envelope.result.transaction.state, "recoverable");

  const recovered = await protocol.recover({ consumerRoot: ".", profilePath: "architecture/foundation/docs-protocol.yaml" });
  assert.equal(recovered.exitCode, 0);
  assert.equal(recovered.envelope.result.writeState, "committed");
  assert.equal(recovered.envelope.result.receipt.commit.publication, "published");
  assert.equal(profileReads, 2, "recover must not reread mutable profiles after either doctor inspection");
});
