import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { canonicalJson, CanonicalJsonError, sha256Bytes, sha256Json, parseStrictJson, StrictJsonError } from "../packages/repository-mutation/dist/index.js";
import {
  assertDocumentPlanDigests,
  assertDocumentReceiptDigest,
  documentIdentityProjectionDigest,
  documentIntentDigest,
  documentOwnerMembershipDigest,
  documentPlanDigest,
  documentReceiptDigest,
  documentReferencedDocumentDigest,
} from "../packages/document-authoring/dist/document-authoring/application/policies/document-contract-digests.js";
import {
  documentTemporaryPath,
} from "../packages/document-authoring/dist/document-authoring/application/policies/document-temporary-path.js";
import { assertSchema } from "../packages/document-authoring/dist/document-authoring/adapters/node/schema-catalog.js";

import { createDocumentEnvelopeV3 } from "./fixtures/document-authoring-envelope-v3.mjs";
import { readHistoricalSchema } from "./support/historical-schema-fixtures.mjs";
import { Ajv2020 } from "ajv/dist/2020.js";

const fixturePath = fileURLToPath(
  new URL("fixtures/document-authoring-contracts/valid-v1.json", import.meta.url),
);
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const neutralCanonicalJson = canonicalJson;

function clone(value) {
  return structuredClone(value);
}

function bodyWithout(value, key) {
  return Object.fromEntries(
    Object.entries(value).filter(([entryKey]) => entryKey !== key),
  );
}

function documentEnvelope(state = "PREPARED") {
  return createDocumentEnvelopeV3(fixture, state);
}

async function rejectsSchema(schemaId, value) {
  await assert.rejects(
    assertSchema(schemaId, value, "document-authoring-contract-test"),
    (error) => error?.problem?.code === "SCHEMA_INVALID",
  );
}

test("accepts every document authoring v1 contract fixture", async () => {
  await assertSchema("document-authoring-profile/v1", fixture.profile, "profile");
  await assertSchema("document-intent/v1", fixture.intent, "intent");
  await assertSchema("document-plan/v1", fixture.plan, "plan");
  await assertSchema("document-receipt/v1", fixture.receipt, "receipt");
  await assertSchema(
    "foundation-transaction-envelope/v3",
    documentEnvelope(),
    "transaction-envelope",
  );
  await assertSchema("document-command-envelope/v1", fixture.command, "command");
});

test("applies the same bounded repository path grammar to every public surface", async () => {
  const atLimit = "a".repeat(255);
  const overLimit = "a".repeat(256);
  const surfaces = [
    ["document-authoring-profile/v1", () => {
      const value = clone(fixture.profile);
      value.catalog.metadataSchemaPath = atLimit;
      return [value, (invalid) => { invalid.catalog.metadataSchemaPath = overLimit; }];
    }],
    ["document-intent/v1", () => {
      const value = { ...clone(fixture.intent), destination: atLimit };
      return [value, (invalid) => { invalid.destination = overLimit; }];
    }],
    ["document-plan/v1", () => {
      const value = clone(fixture.plan);
      value.destination = atLimit;
      return [value, (invalid) => { invalid.destination = overLimit; }];
    }],
    ["document-receipt/v1", () => {
      const value = clone(fixture.receipt);
      value.destination = atLimit;
      return [value, (invalid) => { invalid.destination = overLimit; }];
    }],
    ["document-command-envelope/v1", () => {
      const value = {
        schemaVersion: 1,
        command: "docs.new",
        outcome: "success",
        diagnostics: [],
        result: {
          kind: "new",
          documentPath: atLimit,
          reachability: { state: "not-required" },
        },
      };
      return [value, (invalid) => { invalid.result.documentPath = overLimit; }];
    }],
    ["foundation-transaction-envelope/v3", () => {
      const value = documentEnvelope();
      value.journal.plan.destination = atLimit;
      return [value, (invalid) => { invalid.journal.plan.destination = overLimit; }];
    }],
  ];
  for (const [schemaId, makeSurface] of surfaces) {
    const [valid, invalidate] = makeSurface();
    await assertSchema(schemaId, valid, `${schemaId}-path-at-limit`);
    const invalid = clone(valid);
    invalidate(invalid);
    await rejectsSchema(schemaId, invalid);
  }
});

