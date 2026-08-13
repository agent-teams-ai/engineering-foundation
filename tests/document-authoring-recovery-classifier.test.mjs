import assert from "node:assert/strict";
import test from "node:test";

import { classifyDocumentRecovery } from "../packages/engineering-foundation/dist/document-authoring/application/policies/classify-document-recovery.js";

const absentTemporary = { state: "absent" };
const exactTemporary = { state: "exact", identity: "nonzero" };
const absentDestination = { state: "absent" };

function classify(journal, temporary, destination) {
  return classifyDocumentRecovery({ journal, temporary, destination });
}

test("classifies the no-journal logical entry states", () => {
  const journal = { version: "none", fileIdentity: "none" };
  assert.deepEqual(
    classify(journal, absentTemporary, absentDestination),
    { action: "resume-prepare" },
  );
  assert.deepEqual(
    classify(journal, absentTemporary, { state: "exact", identity: "unbound" }),
    { action: "already-applied", cleanup: "none" },
  );
  assert.deepEqual(
    classify(journal, exactTemporary, absentDestination),
    { action: "manual", reason: "orphan-temporary" },
  );
});

test("preserves every released v1 journal for manual recovery", () => {
  const journal = { version: "v1-legacy", fileIdentity: "nonzero" };
  assert.deepEqual(
    classify(journal, exactTemporary, absentDestination),
    { action: "manual", reason: "legacy-journal" },
  );
  assert.deepEqual(
    classify(journal, absentTemporary, { state: "exact", identity: "unbound" }),
    { action: "manual", reason: "legacy-journal" },
  );
});

test("distinguishes pending and durable-preexisting v2 PREPARED evidence", () => {
  const pending = {
    version: "v2",
    fileIdentity: "nonzero",
    lifecycle: "PREPARED",
    preparedState: "pending",
    boundIdentity: "none",
  };
  assert.deepEqual(
    classify(pending, absentTemporary, absentDestination),
    { action: "resume-prepare" },
  );
  assert.deepEqual(
    classify(pending, exactTemporary, absentDestination),
    { action: "manual", reason: "orphan-temporary" },
  );
  assert.deepEqual(
    classify(pending, absentTemporary, { state: "exact", identity: "unbound" }),
    { action: "manual", reason: "inconsistent-lifecycle" },
  );
  const preexisting = { ...pending, preparedState: "preexisting" };
  assert.deepEqual(
    classify(preexisting, absentTemporary, { state: "exact", identity: "unbound" }),
    { action: "already-applied", cleanup: "none" },
  );
  assert.deepEqual(
    classify(preexisting, absentTemporary, absentDestination),
    { action: "manual", reason: "inconsistent-lifecycle" },
  );
  assert.deepEqual(
    classify(preexisting, exactTemporary, { state: "exact", identity: "unbound" }),
    { action: "manual", reason: "orphan-temporary" },
  );
});

test("resumes v2 PUBLISHING only from the exact bound temporary", () => {
  const journal = {
    version: "v2",
    fileIdentity: "nonzero",
    lifecycle: "PUBLISHING",
    boundIdentity: "temporary",
  };
  assert.deepEqual(
    classify(journal, exactTemporary, absentDestination),
    { action: "resume-publish" },
  );
  assert.deepEqual(
    classify(journal, absentTemporary, absentDestination),
    { action: "manual", reason: "temporary-missing" },
  );
  assert.deepEqual(
    classify(
      journal,
      absentTemporary,
      { state: "exact", identity: "bound-temporary" },
    ),
    { action: "complete-publication" },
  );
  assert.deepEqual(
    classify(journal, exactTemporary, { state: "exact", identity: "different" }),
    { action: "manual", reason: "identity-drift" },
  );
  assert.deepEqual(
    classify(
      journal,
      { state: "replaced", identity: "nonzero" },
      { state: "exact", identity: "different" },
    ),
    { action: "manual", reason: "identity-drift" },
  );
  assert.deepEqual(
    classify(
      journal,
      { state: "replaced", identity: "nonzero" },
      { state: "exact", identity: "bound-temporary" },
    ),
    { action: "manual", reason: "identity-drift" },
  );
});

