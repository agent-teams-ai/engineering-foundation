import assert from "node:assert/strict";
import test from "node:test";
import { parseDocsProtocolProfile } from "../dist/features/portable-documentation/application/profile-policy.js";
import { types, PROFILE_SEMANTIC_DIGEST, CATALOG_SEMANTIC_DIGEST, taskVocabularyProfile, descriptor, harness, plan } from "./fixtures/protocol-harness.mjs";

test("reviewed new apply rejects a stale or malformed expected Plan digest without effects", async () => {
  const base = {
    apply: true,
    consumerRoot: ".",
    profilePath: "docs/docs-protocol.json",
    intent: { type: "adr", id: "ADR-0083", title: "Tenant isolation", owner: "architecture/tooling", summary: "Defines tenant isolation." }
  };
  const staleHarness = harness();
  const stale = await staleHarness.protocol.newDocumentV2({ ...base, expectedPlanDigest: `sha256:${"9".repeat(64)}` });
  assert.equal(stale.envelope.outcome, "authority-stale");
  assert.equal(stale.envelope.result.writeState, "blocked");
  assert.equal(staleHarness.calls.apply, 0);

  const malformedHarness = harness();
  const malformed = await malformedHarness.protocol.newDocumentV2({ ...base, expectedPlanDigest: "sha256:not-a-digest" });
  assert.equal(malformed.envelope.outcome, "invalid-input");
  assert.deepEqual(malformed.envelope.result, {});
  assert.equal(malformedHarness.calls.plan.length, 0);
  assert.equal(malformedHarness.calls.apply, 0);
});

test("portable v4 vocabulary accepts task/todo blockers and rejects blockers on done subjects", async () => {
  const parsedProfile = parseDocsProtocolProfile(taskVocabularyProfile);
  const taskType = { ...types[0], type: "task", initialStatus: "todo" };
  const taskCatalog = {
    projectId: "fixture-project", status: "complete", diagnostics: [],
    documents: [{ ...descriptor({ id: "TASK-001", type: "task", status: "todo" }), metadata: {} }],
    identityProjection: [], ownerIds: ["architecture/tooling"], authority: {}, semanticDigest: CATALOG_SEMANTIC_DIGEST
  };
  const description = {
    authority: { templates: [] }, catalog: { collections: [], excludedPrefixes: [] },
    projectId: "fixture-project", profileSchemaVersion: 3, semanticDigest: PROFILE_SEMANTIC_DIGEST,
    metadataSchemaPath: "docs/metadata.schema.json", metadataSidecar: { kind: "none" },
    ownerIds: ["architecture/tooling"], types: [taskType], authorityPaths: []
  };
  const previewHarness = harness({ profile: parsedProfile, descriptions: [description, description], catalogs: [taskCatalog, taskCatalog] });
  const preview = await previewHarness.protocol.newDocumentV2({
    apply: false, consumerRoot: ".", profilePath: "docs.config.yaml",
    intent: { type: "task", id: "TASK-002", title: "Portable task", owner: "architecture/tooling", summary: "Exercises consumer vocabulary." },
    blockedBy: ["TASK-001"]
  });
  assert.equal(preview.envelope.outcome, "success");
  assert.deepEqual(previewHarness.calls.plan[0].intent.related, ["TASK-001"]);

  const doneDocument = { ...descriptor({ id: "TASK-002", type: "task", status: "done" }), metadata: { related: ["TASK-001"], blocked_by: ["TASK-001"] } };
  const corpus = { ...taskCatalog, documents: [taskCatalog.documents[0], doneDocument] };
  const checkHarness = harness({ profile: parsedProfile, descriptions: [description], catalogs: [corpus] });
  const checked = await checkHarness.protocol.checkV2({ consumerRoot: ".", profilePath: "docs.config.yaml" });
  assert.equal(checked.envelope.outcome, "violation");
  assert.match(checked.envelope.diagnostics[0].message, /done.*cannot retain blockers/u);
});

const request = {
  consumerRoot: ".", profilePath: "docs.config.yaml",
  intent: { type: "adr", id: "ADR-0083", title: "Tenant isolation", owner: "architecture/tooling", summary: "Defines tenant isolation." }
};
const digest = `sha256:${"3".repeat(64)}`;

function compiledPlan(frontmatter) {
  const compiled = plan(request.intent);
  const content = `---\n${frontmatter}\n---\n# ADR-0083: Tenant isolation\n`;
  return { ...compiled, output: { ...compiled.output, contentBase64: Buffer.from(content).toString("base64"), size: Buffer.byteLength(content) } };
}