test("bounds temporaries and models the repository root as expected-parent dot", async () => {
  const longBasenamePlan = clone(fixture.plan);
  longBasenamePlan.destination = `docs/${"a".repeat(255)}`;
  longBasenamePlan.expectedParent.path = "docs";
  longBasenamePlan.planDigest = documentPlanDigest(longBasenamePlan);
  assert.equal(
    documentTemporaryPath(
      longBasenamePlan.destination,
      longBasenamePlan.planDigest,
    ),
    `docs/.foundation-document-${longBasenamePlan.planDigest.slice("sha256:".length)}.tmp`,
  );
  assert.doesNotThrow(() => assertDocumentPlanDigests(longBasenamePlan));

  const rootPlan = clone(fixture.plan);
  rootPlan.destination = "decision.md";
  rootPlan.expectedParent.path = ".";
  rootPlan.planDigest = documentPlanDigest(rootPlan);
  assert.equal(
    documentTemporaryPath(rootPlan.destination, rootPlan.planDigest),
    `.foundation-document-${rootPlan.planDigest.slice("sha256:".length)}.tmp`,
  );
  await assertSchema("document-plan/v1", rootPlan, "root-level-plan");
  assert.doesNotThrow(() => assertDocumentPlanDigests(rootPlan));
  for (const path of ["/", ".."]) {
    const invalid = clone(rootPlan);
    invalid.expectedParent.path = path;
    await rejectsSchema("document-plan/v1", invalid);
  }
});

test("rejects a destination parent that cannot contain the bounded temporary", () => {
  const plan = clone(fixture.plan);
  const parent = `${"a".repeat(220)}/${"b".repeat(220)}`;
  plan.destination = `${parent}/x.md`;
  plan.expectedParent.path = parent;
  plan.planDigest = documentPlanDigest(plan);
  assert.throws(
    () => assertDocumentPlanDigests(plan),
    /publication bindings are invalid/u,
  );
});

test("envelope-owned paths enforce the per-segment bound", async () => {
  for (const selectPath of [
    (value) => value.journal.destination,
    (value) => value.journal.ownedTemporary,
  ]) {
    const value = documentEnvelope("PUBLISHING");
    selectPath(value).path = "a".repeat(255);
    await assertSchema(
      "foundation-transaction-envelope/v3",
      value,
      "envelope-path-at-segment-limit",
    );
    selectPath(value).path = "a".repeat(256);
    await rejectsSchema("foundation-transaction-envelope/v3", value);
  }
});

test("schema requires a closed creator-handle identity", async (context) => {
  for (const [name, mutate] of [
    ["missing", (identity) => { delete identity.adapter; }],
    ["forged adapter", (identity) => { identity.adapter = "forged"; }],
    ["non-canonical zero inode", (identity) => { identity.ino = "00"; }],
    ["open shape", (identity) => { identity.extra = "open"; }],
  ]) {
    await context.test(name, async () => {
      const envelope = clone(documentEnvelope("PUBLISHING"));
      mutate(envelope.journal.ownedTemporary.identity);
      await rejectsSchema("foundation-transaction-envelope/v3", envelope);
    });
  }
});

test("freezes canonical JSON and every content-addressed fixture field", () => {
  assert.equal(canonicalJson(fixture.canonical.value), fixture.canonical.json);
  assert.equal(sha256Json(fixture.canonical.value), fixture.canonical.digest);
  assert.equal(documentIntentDigest(fixture.intent), fixture.plan.intentDigest);
  assert.equal(documentPlanDigest(fixture.plan), fixture.plan.planDigest);
  assert.equal(documentReceiptDigest(fixture.receipt), fixture.receipt.receiptDigest);
  assert.doesNotThrow(() => assertDocumentPlanDigests(fixture.plan));
  assert.doesNotThrow(() =>
    assertDocumentReceiptDigest(fixture.receipt, fixture.plan),
  );

  const envelope = documentEnvelope();
  assert.equal(sha256Json(envelope.journal), envelope.payloadDigest);
  assert.equal(
    sha256Json(bodyWithout(envelope, "envelopeDigest")),
    envelope.envelopeDigest,
  );
});

