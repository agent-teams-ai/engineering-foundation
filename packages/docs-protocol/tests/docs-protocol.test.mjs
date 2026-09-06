import { DocsProtocol } from "../dist/features/portable-documentation/application/docs-protocol.js";
import { YamlCompiledOutputReader } from "../dist/features/portable-documentation/adapters/outbound/yaml-compiled-output-reader.js";
import { createCommunityMiniSearchIndex } from "../dist/features/portable-documentation/adapters/outbound/minisearch-adapter.js";
import assert from "node:assert/strict";
import test from "node:test";

import { createDocsProtocolApi } from "../dist/features/docs-command/adapters/inbound/protocol-api.js";

import { profile, types, PROFILE_SEMANTIC_DIGEST, CATALOG_SEMANTIC_DIGEST, descriptor, plan, harness } from "./fixtures/protocol-harness.mjs";

test("find applies relation filters with AND and stable zero-match success", async () => {
  const { protocol } = harness();
  const found = await protocol.findV2({ consumerRoot: ".", profilePath: "docs/docs-protocol.json", query: { type: "adr", related: "ADR-0001", blockedBy: "ADR-0003" } });
  assert.equal(found.exitCode, 0);
  assert.deepEqual(found.envelope.result.documents.map(({ id }) => id), ["ADR-0002"]);
  const empty = await protocol.findV2({ consumerRoot: ".", profilePath: "docs/docs-protocol.json", query: { related: "ADR-9999" } });
  assert.equal(empty.exitCode, 0);
  assert.equal(empty.envelope.result.matches, 0);
});