test("compiled YAML preserves scalar and nested metadata semantics", async () => {
  const frontmatter = 'id: ADR-0083\nflag: on\ncount: 42\nquoted: "42"\ndate: 2026-09-05\nnested: {items: [null, true, "é"]}\nsummary: |\n  First line\n  Second line';
  const { protocol, calls } = harness({ plan: compiledPlan(frontmatter) });
  const result = await protocol.newDocumentV2({ ...request, apply: false });
  assert.equal(result.envelope.outcome, "success");
  assert.deepEqual(result.envelope.result.compiled.metadata, {
    id: "ADR-0083", flag: "on", count: 42, quoted: "42", date: "2026-09-05",
    nested: { items: [null, true, "é"] }, summary: "First line\nSecond line\n"
  });
  assert.equal(result.envelope.result.compiled.frontmatter, frontmatter);
  assert.equal(calls.apply, 0);
});

test("compiled YAML refuses non-JSON conversion results before preview or apply", async () => {
  for (const frontmatter of ["value: .nan", "nested: [.inf]", "value: !!timestamp 2026-09-05", "nested: {constructor: unsafe}"]) {
    for (const apply of [false, true]) {
      const { protocol, calls } = harness({ plan: compiledPlan(frontmatter) });
      await assert.rejects(protocol.newDocumentV2({ ...request, apply, ...(apply ? { expectedPlanDigest: digest } : {}) }), { name: "DocsProfileError" }, frontmatter);
      assert.equal(calls.apply, 0, frontmatter);
    }
  }
});

test("compiled YAML still refuses duplicate keys, aliases and non-mapping roots", async () => {
  for (const frontmatter of ["value: one\nvalue: two", "value: &shared [one]\ncopy: *shared", "- item", "null"]) {
    const { protocol, calls } = harness({ plan: compiledPlan(frontmatter) });
    await assert.rejects(protocol.newDocumentV2({ ...request, apply: true, expectedPlanDigest: digest }));
    assert.equal(calls.apply, 0, frontmatter);
  }
});

test("reviewed API rejects malformed values and preview approval before any authority reads", async () => {
  const control = harness();
  assert.equal((await control.protocol.newDocumentV2({ ...request, apply: false })).envelope.outcome, "success");
  assert.equal(control.calls.profiles, 2, "positive control proves the read counter observes both authority captures");
  for (const expectedPlanDigest of [null, 42, {}, "", digest.toUpperCase(), `${digest}\n`, "sha256:abc"]) {
    const { calls, protocol } = harness();
    const result = await protocol.newDocumentV2({ ...request, apply: true, expectedPlanDigest });
    assert.equal(result.envelope.outcome, "invalid-input");
    assert.equal(result.exitCode, 2);
    assert.equal(calls.profiles, 0);
    assert.equal(calls.plan.length, 0);
    assert.equal(calls.apply, 0);
  }
  const { calls, protocol } = harness();
  assert.equal((await protocol.newDocumentV2({ ...request, apply: false, expectedPlanDigest: digest })).exitCode, 2);
  assert.equal(calls.profiles, 0);
});

test("matching approval preserves late required anchors, cancellation and authoring authority checks", async () => {
  let reads = 0;
  const anchored = harness({ anchors: { async matchedPatterns({ patterns }) { return reads++ === 0 ? patterns : []; } } });
  const stale = await anchored.protocol.newDocumentV2({
    ...request, apply: true, expectedPlanDigest: digest,
    codeAnchors: [{ pattern: "src/tenant.ts", enforcement: "required" }]
  });
  assert.equal(stale.envelope.outcome, "authority-stale");
  assert.equal(anchored.calls.apply, 0);
  assert.ok(stale.envelope.diagnostics.some(({ ruleId }) => ruleId === "docs.code-anchor.required-stale"));

  const controller = new AbortController();
  reads = 0;
  const cancelled = harness({ anchors: { async matchedPatterns({ patterns }) {
    if (++reads === 2) {controller.abort(new DOMException("cancelled", "AbortError"));}
    return patterns;
  } } });
  await assert.rejects(cancelled.protocol.newDocumentV2({ ...request, apply: true, expectedPlanDigest: digest, signal: controller.signal }), { name: "AbortError" });
  assert.equal(cancelled.calls.apply, 0);

  const source = harness();
  const preview = await source.protocol.newDocumentV2({ ...request, apply: false });
  const wrongAuthorityPlan = { ...source.calls.plan[0], planDigest: preview.envelope.result.planDigest, authority: {} };
  const changed = harness({ plan: wrongAuthorityPlan });
  assert.equal((await changed.protocol.newDocumentV2({ ...request, apply: true, expectedPlanDigest: digest })).envelope.outcome, "authority-stale");
  assert.equal(changed.calls.apply, 0);
});