test("detects a same-shape Plan digest tamper", async () => {
  const plan = clone(fixture.plan);
  plan.destination = "docs/decisions/0084-tampered.md";
  await assertSchema("document-plan/v1", plan, "tampered-plan-shape");
  assert.notEqual(
    documentPlanDigest(plan),
    plan.planDigest,
  );
});

test("enforces the frozen per-authority byte budgets", async () => {
  for (const [source, maximum] of [
    ["profile", 1048576],
    ["metadataSchema", 1048576],
    ["ownerCatalog", 1048576],
    ["template", 262144],
  ]) {
    const atLimit = clone(fixture.plan);
    atLimit.authority[source].size = maximum;
    await assertSchema("document-plan/v1", atLimit, `${source}-at-limit`);

    const overLimit = clone(fixture.plan);
    overLimit.authority[source].size = maximum + 1;
    await rejectsSchema("document-plan/v1", overLimit);
  }
});

test("freezes domain-separated document digest preimages", () => {
  const expected = {
    intent: {
      domain: "agent-teams.foundation.document-authoring/intent/v1",
      payload: fixture.intent,
    },
    ownerMembership: {
      domain: "agent-teams.foundation.document-authoring/owner-membership/v1",
      payload: {
        ownerCatalogDigest: fixture.plan.authority.ownerCatalog.digest,
        ownerId: fixture.plan.selectedOwner.id,
      },
    },
    identityProjection: {
      domain: "agent-teams.foundation.document-authoring/identity-projection/v1",
      payload: {
        entries: fixture.identityProjectionEntries,
      },
    },
    referencedDocument: {
      domain: "agent-teams.foundation.document-authoring/referenced-document/v1",
      payload: {
        id: fixture.plan.referencedDocuments[0].id,
        path: fixture.plan.referencedDocuments[0].path,
      },
    },
  };
  assert.deepEqual(fixture.digestPreimages, expected);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(expected).map(([name, preimage]) => [
        name,
        canonicalJson(preimage),
      ]),
    ),
    fixture.digestPreimageCanonicalJson,
  );
  assert.equal(
    documentOwnerMembershipDigest(
      fixture.plan.authority.ownerCatalog.digest,
      fixture.plan.selectedOwner.id,
    ),
    fixture.plan.selectedOwner.membershipDigest,
  );
  assert.equal(
    documentIdentityProjectionDigest(fixture.identityProjectionEntries),
    fixture.plan.identityProjection.digest,
  );
  assert.equal(
    documentReferencedDocumentDigest(fixture.plan.referencedDocuments[0]),
    fixture.plan.referencedDocuments[0].projectionDigest,
  );
});

test("identity projection digest is stable under input permutation", () => {
  assert.equal(
    fixture.plan.identityProjection.entryCount,
    fixture.identityProjectionEntries.length,
  );
  const reversed = fixture.identityProjectionEntries.toReversed();
  assert.equal(
    documentIdentityProjectionDigest(reversed),
    documentIdentityProjectionDigest(fixture.identityProjectionEntries),
  );
});

test("domain separation prevents cross-contract digest substitution", () => {
  const intentDigest = documentIntentDigest(fixture.intent);
  assert.notEqual(intentDigest, documentPlanDigest(fixture.intent));
  assert.notEqual(intentDigest, documentReceiptDigest(fixture.intent));
});