test("finalizes v2 PUBLISHED only with the stored publication identity", () => {
  const journal = {
    version: "v2",
    fileIdentity: "nonzero",
    lifecycle: "PUBLISHED",
    boundIdentity: "publication",
  };
  assert.deepEqual(
    classify(
      journal,
      absentTemporary,
      { state: "exact", identity: "bound-publication" },
    ),
    { action: "finalize-checks" },
  );
  assert.deepEqual(
    classify(journal, absentTemporary, absentDestination),
    { action: "manual", reason: "publication-missing" },
  );
  assert.deepEqual(
    classify(journal, absentTemporary, { state: "exact", identity: "different" }),
    { action: "manual", reason: "identity-drift" },
  );
});

test("all zero physical identities fail closed before phase classification", () => {
  const prepared = {
    version: "v2",
    fileIdentity: "nonzero",
    lifecycle: "PREPARED",
    preparedState: "pending",
    boundIdentity: "none",
  };
  const publishing = {
    version: "v2",
    fileIdentity: "nonzero",
    lifecycle: "PUBLISHING",
    boundIdentity: "temporary",
  };
  const published = {
    version: "v2",
    fileIdentity: "nonzero",
    lifecycle: "PUBLISHED",
    boundIdentity: "publication",
  };
  assert.deepEqual(
    classify(
      { ...prepared, fileIdentity: "zero-identity" },
      absentTemporary,
      absentDestination,
    ),
    { action: "manual", reason: "zero-identity" },
  );
  assert.deepEqual(
    classify(publishing, { state: "unverifiable" }, absentDestination),
    { action: "manual", reason: "unverifiable-identity" },
  );
  assert.deepEqual(
    classify(
      { ...publishing, boundIdentity: "unverifiable" },
      exactTemporary,
      absentDestination,
    ),
    { action: "manual", reason: "unverifiable-identity" },
  );
  assert.deepEqual(
    classify(
      { ...publishing, boundIdentity: "zero-identity" },
      exactTemporary,
      absentDestination,
    ),
    { action: "manual", reason: "zero-identity" },
  );
  assert.deepEqual(
    classify(publishing, { state: "zero-identity" }, absentDestination),
    { action: "manual", reason: "zero-identity" },
  );
  assert.deepEqual(
    classify(
      published,
      absentTemporary,
      { state: "exact", identity: "zero-identity" },
    ),
    { action: "manual", reason: "zero-identity" },
  );
});

test("the finite observation product always returns a closed action", () => {
  const journals = [
    { version: "none", fileIdentity: "none" },
    { version: "v1-legacy", fileIdentity: "nonzero" },
    {
      version: "v2",
      fileIdentity: "nonzero",
      lifecycle: "PREPARED",
      preparedState: "pending",
      boundIdentity: "none",
    },
    {
      version: "v2",
      fileIdentity: "nonzero",
      lifecycle: "PREPARED",
      preparedState: "preexisting",
      boundIdentity: "none",
    },
    {
      version: "v2",
      fileIdentity: "nonzero",
      lifecycle: "PUBLISHING",
      boundIdentity: "temporary",
    },
    {
      version: "v2",
      fileIdentity: "nonzero",
      lifecycle: "PUBLISHED",
      boundIdentity: "publication",
    },
  ];
  const temporaries = [
    absentTemporary,
    exactTemporary,
    { state: "replaced", identity: "nonzero" },
    { state: "zero-identity" },
    { state: "unverifiable" },
  ];
  const destinations = [
    absentDestination,
    { state: "conflict" },
    { state: "unverifiable" },
    ...[
      "unbound",
      "bound-temporary",
      "bound-publication",
      "different",
      "zero-identity",
    ].map((identity) => ({ state: "exact", identity })),
  ];
  const actions = new Set([
    "resume-prepare",
    "resume-publish",
    "complete-publication",
    "finalize-checks",
    "already-applied",
    "manual",
  ]);

  for (const journal of journals) {
    for (const temporary of temporaries) {
      for (const destination of destinations) {
        const decision = classify(journal, temporary, destination);
        assert.ok(actions.has(decision.action));
      }
    }
  }
});