test("new preview is non-mutating and preserves unified metadata vocabulary", async () => {
  const { protocol, calls } = harness();
  const result = await protocol.newDocumentV2({
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

test("current protocol methods expose portable v3 profile evidence without legacy wrappers", async () => {
  const current = harness().protocol;
  const request = {
    apply: false, consumerRoot: ".", profilePath: "docs/docs-protocol.json",
    intent: { type: "adr", id: "ADR-0083", title: "Tenant isolation", owner: "architecture/tooling", summary: "Defines tenant isolation." }
  };
  const [richInfo, richNew] = await Promise.all([
    current.infoV2(request), current.newDocumentV2(request)
  ]);

  for (const method of ["info", "find", "newDocument", "doctor", "recover", "check"]) {
    assert.equal(typeof current[method], "undefined");
  }
  assert.equal(richInfo.envelope.schemaVersion, 2);
  assert.deepEqual(richInfo.envelope.result.foundationProfile, {
    metadataSidecarPolicy: "foundation-profile-v3-strict-merge",
    path: "architecture/foundation/document-authoring.yaml",
    schemaVersion: 3
  });
  assert.deepEqual(["authority", "authorityPaths", "catalog"].map((key) => Object.hasOwn(richInfo.envelope.result, key)), [true, true, true]);
  assert.deepEqual(richInfo.envelope.result.authority, { templates: [] });
  assert.deepEqual(richInfo.envelope.result.catalog, { collections: [], excludedPrefixes: [] });
  assert.equal(richNew.envelope.schemaVersion, 2);
  assert.equal(richNew.envelope.result.compiled.document.content.includes("# ADR-0083: Tenant isolation"), true);
});

test("new omits semantically empty optional metadata identically for preview and apply", async () => {
  const base = { consumerRoot: ".", profilePath: "docs/docs-protocol.json", intent: { type: "adr", id: "ADR-0083", title: "Tenant isolation", owner: "architecture/tooling", summary: "Defines tenant isolation." } };
  const previewHarness = harness();
  const applyHarness = harness();
  const preview = await previewHarness.protocol.newDocumentV2({
    ...base,
    apply: false,
    related: [],
    blockedBy: [],
    codeAnchors: []
  });
  const applied = await applyHarness.protocol.newDocumentV2({ ...base, apply: true });

  assert.deepEqual([preview.exitCode, applied.exitCode], [0, 0]);
  assert.equal(JSON.stringify(previewHarness.calls.plan[0].intent), JSON.stringify(applyHarness.calls.plan[0].intent));
  assert.equal(preview.envelope.result.planDigest, applied.envelope.result.planDigest);
  assert.equal("related" in previewHarness.calls.plan[0].intent, false);
  assert.equal("additionalMetadata" in previewHarness.calls.plan[0].intent, false);
});

test("new rejects optional metadata aliases even when callers try to inject empty arrays", async () => {
  for (const key of ["related", "blocked_by", "code_anchors"]) {
    const { protocol, calls } = harness();
    await assert.rejects(protocol.newDocumentV2({
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
    await assert.rejects(protocol.newDocumentV2({
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
    const result = await protocol.newDocumentV2({
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
    async describe() { return { authority: {}, projectId: "fixture-project", profileSchemaVersion: 3, metadataSchemaPath: "docs/metadata.schema.json", metadataSidecar: { kind: "none" }, ownerIds: ["architecture/tooling"], types, authorityPaths: [] }; },
    async buildCatalog() { return { projectId: "fixture-project", status: "complete", diagnostics: [], documents: [{ ...descriptor(), metadata: { related: ["ADR-9999"] } }], identityProjection: [], ownerIds: [], authority: {} }; },
    async inspect() { return { schemaVersion: 1, state: "idle", diagnostics: [] }; },
    async find() { return []; }, async plan() { throw new Error("not used"); }, async apply() { throw new Error("not used"); }, async recover() { throw new Error("not used"); }
  };
  const checked = await createDocsProtocolApi(new DocsProtocol({ compiledOutput: new YamlCompiledOutputReader(), searchIndex: createCommunityMiniSearchIndex(), adoption: { async inspect() { return []; } }, anchors: { async matchedPatterns({ patterns }) { return patterns; } }, foundation: badFoundation, profiles: { async read() { return profile; } } })).checkV2({ consumerRoot: ".", profilePath: "architecture/foundation/docs-protocol.yaml" });
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
    intent: { type: "adr", id: "ADR-0083", title: "Tenant isolation", owner: "architecture/tooling", summary: "Defines tenant isolation." }
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.envelope.result.writeState, "applied");
  assert.equal(calls.apply, 1);
});

test("new withholds reachability when the published catalog misses the expected postimage", async () => {
  const { protocol, calls } = harness({ catalogs: [undefined, undefined, { semanticDigest: `sha256:${"8".repeat(64)}` }] });
  const result = await protocol.newDocumentV2({
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
  const result = await protocol.newDocumentV2({
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
  const advisory = await harness({ matchedPatterns: [] }).protocol.newDocumentV2({
    ...base,
    codeAnchors: [{ pattern: "src/advisory.ts", enforcement: "advisory" }]
  });
  assert.equal(advisory.exitCode, 0);
  assert.equal(advisory.envelope.diagnostics[0].severity, "warning");
  assert.equal(advisory.envelope.diagnostics[0].ruleId, "docs.code-anchor.advisory-unmatched");
  await assert.rejects(
    harness({ matchedPatterns: [] }).protocol.newDocumentV2({ ...base, codeAnchors: [{ pattern: "src/required.ts", enforcement: "required" }] }),
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
  const result = await protocol.newDocumentV2({
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
  const result = await protocol.newDocumentV2({
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
  const result = await protocol.checkV2({ consumerRoot: ".", profilePath: "architecture/foundation/docs-protocol.yaml" });
  assert.equal(observedPatterns, 1_024);
  assert.equal(result.envelope.outcome, "violation");
  assert.equal(result.envelope.diagnostics.filter(({ ruleId }) => ruleId === "docs.code-anchor.corpus-budget-exceeded").length, 1);
  assert.ok(result.envelope.diagnostics.length <= 256);
});

test("find binds the referenced current Foundation profile before querying", async () => {
  let queried = false;
  const foundation = {
    async describe() { throw new Error("Foundation authoring profile schemaVersion must be 3"); },
    async find() { queried = true; return []; }
  };
  const protocol = createDocsProtocolApi(new DocsProtocol({ compiledOutput: new YamlCompiledOutputReader(), searchIndex: createCommunityMiniSearchIndex(),
    adoption: { async inspect() { return []; } },
    anchors: { async matchedPatterns() { return []; } },
    foundation,
    profiles: { async read() { return profile; } }
  }));
  await assert.rejects(
    protocol.findV2({ consumerRoot: ".", profilePath: "architecture/foundation/docs-protocol.yaml", query: {} }),
    /schemaVersion must be 3/u
  );
  assert.equal(queried, false);
});

test("direct API rejects invalid relation filters and bounded authoring collections", async () => {
  const { protocol, calls } = harness();
  await assert.rejects(
    protocol.findV2({ consumerRoot: ".", profilePath: "architecture/foundation/docs-protocol.yaml", query: { related: " ADR-0001" } }),
    /canonical document ID/u
  );
  assert.equal(calls.find, 0);

  const base = {
    apply: false,
    consumerRoot: ".",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    intent: { type: "adr", id: "ADR-0083", title: "Tenant isolation", owner: "architecture/tooling", summary: "Defines tenant isolation." }
  };
  await assert.rejects(protocol.newDocumentV2({ ...base, related: Array.from({ length: 257 }, (_value, index) => `ADR-${String(index).padStart(4, "0")}`) }), /exceeds 256/u);
  await assert.rejects(protocol.newDocumentV2({ ...base, codeAnchors: Array.from({ length: 257 }, (_value, index) => ({ pattern: `src/file-${index}.ts`, enforcement: "required" })) }), /exceeds 256/u);
  const oversizedMetadata = Object.fromEntries(Array.from({ length: 10_001 }, (_value, index) => [`key_${index}`, index]));
  await assert.rejects(protocol.newDocumentV2({ ...base, additionalMetadata: oversizedMetadata }), /exceeds 10000/u);
  const sparse = [];
  sparse.length = 2;
  sparse[1] = "present";
  await assert.rejects(protocol.newDocumentV2({ ...base, additionalMetadata: { sparse } }), /sparse/u);
  const accessor = {};
  Object.defineProperty(accessor, "computed", { enumerable: true, get() { return "value"; } });
  await assert.rejects(protocol.newDocumentV2({ ...base, additionalMetadata: accessor }), /data property/u);
  assert.equal(calls.plan.length, 0);
});

test("new fails authority-stale across profile and blocker-status races without applying or advising an index", async () => {
  const initialDescription = { authority: { templates: [] }, projectId: "fixture-project", profileSchemaVersion: 3, semanticDigest: PROFILE_SEMANTIC_DIGEST, metadataSchemaPath: "docs/metadata.schema.json", metadataSidecar: { kind: "none" }, ownerIds: ["architecture/tooling"], types, authorityPaths: [] };
  const changedDescription = { ...initialDescription, semanticDigest: `sha256:${"8".repeat(64)}`, types: [{ ...types[0], initialStatus: "accepted", reachability: { kind: "not-required", reason: "changed" } }] };
  const baseCatalog = { projectId: "fixture-project", status: "complete", diagnostics: [], documents: [{ ...descriptor({ id: "OD-001", type: "open-decision", status: "open", repositoryPath: "docs/open-decisions/OD-001.md" }), metadata: {} }], identityProjection: [], ownerIds: ["architecture/tooling"], authority: {}, semanticDigest: CATALOG_SEMANTIC_DIGEST };
  const changedCatalog = { ...baseCatalog, semanticDigest: `sha256:${"9".repeat(64)}`, documents: [{ ...baseCatalog.documents[0], status: "resolved" }] };
  const { protocol, calls } = harness({ descriptions: [initialDescription, changedDescription], catalogs: [baseCatalog, changedCatalog] });
  const result = await protocol.newDocumentV2({
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
  const result = await protocol.newDocumentV2({
    apply: true,
    consumerRoot: ".",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    intent: { type: "adr", id: "ADR-0083", title: "Tenant isolation", owner: "architecture/tooling", summary: "Defines tenant isolation." }
  });
  assert.equal(result.envelope.outcome, "authority-stale");
  assert.equal(calls.apply, 0);
});


test("compiled preview uses injected output decoding before pure projection", async () => {
  let observed;
  const { protocol } = harness({ compiledOutput: { read(output) {
    observed = output;
    return { content: "provider-decoded content", frontmatter: "id: ADR-0083", metadata: { id: "ADR-0083" } };
  } } });
  const result = await protocol.newDocumentV2({
    apply: false, consumerRoot: ".", profilePath: "docs.config.yaml",
    intent: { type: "adr", id: "ADR-0083", title: "Tenant isolation", owner: "architecture/tooling", summary: "Defines tenant isolation." }
  });
  assert.equal(result.envelope.result.compiled.document.content, "provider-decoded content");
  assert.equal(observed.digest, plan({}).output.digest);
  assert.deepEqual(result.envelope.result.compiled.metadata, { id: "ADR-0083" });
});

const output = (content) => ({ contentBase64: Buffer.from(content).toString("base64"), digest: `sha256:${"8".repeat(64)}`, mediaType: "text/markdown; charset=utf-8", size: Buffer.byteLength(content) });

test("compiled output parser and pure projection preserve canonical bytes and diagnostics", async () => {
  const { compiledDocument } = await import("../dist/features/portable-documentation/application/compiled-document.js");
  const reader = new YamlCompiledOutputReader();
  const input = { anchors: [{ enforcement: "required", pattern: "src/*.ts" }], blockedBy: ["TASK-1"], related: ["TASK-1"] };
  const content = "---\nid: ADR-1\ncustom: {list: [one, 2, true]}\n---\n# Body\n";
  const bytes = output(content);
  const projected = compiledDocument(bytes, reader.read(bytes), input);
  assert.deepEqual(projected, {
    schemaVersion: 1, document: { content, digest: bytes.digest, mediaType: bytes.mediaType, size: bytes.size },
    frontmatter: "id: ADR-1\ncustom: {list: [one, 2, true]}", metadata: { id: "ADR-1", custom: { list: ["one", 2, true] } },
    anchors: input.anchors, relations: { blockedBy: input.blockedBy, related: input.related }
  });
  const cases = [
    ["missing", "DocsProfileError", "Compiled document does not contain canonical frontmatter."],
    ["---\nid: [\n---\nbody", "DocsProfileError", "Compiled document frontmatter is not valid duplicate-free YAML."],
    ["---\nid: first\nid: second\n---\nbody", "DocsProfileError", "Compiled document frontmatter is not valid duplicate-free YAML."],
    ["---\nx: &x one\ny: *x\n---\nbody", "ReferenceError", "Alias resolution is disabled"],
    ["---\n- a\n---\nbody", "DocsProfileError", "Compiled document frontmatter must be one metadata mapping."]
  ];
  for (const [source, name, message] of cases) {
    assert.throws(() => reader.read(output(source)), { name, message });
  }
  assert.throws(() => reader.read({ ...bytes, size: undefined }), { name: "DocsProfileError", message: "Document Plan does not contain one complete compiled output." });
  assert.throws(() => compiledDocument(bytes, { content, frontmatter: "", metadata: { value: "x".repeat(1_048_577) } }, input), /1 MiB JSON budget/u);
  assert.throws(() => compiledDocument(bytes, { content, frontmatter: "", metadata: { value: -0 } }, input), /safe integers/u);
});