test("neutral canonical JSON rejects executable or ambiguous containers", () => {
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "executed";
    },
  });
  assert.throws(
    () => neutralCanonicalJson(accessor),
    (error) => error instanceof CanonicalJsonError,
  );
  assert.equal(getterCalls, 0);

  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => neutralCanonicalJson(cyclic),
    (error) => error instanceof CanonicalJsonError,
  );
  assert.throws(
    () => neutralCanonicalJson(new Date(0)),
    (error) => error instanceof CanonicalJsonError,
  );
  const sparse = Array(2);
  sparse[1] = "sparse";
  assert.throws(
    () => neutralCanonicalJson(sparse),
    (error) => error instanceof CanonicalJsonError,
  );
  assert.throws(
    () => neutralCanonicalJson({ missing: undefined }),
    (error) => error instanceof CanonicalJsonError,
  );
  assert.equal(
    neutralCanonicalJson(Object.assign(Object.create(null), { safe: true })),
    '{"safe":true}',
  );

  assert.equal(neutralCanonicalJson(-0), "0");
  assert.equal(neutralCanonicalJson("\ud800"), '"\\ud800"');
  assert.equal(neutralCanonicalJson("\udfff"), '"\\udfff"');
  assert.equal(neutralCanonicalJson({ "\ud800": true }), '{"\\ud800":true}');

  const arrayAccessor = ["safe"];
  Object.defineProperty(arrayAccessor, "0", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "executed";
    },
  });
  const symbolicArray = ["safe"];
  symbolicArray[Symbol("extra")] = true;
  const nonEnumerableArray = ["safe"];
  Object.defineProperty(nonEnumerableArray, "extra", { value: true });
  const leadingZeroIndex = ["safe"];
  Object.defineProperty(leadingZeroIndex, "01", {
    enumerable: true,
    value: "ambiguous",
  });
  for (const invalid of [
    arrayAccessor,
    symbolicArray,
    nonEnumerableArray,
    leadingZeroIndex,
  ]) {
    assert.throws(
      () => neutralCanonicalJson(invalid),
      (error) => error instanceof CanonicalJsonError,
    );
  }
  assert.equal(getterCalls, 0);

  const symbolicObject = { safe: true };
  symbolicObject[Symbol("extra")] = true;
  const nonEnumerableObject = { safe: true };
  Object.defineProperty(nonEnumerableObject, "hidden", { value: true });
  for (const invalid of [symbolicObject, nonEnumerableObject]) {
    assert.throws(
      () => neutralCanonicalJson(invalid),
      (error) => error instanceof CanonicalJsonError,
    );
  }
});

test("digest verification rejects semantic Plan bindings independently of schema shape", () => {
  for (const mutate of [
    (plan) => {
      plan.intent.title = "Digest substitution";
    },
    (plan) => {
      plan.selectedOwner.id = "architecture/security";
    },
    (plan) => {
      plan.referencedDocuments[0].path = "docs/decisions/0053-moved.md";
    },
    (plan) => {
      plan.output.contentBase64 = Buffer.from("hello\r\n").toString("base64");
    },
  ]) {
    const plan = clone(fixture.plan);
    mutate(plan);
    assert.throws(() => assertDocumentPlanDigests(plan));
  }
});

test("binds the selected owner to the immutable Intent owner", () => {
  const plan = clone(fixture.plan);
  plan.selectedOwner.id = "architecture/security";
  plan.selectedOwner.membershipDigest = documentOwnerMembershipDigest(
    plan.authority.ownerCatalog.digest,
    plan.selectedOwner.id,
  );
  plan.planDigest = documentPlanDigest(plan);
  assert.throws(() => assertDocumentPlanDigests(plan), /membership digest/u);
});

test("digest verification rejects Receipt and exact-output tampering", () => {
  const receipt = clone(fixture.receipt);
  receipt.outcome = "already-applied";
  assert.throws(() => assertDocumentReceiptDigest(receipt));

  const reboundReceipt = clone(fixture.receipt);
  reboundReceipt.resultDigest = `sha256:${"1".repeat(64)}`;
  reboundReceipt.receiptDigest = documentReceiptDigest(reboundReceipt);
  assert.throws(() => assertDocumentReceiptDigest(reboundReceipt, fixture.plan));

  const plan = clone(fixture.plan);
  plan.output.contentBase64 = Buffer.from("hello\r\n").toString("base64");
  plan.output.size = 7;
  plan.output.digest = `sha256:${"0".repeat(64)}`;
  plan.planDigest = documentPlanDigest(plan);
  assert.throws(() => assertDocumentPlanDigests(plan));
});