function vocabularyHarness(policy, subjectStatus = "todo", blockerStatus = "todo", metadata = {}) {
  const profile = parseDocsProtocolProfile({ ...taskVocabularyProfile, relations: { blockers: policy } });
  const description = {
    authority: { templates: [] }, catalog: { collections: [], excludedPrefixes: [] },
    projectId: "fixture-project", profileSchemaVersion: 3, semanticDigest: PROFILE_SEMANTIC_DIGEST,
    metadataSchemaPath: "docs/metadata.schema.json", metadataSidecar: { kind: "none" },
    ownerIds: ["architecture/tooling"], types: [{ ...types[0], initialStatus: subjectStatus }], authorityPaths: []
  };
  const catalog = {
    projectId: "fixture-project", status: "complete", diagnostics: [],
    documents: [
      { ...descriptor({ id: "TASK-001", type: policy.types[0], status: blockerStatus }), metadata: {} },
      { ...descriptor({ id: "TASK-002", type: "task", status: subjectStatus }), metadata }
    ], identityProjection: [], ownerIds: [], authority: {}, semanticDigest: CATALOG_SEMANTIC_DIGEST
  };
  return harness({ profile, descriptions: [description, description], catalogs: [catalog, catalog, catalog] });
}

test("one vocabulary policy governs preview, reviewed apply, direct apply and corpus", async () => {
  for (const policy of [
    { types: ["task"], statuses: ["todo"], subjectIncompatibleStatuses: ["done"] },
    { types: ["open-decision"], statuses: ["deferred", "open"], subjectIncompatibleStatuses: ["accepted", "active"] }
  ]) {
    for (const status of policy.statuses) {
      const h = vocabularyHarness(policy, "proposed", status, { related: ["TASK-001"], blocked_by: ["TASK-001"] });
      assert.equal((await h.protocol.checkV2(request)).envelope.outcome, "success");
      const preview = await h.protocol.newDocumentV2({ ...request, apply: false, blockedBy: ["TASK-001"] });
      assert.equal(preview.envelope.outcome, "success");
      for (const reviewed of [true, false]) {
        const applied = vocabularyHarness(policy, "proposed", status);
        assert.equal((await applied.protocol.newDocumentV2({ ...request, apply: true, blockedBy: ["TASK-001"], ...(reviewed ? { expectedPlanDigest: digest } : {}) })).envelope.outcome, "success");
        assert.equal(applied.calls.apply, 1);
      }
    }
    for (const subjectStatus of policy.subjectIncompatibleStatuses) {
      const h = vocabularyHarness(policy, subjectStatus, policy.statuses[0], { related: ["TASK-001"], blocked_by: ["TASK-001"] });
      assert.equal((await h.protocol.checkV2(request)).envelope.outcome, "violation");
      await assert.rejects(h.protocol.newDocumentV2({ ...request, apply: true, blockedBy: ["TASK-001"] }), /cannot retain blockers/u);
      assert.equal(h.calls.apply, 0);
    }
    const closed = vocabularyHarness(policy, "proposed", "closed", { related: ["TASK-001"], blocked_by: ["TASK-001"] });
    assert.equal((await closed.protocol.checkV2(request)).envelope.outcome, "violation");
    await assert.rejects(closed.protocol.newDocumentV2({ ...request, apply: false, blockedBy: ["TASK-001"] }), /configured blocker/u);
  }
});

test("relation invariants retain missing/self/duplicate checks and binary ordering", async () => {
  const policy = { types: ["task"], statuses: ["todo"], subjectIncompatibleStatuses: ["done"] };
  for (const blockedBy of [["MISSING"], [request.intent.id], ["TASK-001", "TASK-001"]]) {
    const h = vocabularyHarness(policy);
    await assert.rejects(h.protocol.newDocumentV2({ ...request, apply: true, blockedBy }));
    assert.equal(h.calls.plan.length, 0);
  }
  for (const metadata of [
    { blocked_by: ["TASK-001"] },
    { related: ["TASK-002"] },
    { related: ["MISSING"] },
    { related: ["TASK-001", "TASK-001"] }
  ]) {
    const h = vocabularyHarness(policy, "todo", "todo", metadata);
    assert.equal((await h.protocol.checkV2(request)).envelope.outcome, "violation");
  }
  const h = vocabularyHarness(policy);
  await h.protocol.newDocumentV2({ ...request, apply: false, related: ["TASK-002", "TASK-001"], blockedBy: ["TASK-001"] });
  assert.deepEqual(h.calls.plan[0].intent.related, ["TASK-001", "TASK-002"]);
});

test("outer protocol policy changes during compilation block an otherwise matching Plan", async () => {
  const before = parseDocsProtocolProfile(taskVocabularyProfile);
  const after = parseDocsProtocolProfile({ ...taskVocabularyProfile, relations: { blockers: { ...taskVocabularyProfile.relations.blockers, subjectIncompatibleStatuses: ["proposed"] } } });
  const { calls, protocol } = harness({ profiles: [before, after] });
  const result = await protocol.newDocumentV2({ ...request, apply: true, expectedPlanDigest: digest });
  assert.equal(result.envelope.outcome, "authority-stale");
  assert.equal(calls.apply, 0);
});
