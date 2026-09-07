import assert from "node:assert/strict";
import test from "node:test";

import { harness } from "./docs-protocol.test.mjs";
test("new dry-run returns planDigest for caller to use as expectedPlanDigest", async () => {
  const { protocol } = harness();
  const result = await protocol.newDocumentV2({
    apply: false,
    consumerRoot: ".",
    profilePath: "docs/docs-protocol.json",
    intent: { type: "adr", id: "ADR-0083", title: "Tenant isolation", owner: "architecture/tooling", summary: "Defines tenant isolation." }
  });
  assert.equal(result.envelope.result.writeState, "preview");
  assert.match(result.envelope.result.planDigest, /^sha256:[0-9a-f]{64}$/u);
});

test("new apply with matching expectedPlanDigest succeeds", async () => {
  const { protocol, calls } = harness();
  const correctDigest = `sha256:${"3".repeat(64)}`;
  const result = await protocol.newDocumentV2({
    apply: true,
    consumerRoot: ".",
    profilePath: "docs/docs-protocol.json",
    intent: { type: "adr", id: "ADR-0083", title: "Tenant isolation", owner: "architecture/tooling", summary: "Defines tenant isolation." },
    expectedPlanDigest: correctDigest
  });
  assert.equal(result.envelope.outcome, "success");
  assert.equal(result.envelope.result.writeState, "applied");
  assert.equal(calls.apply, 1);
});

test("new apply with mismatched expectedPlanDigest returns authority-stale without mutating", async () => {
  const { protocol, calls } = harness();
  const wrongDigest = `sha256:${"f".repeat(64)}`;
  const result = await protocol.newDocumentV2({
    apply: true,
    consumerRoot: ".",
    profilePath: "docs/docs-protocol.json",
    intent: { type: "adr", id: "ADR-0083", title: "Tenant isolation", owner: "architecture/tooling", summary: "Defines tenant isolation." },
    expectedPlanDigest: wrongDigest
  });
  assert.equal(result.envelope.outcome, "authority-stale");
  assert.equal(result.envelope.result.writeState, "blocked");
  assert.equal(result.envelope.result.reason, "authority-stale");
  assert.equal(result.envelope.diagnostics[0].ruleId, "docs.new.plan-digest-mismatch");
  assert.equal(calls.apply, 0);
});

test("new apply without expectedPlanDigest is backward-compatible", async () => {
  const { protocol, calls } = harness();
  const result = await protocol.newDocumentV2({
    apply: true,
    consumerRoot: ".",
    profilePath: "docs/docs-protocol.json",
    intent: { type: "adr", id: "ADR-0083", title: "Tenant isolation", owner: "architecture/tooling", summary: "Defines tenant isolation." }
  });
  assert.equal(result.envelope.outcome, "success");
  assert.equal(result.envelope.result.writeState, "applied");
  assert.equal(calls.apply, 1);
});