test("digest verification binds publication paths and rejects executable inputs", () => {
  const wrongParent = clone(fixture.plan);
  wrongParent.expectedParent.path = "docs";
  wrongParent.planDigest = documentPlanDigest(wrongParent);
  assert.throws(
    () => assertDocumentPlanDigests(wrongParent),
    /publication bindings/u,
  );

  const wrongParentState = clone(fixture.plan);
  wrongParentState.expectedParent.state = "file";
  wrongParentState.planDigest = documentPlanDigest(wrongParentState);
  assert.throws(() => assertDocumentPlanDigests(wrongParentState));

  const linkedAncestry = clone(fixture.plan);
  linkedAncestry.expectedParent.ancestry = "symlink-allowed";
  linkedAncestry.planDigest = documentPlanDigest(linkedAncestry);
  assert.throws(() => assertDocumentPlanDigests(linkedAncestry));

  const replacePrecondition = clone(fixture.plan);
  replacePrecondition.destinationPrecondition.state = "replace";
  replacePrecondition.planDigest = documentPlanDigest(replacePrecondition);
  assert.throws(() => assertDocumentPlanDigests(replacePrecondition));

  const missingCapability = clone(fixture.plan);
  missingCapability.requiredAdapterCapabilities = [];
  missingCapability.planDigest = documentPlanDigest(missingCapability);
  assert.throws(() => assertDocumentPlanDigests(missingCapability));

  const wrongDestination = clone(fixture.receipt);
  wrongDestination.destination = "docs/decisions/9999-forged.md";
  wrongDestination.receiptDigest = documentReceiptDigest(wrongDestination);
  assert.throws(
    () => assertDocumentReceiptDigest(wrongDestination, fixture.plan),
    /does not bind/u,
  );

  const unsupportedOutcome = clone(fixture.receipt);
  unsupportedOutcome.outcome = "forged";
  delete unsupportedOutcome.resultDigest;
  unsupportedOutcome.receiptDigest = documentReceiptDigest(unsupportedOutcome);
  assert.throws(() =>
    assertDocumentReceiptDigest(unsupportedOutcome, fixture.plan),
  );

  let getterCalls = 0;
  for (const [subject, verify] of [
    [clone(fixture.plan), assertDocumentPlanDigests],
    [clone(fixture.receipt), assertDocumentReceiptDigest],
  ]) {
    Object.defineProperty(subject, "destination", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "docs/executed.md";
      },
    });
    assert.throws(() => verify(subject));
  }
  assert.equal(getterCalls, 0);

  const symbolicPlan = clone(fixture.plan);
  symbolicPlan[Symbol("forged")] = true;
  const hiddenPlan = clone(fixture.plan);
  Object.defineProperty(hiddenPlan, "forged", { value: true });
  const cyclicPlan = clone(fixture.plan);
  cyclicPlan.diagnostics.push(cyclicPlan);
  const sparsePlan = clone(fixture.plan);
  sparsePlan.diagnostics = Array(2);
  for (const invalid of [symbolicPlan, hiddenPlan, cyclicPlan, sparsePlan]) {
    assert.throws(() => assertDocumentPlanDigests(invalid));
  }
});

test("document output validation rejects a raw UTF-8 BOM", () => {
  const plan = clone(fixture.plan);
  const bytes = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("hello\n"),
  ]);
  plan.output.contentBase64 = bytes.toString("base64");
  plan.output.size = bytes.byteLength;
  plan.output.digest = sha256Bytes(bytes);
  plan.planDigest = documentPlanDigest(plan);
  assert.throws(() => assertDocumentPlanDigests(plan), /UTF-8 BOM/u);
});

test("rejects unknown versions and fields across the public contracts", async () => {
  for (const [schemaId, source] of [
    ["document-authoring-profile/v1", fixture.profile],
    ["document-intent/v1", fixture.intent],
    ["document-plan/v1", fixture.plan],
    ["document-receipt/v1", fixture.receipt],
    ["document-command-envelope/v1", fixture.command],
  ]) {
    const unknownVersion = clone(source);
    unknownVersion.schemaVersion = 99;
    await rejectsSchema(schemaId, unknownVersion);

    const unknownField = clone(source);
    unknownField.extension = true;
    await rejectsSchema(schemaId, unknownField);
  }

  const futureEnvelope = documentEnvelope();
  futureEnvelope.schemaVersion = 99;
  await rejectsSchema("foundation-transaction-envelope/v3", futureEnvelope);
});

test("keeps profiles local, closed, create-only, and non-executable", async () => {
  const remoteSchema = clone(fixture.profile);
  remoteSchema.catalog.metadataSchemaPath = "https://example.test/metadata.json";
  await rejectsSchema("document-authoring-profile/v1", remoteSchema);

  const hook = clone(fixture.profile);
  hook.authoring.artifactTypes[0].hook = "node scripts/create.mjs";
  await rejectsSchema("document-authoring-profile/v1", hook);

  const unsupportedPlacement = clone(fixture.profile);
  unsupportedPlacement.authoring.artifactTypes[0].placement = {
    kind: "glob",
    pattern: "docs/**/*.md",
  };
  await rejectsSchema("document-authoring-profile/v1", unsupportedPlacement);

  const missingOwnerCatalog = clone(fixture.profile);
  delete missingOwnerCatalog.catalog.ownerCatalog;
  await rejectsSchema("document-authoring-profile/v1", missingOwnerCatalog);

  const devicePath = clone(fixture.profile);
  devicePath.catalog.metadataSchemaPath = "docs/CON.json";
  await rejectsSchema("document-authoring-profile/v1", devicePath);
});

test("bounds inert additional metadata by width, depth, and scalar size", async () => {
  const tooManyRelations = clone(fixture.intent);
  tooManyRelations.related = Array.from({ length: 129 }, (_, index) => `ADR-${index}`);
  await rejectsSchema("document-intent/v1", tooManyRelations);

  const tooDeep = clone(fixture.intent);
  tooDeep.additionalMetadata = { a: { b: { c: { d: { e: true } } } } };
  await rejectsSchema("document-intent/v1", tooDeep);

  const oversized = clone(fixture.intent);
  oversized.title = "x".repeat(241);
  await rejectsSchema("document-intent/v1", oversized);
});

test("accepts bounded path-affecting Intent inputs and rejects unsafe forms", async () => {
  const explicit = clone(fixture.intent);
  explicit.slug = "deterministic-documentation-authoring";
  explicit.destination = "packages/example/src/features/example/README.md";
  await assertSchema("document-intent/v1", explicit, "explicit-intent");

  for (const slug of ["", "Uppercase", "two--hyphens", "../escape"]) {
    const invalid = clone(fixture.intent);
    invalid.slug = slug;
    await rejectsSchema("document-intent/v1", invalid);
  }

  for (const destination of [
    "/absolute.md",
    "docs/../escape.md",
    "docs/CON.md",
    "docs/file.md:stream",
    "docs/trailing.",
  ]) {
    const invalid = clone(fixture.intent);
    invalid.destination = destination;
    await rejectsSchema("document-intent/v1", invalid);
  }
});

test("rejects control text, owned metadata fields, and prototype-sensitive keys", async () => {
  for (const [field, value] of [
    ["title", "unsafe\nheading"],
    ["summary", "unsafe\u0000summary"],
  ]) {
    const invalid = clone(fixture.intent);
    invalid[field] = value;
    await rejectsSchema("document-intent/v1", invalid);
  }

  for (const key of [
    "id",
    "type",
    "status",
    "owner",
    "summary",
    "title",
    "slug",
    "destination",
    "related",
    "__proto__",
    "prototype",
    "constructor",
  ]) {
    const invalid = clone(fixture.intent);
    invalid.additionalMetadata = JSON.parse(`{${JSON.stringify(key)}:true}`);
    await rejectsSchema("document-intent/v1", invalid);
  }

  for (const key of ["__proto__", "prototype", "constructor", "bad key"]) {
    const invalid = clone(fixture.intent);
    invalid.additionalMetadata = {
      consumer: JSON.parse(`{${JSON.stringify(key)}:true}`),
    };
    await rejectsSchema("document-intent/v1", invalid);
  }

  const unicodeKey = clone(fixture.intent);
  unicodeKey.additionalMetadata = { café: true };
  await rejectsSchema("document-intent/v1", unicodeKey);
});

test("closes identity grammar and makes qualified leaf placement unambiguous", async () => {
  const qualified = clone(fixture.profile);
  const artifact = qualified.authoring.artifactTypes[0];
  artifact.type = "bounded-context";
  artifact.identity = {
    kind: "explicit",
    format: "qualified",
    grammar: {
      prefixSegments: ["domain", "contexts"],
      minSuffixSegments: 1,
      maxSuffixSegments: 1,
    },
  };
  artifact.placement = {
    kind: "qualified-leaf-index",
    root: "docs/domain/contexts",
    requiredBasename: "README.md",
  };
  await assertSchema("document-authoring-profile/v1", qualified, "qualified-profile");

  for (const mutate of [
    (value) => delete value.authoring.artifactTypes[0].identity.grammar,
    (value) => {
      value.authoring.artifactTypes[0].identity.grammar.prefixSegments = ["Domain"];
    },
    (value) => {
      value.authoring.artifactTypes[0].identity.grammar.extra = true;
    },
    (value) => {
      value.authoring.artifactTypes[0].placement.allowedRoots = ["docs"];
    },
    (value) => {
      value.authoring.artifactTypes[0].placement.requiredSegmentsInOrder = ["domain"];
    },
  ]) {
    const invalid = clone(qualified);
    mutate(invalid);
    await rejectsSchema("document-authoring-profile/v1", invalid);
  }
});

test("retains consumer-selected roots only for explicit placement", async () => {
  const explicit = clone(fixture.profile);
  const artifact = explicit.authoring.artifactTypes[0];
  artifact.type = "feature";
  artifact.identity = {
    kind: "explicit",
    format: "qualified",
    grammar: {
      prefixSegments: ["feature"],
      minSuffixSegments: 2,
      maxSuffixSegments: 16,
    },
  };
  artifact.placement = {
    kind: "explicit",
    allowedRoots: ["apps", "packages", "tooling"],
    requiredSegmentsInOrder: ["src", "features"],
    requiredBasename: "README.md",
    minimumSegmentsBeforeRequired: 1,
    minimumSegmentsAfterRequired: 1,
  };
  await assertSchema("document-authoring-profile/v1", explicit, "explicit-profile");

  for (const field of [
    "minimumSegmentsBeforeRequired",
    "minimumSegmentsAfterRequired",
  ]) {
    const invalid = clone(explicit);
    delete invalid.authoring.artifactTypes[0].placement[field];
    await rejectsSchema("document-authoring-profile/v1", invalid);
  }
});

test("closes bounded reachability strategies and their placement compatibility", async () => {
  const legacy = clone(fixture.profile);
  delete legacy.authoring.artifactTypes[0].reachability;
  await assertSchema("document-authoring-profile/v1", legacy, "legacy-profile");

  for (const reachability of [
    { kind: "manual-fixed-index", indexPath: "docs/README.md" },
    { kind: "not-required" },
  ]) {
    const valid = clone(fixture.profile);
    valid.authoring.artifactTypes[0].reachability = reachability;
    await assertSchema("document-authoring-profile/v1", valid, "reachability-profile");
  }

  const colocated = clone(fixture.profile);
  const artifact = colocated.authoring.artifactTypes[0];
  artifact.identity = {
    kind: "explicit",
    format: "qualified",
    grammar: { prefixSegments: ["feature"], minSuffixSegments: 2, maxSuffixSegments: 16 },
  };
  artifact.placement = {
    kind: "explicit",
    allowedRoots: ["apps", "packages"],
    requiredSegmentsInOrder: ["src", "features"],
    requiredBasename: "README.md",
    minimumSegmentsBeforeRequired: 1,
    minimumSegmentsAfterRequired: 1,
  };
  artifact.reachability = {
    kind: "manual-colocated-index",
    pathPrefix: "before-required-segments",
    indexBasename: "README.md",
  };
  await assertSchema("document-authoring-profile/v1", colocated, "colocated-profile");

  for (const mutate of [
    (value) => { value.authoring.artifactTypes[0].reachability.extra = true; },
    (value) => { value.authoring.artifactTypes[0].reachability.indexBasename = "INDEX.md"; },
    (value) => { value.authoring.artifactTypes[0].reachability.pathPrefix = "nearest-parent"; },
  ]) {
    const invalid = clone(colocated);
    mutate(invalid);
    await rejectsSchema("document-authoring-profile/v1", invalid);
  }
});

test("binds Receipt result evidence to a proven output outcome", async () => {
  const missingResult = clone(fixture.receipt);
  delete missingResult.resultDigest;
  await rejectsSchema("document-receipt/v1", missingResult);

  const rejectedWithResult = clone(fixture.receipt);
  rejectedWithResult.outcome = "rejected";
  rejectedWithResult.commit = {
    state: "not-published",
    publication: "none",
    atomicity: "not-applicable",
    recoverability: "not-required",
  };
  await rejectsSchema("document-receipt/v1", rejectedWithResult);
});

test("binds transaction payloads to closed Document Authoring recovery handlers", async () => {
  const mismatchedHandler = documentEnvelope();
  mismatchedHandler.recoveryHandler.id = "foundation.scaffolding";
  await rejectsSchema("foundation-transaction-envelope/v3", mismatchedHandler);

  const unknownPayload = documentEnvelope();
  unknownPayload.payloadKind = "consumer.callback/v1";
  await rejectsSchema("foundation-transaction-envelope/v3", unknownPayload);
});

test("binds each JSON command to its closed result shape", async () => {
  const wrongResult = clone(fixture.command);
  wrongResult.command = "docs.new";
  await rejectsSchema("document-command-envelope/v1", wrongResult);

  const zeroMatches = clone(fixture.command);
  await assertSchema("document-command-envelope/v1", zeroMatches, "zero-matches");
  assert.equal(zeroMatches.result.matches, 0);
  assert.equal(zeroMatches.outcome, "success");
});

test("strict JSON rejects duplicate contract keys before schema validation", () => {
  assert.throws(
    () => parseStrictJson('{"schemaVersion":1,"schemaVersion":1}'),
    (error) =>
      error instanceof StrictJsonError && error.failure === "duplicate-key",
  );
  assert.throws(
    () => parseStrictJson('{"schemaVersion":1,"nested":{"id":"a","id":"b"}}'),
    (error) =>
      error instanceof StrictJsonError && error.failure === "duplicate-key",
  );
});

test("native archived evidence and the entire frozen Plan/envelope closure remain byte-exact", async () => {
  const root = new URL("../packages/document-authoring/tests/fixtures/schema-recovery/", import.meta.url);
  const origin = JSON.parse(await readFile(new URL("origin.json", root)));
  for (const [name, expected] of Object.entries(origin.sha256)) {
    assert.equal(sha256Bytes(await readFile(new URL(name, root))), `sha256:${expected}`, name);
  }
  const historical = new Ajv2020({ strict: true, strictTuples: false, validateFormats: false });
  for (const [name, expected] of Object.entries(origin.frozenSchemaSha256)) {
    const { bytes, schema } = await readHistoricalSchema(name);
    assert.equal(sha256Bytes(bytes), `sha256:${expected}`, name);
    historical.addSchema(schema);
  }
  for (const generation of [1, 2]) {
    const plan = JSON.parse(await readFile(new URL(`native-old-plan-v${generation}.json`, root)));
    const receipt = JSON.parse(await readFile(new URL(`native-old-receipt-v${generation}.json`, root)));
    assert.equal(historical.validate(`https://agent-teams.ai/schemas/document-plan/v${generation}`, plan), true);
    assert.equal(historical.validate(`https://agent-teams.ai/schemas/document-receipt/v${generation}`, receipt), true);
    await assertSchema(`document-plan/v${generation}`, plan, "native-old-plan");
    await assertSchema(`document-receipt/v${generation}`, receipt, "native-old-receipt");
    await assert.rejects(assertSchema(`document-authoring/document-plan/v${generation}`, plan, "old-plan-refused"));
    const envelope = JSON.parse(await readFile(new URL(`native-old-envelope-v${generation}.json`, root)));
    assert.equal(historical.validate(`https://agent-teams.ai/schemas/foundation-transaction-envelope/v${generation + 2}`, envelope), true);
    await assertSchema(`foundation-transaction-envelope/v${generation + 2}`, envelope, "native-old-envelope");
    await assert.rejects(assertSchema(generation === 1
      ? "document-authoring/document-file-transaction-envelope/v1"
      : "document-authoring/document-directory-transaction-envelope/v1", envelope, "old-envelope-refused"));
    assertDocumentPlanDigests(plan);
    assertDocumentReceiptDigest(receipt, plan);
  }
});

test("schema catalog accepts only explicit names and never follows cross-package traversal", async () => {
  const { readDocumentAuthoringSchema } = await import("../packages/document-authoring/dist/index.js");
  for (const name of ["../../repository-mutation/schemas/known-file-transaction-plan/v1", "../document-plan/v1", "__proto__", "constructor", "document-plan/v99"]) {
    await assert.rejects(readDocumentAuthoringSchema(name), /Unknown Document Authoring schema catalog name/u);
  }
  assert.equal(JSON.parse(await readDocumentAuthoringSchema("document-authoring/document-plan/v2")).$id,
    "https://agent-teams.ai/schemas/document-authoring/document-plan/v2");
});
