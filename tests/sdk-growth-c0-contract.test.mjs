import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const inventory = JSON.parse(await read("docs/reference/sdk-growth-c0/ef-inventory.json"));
test("C0 inventory preserves its complete reviewed checkpoint identity", async () => {
  // Historical evidence stays frozen; current packages may evolve independently.
  assert.equal(digest(await read("docs/reference/sdk-growth-c0/ef-inventory.json")),
    "sha256:d330bc4bc11fc99e3a683fe1a0edb90002240eea7c15123dba956d3fc23ac072");
  assert.equal(inventory.integrationBase, "576ca17ea28c3df7109e99abdd4bd7cc7e89854a");
  assert.equal(inventory.activation, "pending");
  assert.equal(new Set(inventory.packages.map((entry) => entry.packageName)).size, 8);
  assert.equal(inventory.packages.filter((entry) => entry.classification === "public-development").length, 6);
  assert.equal(inventory.packages.filter((entry) => entry.classification === "private-only").length, 2);
  for (const entry of inventory.packages) {
    if (entry.classification === "private-only") {
      assert.equal(entry.exports, null);
      assert.deepEqual(entry.bin, {});
      continue;
    }
    for (const target of Object.values(entry.exports)) {
      if (typeof target === "object") {
        assert.deepEqual(Object.keys(target), ["types", "import"]);
      }
    }
  }
});

test("C0 retains all four v1 schema artifacts and unavailable archive evidence", async () => {
  assert.equal(Object.keys(inventory.retainedV1SchemaDigests).length, 4);
  for (const [path, expected] of Object.entries(inventory.retainedV1SchemaDigests)) {
    assert.equal(digest(await read(path)), expected, path);
  }
  assert.equal(inventory.archiveEvidence.status, "unavailable");
  assert.ok(inventory.archiveEvidence.reason.length > 0);
});

test("C0 documents existing command names and a declaration-only pseudo-contract", async () => {
  const current = JSON.parse(await read("package.json"));
  for (const command of ["foundation:check:built", "release-owned-files:check", "check:changed", "check:fast", "verify"]) {
    assert.equal(typeof current.scripts[command], "string", command);
  }
  const documentation = await read("docs/reference/sdk-growth-c0.md");
  const blocks = [...documentation.matchAll(/```ts\n([\s\S]*?)\n```/gu)];
  assert.equal(blocks.length, 1);
  assert.equal(stripTypeScriptTypes(blocks[0][1]).trim(), "");
  for (const path of [".github/workflows/ci.yml", ".github/workflows/codeql.yml", ".github/workflows/release.yml",
    "scripts/check-release-owned-files.mjs", "architecture/foundation/public-api-compatibility.yaml"]) {
    assert.ok((await read(path)).length > 0, path);
    assert.ok(documentation.includes(path), path);
  }
});

test("C0 canonical bytes bind the revision, contract and finite observer matrix", async () => {
  const identity = JSON.parse(await read("docs/reference/sdk-growth-c0/contract-identity.json"));
  assert.deepEqual(Object.keys(identity).toSorted(), ["canonicalBytes", "contractRevision", "files", "planHash", "sourceBase"]);
  assert.equal(identity.contractRevision, "foundation:sdk-growth:c0:5");
  assert.equal(identity.canonicalBytes, "UTF-8, LF, exact file bytes including final newline");
  assert.deepEqual(Object.keys(identity.files).toSorted(), [
    "docs/reference/sdk-growth-c0.md",
    "docs/reference/sdk-growth-c0/ef-inventory.json",
    "docs/reference/sdk-growth-c0/surface-matrix.json",
  ]);
  for (const [path, expected] of Object.entries(identity.files)) {
    const bytes = await read(path);
    assert.ok(bytes.endsWith("\n") && !bytes.includes("\r"), path);
    assert.equal(digest(bytes), expected, path);
    assert.notEqual(digest(`${bytes} `), expected, `changed bytes must not retain identity: ${path}`);
  }
});

test("C0 matrix retains private public paths and incomplete observer boundaries at exact bases", async () => {
  const matrix = JSON.parse(await read("docs/reference/sdk-growth-c0/surface-matrix.json"));
  assert.equal(matrix.contractRevision, inventory.contractRevision);
  assert.equal(matrix.status, "incomplete");
  assert.deepEqual(matrix.repositories.map(({ repository, integrationBase, packages }) =>
    [repository, integrationBase, packages.length]), [
    ["ef", "576ca17ea28c3df7109e99abdd4bd7cc7e89854a", 8],
    ["gm", "ac49bb3374946330ec820591f8195a22d2c90900", 3],
    ["ar", "be96f01ea54ec7d2ec0156774e3dfb75fac46803", 7],
  ]);
  const ef = matrix.repositories[0].packages;
  assert.deepEqual(ef.map(({ packageName, version, manifestDigest }) =>
    ({ packageName, version, manifestDigest })),
  inventory.packages.map(({ packageName, version, manifestDigest }) =>
    ({ packageName, version, manifestDigest })));
  for (const repo of matrix.repositories) {
    assert.equal(new Set(repo.packages.map(({ packageName }) => packageName)).size, repo.packages.length);
    for (const entry of repo.packages) {
      for (const surface of entry.surface) {
        const shape = matrix.shapes[surface.shape];
        assert.ok(shape, `${entry.packageName}: ${surface.shape}`);
        assert.deepEqual(Object.keys(shape.observers).toSorted(),
          ["api-extractor", "artifact-inventory", "bounded-audit", "export-coverage"]);
        for (const observation of Object.values(shape.observers)) {
          const [status, reason] = observation.split(":");
          assert.ok(["limited", "unsupported", "unavailable"].includes(status));
          assert.ok(matrix.reasons[reason]?.length > 0, observation);
        }
      }
    }
  }
  assert.equal(matrix.repositories[2].packages.filter(({ classification }) =>
    classification === "private-development").length, 6);
  const gmRoot = matrix.repositories[1].packages[1].surface[0];
  assert.equal(gmRoot.shape, "typed-import-default");
  assert.deepEqual(Object.keys(gmRoot.target), ["import", "default"]);
  assert.deepEqual(Object.keys(gmRoot.target.import), ["types", "default"]);
  const embedded = matrix.repositories[2].packages.find(({ packageName }) =>
    packageName === "@agent-teams/embedded-runtime");
  assert.ok(embedded.surface.some(({ exportPath, shape }) =>
    exportPath === "./scripts/run-package-tests.mjs" && shape === "runtime"));
  for (const kind of ["data", "runtime"]) {
    assert.equal(matrix.shapes[kind].observers["artifact-inventory"],
      "unsupported:non-wildcard-artifact");
  }
});

// Independent review oracle, deliberately not loaded from the mutable sidecar.
// This validates only frozen documentation artifacts, never runtime SDK reports.
const frozenDigests = {
  "docs/reference/sdk-growth-c0.md": "sha256:0457b60d532e4d16fe856c72c1189358550d7510a134d053187d2b7f75b386a3",
  "docs/reference/sdk-growth-c0/ef-inventory.json": "sha256:d330bc4bc11fc99e3a683fe1a0edb90002240eea7c15123dba956d3fc23ac072",
  "docs/reference/sdk-growth-c0/surface-matrix.json": "sha256:987bc6a5d2ae010e8fab2fa2c0edf1b0dbb4d9976dcdd67acb332cba461248f5",
};
const identityPath = "docs/reference/sdk-growth-c0/contract-identity.json";
const inventoryPath = "docs/reference/sdk-growth-c0/ef-inventory.json";
const matrixPath = "docs/reference/sdk-growth-c0/surface-matrix.json";
const documentPath = "docs/reference/sdk-growth-c0.md";
const frozenArtifacts = Object.fromEntries(await Promise.all(
  [...Object.keys(frozenDigests), identityPath].map(async (path) => [path, await read(path)]),
));

function assertFrozenArtifacts(artifacts) {
  const identity = JSON.parse(artifacts[identityPath]);
  assert.deepEqual(Object.keys(identity).toSorted(),
    ["canonicalBytes", "contractRevision", "files", "planHash", "sourceBase"]);
  assert.equal(identity.contractRevision, "foundation:sdk-growth:c0:5");
  assert.equal(identity.sourceBase, "576ca17ea28c3df7109e99abdd4bd7cc7e89854a");
  assert.equal(identity.planHash, "sha256:e025978dcf3cfac12b7795fa3aafc96f06838620e124df4cc091ebee45352864");
  assert.equal(identity.canonicalBytes, "UTF-8, LF, exact file bytes including final newline");
  assert.deepEqual(Object.keys(identity.files).toSorted(), Object.keys(frozenDigests).toSorted());
  for (const [path, expected] of Object.entries(frozenDigests)) {
    assert.equal(digest(artifacts[path]), identity.files[path], `sidecar drift: ${path}`);
    assert.equal(digest(artifacts[path]), expected, `reviewed artifact drift: ${path}`);
  }
}

function editJson(artifacts, path, mutate) {
  const value = JSON.parse(artifacts[path]);
  mutate(value);
  artifacts[path] = `${JSON.stringify(value, null, 2)}\n`;
}

const rejectingFixtures = [
  ["stale revision 4", (a) => editJson(a, identityPath, (v) => { v.contractRevision = "foundation:sdk-growth:c0:4"; })],
  ["missing observation entries", (a) => { a[documentPath] = a[documentPath].replace("  entries: { coordinate: Coordinate; value: ValueRef }[];", ""); }],
  ["duplicate coordinates allowed", (a) => { a[documentPath] = a[documentPath].replace("Reject duplicate\ncoordinates before sorting", "Allow duplicate\ncoordinates before sorting"); }],
  ["self-referential observation digest", (a) => { a[documentPath] = a[documentPath].replace('payload:GrowthSurfaceObservation}', 'payload:GrowthSurfaceObservation,surfaceDigest}'); }],
  ["wrong observation digest domain", (a) => { a[documentPath] = a[documentPath].replace('domain:"foundation:sdk-growth:observation:1"', 'domain:"foundation:sdk-growth:transition:1"'); }],
  ["missing v2 release evidence", (a) => { a[documentPath] = a[documentPath].replace("The v2 artifact requires its own release-owned baseline and\n`contract.json-schema-releases` corpus plus consumer evidence in S2.", "The v2 artifact needs no release evidence."); }],
  ["synthetic trusted authority", (a) => { a[documentPath] = a[documentPath].replace("and always yields authority\nunverified", "and always yields authority\nverified"); }],
  ["ambiguous outcome mapping", (a) => { a[documentPath] = a[documentPath].replace("| invalid-input | 2 | SDK_GROWTH_EVIDENCE_INCOMPLETE", "| passed | 0 | SDK_GROWTH_EVIDENCE_INCOMPLETE"); }],
  ["partial successful receipt", (a) => { a[documentPath] = a[documentPath].replace("No partial receipt is ever emitted.", "Partial successful receipts may be emitted."); }],
  ["v1 extension in place", (a) => { a[documentPath] = a[documentPath].replace("No second policy/parser implementation.", "Extend the v1 schema with sdkGrowth in place."); }],
  ["v2 schema treated as legacy", (a) => { a[documentPath] = a[documentPath].replace("It is not legacy surface", "It is legacy surface"); }],
  ["candidate E2E false pass", (a) => { a[documentPath] = a[documentPath].replace("unverified, exit 2, releaseEligible false", "verified, exit 0, releaseEligible true"); }],

  ["stale EF source identity", (a) => editJson(a, identityPath, (v) => { v.sourceBase = "e6a9219ef3be8cf9e733223e2dda21df37288ab8"; })],
  ["stale canonical plan", (a) => editJson(a, identityPath, (v) => { v.planHash = "sha256:548b7056499f964a1bda46dfb43bc019e1d8c4933d97fb0e88441aca61852248"; })],
  ["stale AR evidence", (a) => editJson(a, matrixPath, (v) => { v.repositories[2].integrationBase = "527d5fe93bfb02bde287beae2b9f7bfb44ba1988"; })],
  ["package omission", (a) => editJson(a, inventoryPath, (v) => { v.packages.pop(); })],
  ["equal-count package substitution", (a) => {
    editJson(a, inventoryPath, (v) => { v.packages[1].packageName = "@agent-teams/fabricated"; });
    editJson(a, matrixPath, (v) => { v.repositories[0].packages[1].packageName = "@agent-teams/fabricated"; });
  }],
  ["unsupported runtime observation upgraded", (a) => editJson(a, matrixPath, (v) => { v.shapes.runtime.observers["artifact-inventory"] = "limited:artifact"; })],
  ["fabricated full SDK coverage", (a) => editJson(a, matrixPath, (v) => { v.status = "complete"; v.claim = "Full SDK coverage"; })],
  ["fabricated release eligibility", (a) => { a[documentPath] = a[documentPath].replaceAll("releaseEligible:false", "releaseEligible:true"); }],
  ["activation before implementation", (a) => editJson(a, inventoryPath, (v) => { v.activation = "active"; })],
  ["self hash in index", (a) => editJson(a, identityPath, (v) => { v.files[identityPath] = digest(a[identityPath]); })],
  ["hash used as semantic revision", (a) => editJson(a, identityPath, (v) => { v.contractRevision = digest(a[documentPath]); })],
  ["candidate Actions promoted to trusted authority", (a) => {
    a[documentPath] = a[documentPath].replace("S3/G1/A3 trusted activation: blocked", "S3/G1/A3 trusted activation: go");
  }],
  ["ruleset evidence substituted", (a) => { a[documentPath] = a[documentPath].replace("19979782", "19979783"); }],
  ["organization discovery denial erased", (a) => { a[documentPath] = a[documentPath].replace("HTTP 403", "HTTP 200"); }],
  ["canonical byte drift", (a) => { a[documentPath] += "\n"; }],
];

test("C0 artifacts match the independent freeze oracle", () => {
  assertFrozenArtifacts(frozenArtifacts);
});

for (const [name, mutate] of rejectingFixtures) {
  test(`C0 rejects ${name} even with refreshed sidecar hashes`, () => {
    const changed = { ...frozenArtifacts };
    mutate(changed);
    assert.notDeepEqual(changed, frozenArtifacts, "fixture must actually change its input");
    editJson(changed, identityPath, (identity) => {
      for (const path of Object.keys(frozenDigests)) {
        identity.files[path] = digest(changed[path]);
      }
    });
    assert.throws(() => assertFrozenArtifacts(changed), assert.AssertionError);
  });
}

test("C0 rejects sidecar hash drift without an artifact edit", () => {
  const changed = { ...frozenArtifacts };
  editJson(changed, identityPath, (v) => { v.files[documentPath] = `sha256:${"0".repeat(64)}`; });
  assert.throws(() => assertFrozenArtifacts(changed), assert.AssertionError);
});

// Release-owned v1 byte oracle is independent of inventory and identity edits.
const frozenV1Schemas = {
  "packages/engineering-foundation/schemas/package-public-api-audit-report/v1.schema.json": "sha256:c3929a037a94b8532cea6437223a1111be76b44e5c3b785de4ebcc6d6ae0187b",
  "packages/engineering-foundation/schemas/package-public-api-audit-request/v1.schema.json": "sha256:101f48dfb2768aafdadc0cafb9658050a3969662903199f8250b02acd25cd77b",
  "packages/engineering-foundation/schemas/package-public-api-baseline/v1.schema.json": "sha256:abdf61460d44c72e7ca6fa8f349726c0d335ae63064c531d11781c57fbd4e85d",
  "packages/engineering-foundation/schemas/package-public-api-compatibility/v1.schema.json": "sha256:5a0199c828b8db2199ef2337bb2b2e372d67eae7b48aef16bec2687fb5216106"
};
function assertV1Schemas(bytes) {
  for (const [path, expected] of Object.entries(frozenV1Schemas)) {
    assert.equal(digest(bytes[path]), expected, path);
  }
}
const v1Bytes = Object.fromEntries(await Promise.all(
  Object.keys(frozenV1Schemas).map(async (path) => [path, await read(path)]),
));
test("C0 independent v1 release byte oracle accepts retained schemas", () => {
  assertV1Schemas(v1Bytes);
});
for (const path of Object.keys(frozenV1Schemas)) {
  test(`C0 rejects claimed v1 schema mutation: ${path}`, () => {
    const changed = { ...v1Bytes, [path]: `${v1Bytes[path]} ` };
    assert.throws(() => assertV1Schemas(changed), assert.AssertionError);
  });
}

// Documentation semantics are checked without any artifact digest oracle.
// Mutations refresh BOTH the sidecar and review digests before this check.
const semanticRequirements = {
  custody: [
    'The S2 application use case invokes GrowthObservationPort exactly once in the',
    'invocation before comparison or projection. Mismatch is a typed invariant\nfailure (failed/3), never missing evidence or admission.',
    'observe(invocation: GrowthInvocation, cancellation: Cancellation)',
    'same run with explicit GrowthInvocation and Cancellation arguments',
    'all returned repository/source/build/artifact/tool identities against that',
    'authority context only; it cannot supply a candidate',
    'or projection is permitted',
    'it is not loaded from sdkGrowth or captured as hidden adapter configuration',
  ],
  compatibilityHandoff: [
    'Promise<GrowthObservationExecution>;',
    'readonly identity: GrowthInvocation;',
    'readonly surface: Evidence<GrowthSurfaceObservation>;',
    'readonly compatibilitySnapshots: readonly V1CompatibilityPackage[];',
    'readonly typed: { readonly kind: "typed"; readonly snapshot: Evidence<V1CompatibilitySnapshot> };',
    'readonly artifact: { readonly kind: "artifact"; readonly snapshot: Evidence<V1CompatibilitySnapshot> };',
    "Every available snapshot packageName must equal its row packageName;",
    'validate each tag and observer provenance before dispatch to its matching route.',
    'Omission, duplicate rows, cross-branch substitution or conflation fails closed as',
    'Both branch fields are mandatory even when',
    'to the unchanged releasedBaselinePath flow; artifact routes to the existing',
    'artifact baseline/projection flow through artifactApiProjection of',
    'PublicApiArtifactSnapshot, retaining extractorVersion package-artifact-inventory/1.',
    'Retain distinct typed and artifact baseline bytes, evidence and v1 fingerprint',
    'typed and artifact observer once per package; no second S1 census or growth',
    'explicit GrowthInvocation envelope, not persisted evidence. Do not add an',
    'execution-envelope digest. The compatibility handoff is not included in growth',
    'hash payloads; growth surface digest and existing v1 fingerprints remain separate',
    'internal deeply readonly result',
    'schemaVersion: 1; packageName: string; packageVersion: string;',
    'canonicalReference: string; kind: string; parentReference?: string;',
    'parentKind: string; signature: string;',
    'S2 validates the envelope identity and surface identities against',
    'Preserve absent parentReference versus an empty string and exact signature bytes.',
    'The unchanged classifyPublicApiChange comparator receives each branch separately,',
    'using the existing ChangeFingerprint port.',
    'Retain its existing v1 added/changed/removed item evidence, before/after values,',
    'serialization and fingerprint semantics; growth ValueRef digests cannot replace',
    'high-level observation execution, not a second extraction or projection from',
    'ordering and fingerprint inputs remain unchanged.',
  ],
  route: [
    'schemaVersion: 2;',
    'CompatibilityV2 above is closed at every object/union branch; every shown field',
    'comparison permits exactly trustedBasePath and\nreleased only',
    'one discriminating\nheader, exact schema selection, one shared unchanged-field mapper',
    'V2 is selected only for the existing check',
  ],
  history: [
    'released: ReleasedEvidence<GrowthSurfaceObservation>[];',
    'released: ReleasedEvidence<ObservationRef>[];',
    '{ kind: "released"; observation: Evidence<T> }',
    '{ kind: "initial-unreleased"; history: Evidence<Digest> }',
    '| { status: "unavailable"; reasons: string[] };',
    'reasons and yields incomplete; never invent a digest or switch to released',
  ],
  outcomes: [
    '| Complete, verified, admitted, finalized; compatibility passes | passed | 0 | Whole-set receipt only |',
    '| Complete, verified evidence; rejected admission or compatibility violation | violations | 1 | No successful receipt |',
    '| Expected missing/untrusted/incomplete evidence (even with semantic findings) | invalid-input | 2 | SDK_GROWTH_EVIDENCE_INCOMPLETE; no receipt |',
    '| Unexpected adapter/programming/invariant/report-write failure | failed | 3 | Preserve original classified failure; no receipt |',
    '| Explicit cancellation before atomic publication section | cancelled | 130 | EXECUTION_CANCELLED; no receipt |',
    'No partial receipt is ever emitted.',
    'unverified, exit 2, releaseEligible false',
  ],
  publication: [
    'Same canonical bytes at the validated fixed destination are an idempotent replay',
    'exclusive report-slot lock/fence before reading',
    'preimage: either absent or exact bytes plus file identity',
    'unique exclusively created sibling temporary regular file',
    'flush and close, then revalidate the captured',
    'preimage and containment under the fence immediately before atomic replace',
    'A stale preimage or lost fence is report-conflict, never success or blind retry',
    'report-publication-uncertain, never success or blind retry',
    'Reject symlinks and non-regular',
    'only owned temp/lock resources and preserves primary failure/cancellation',
    'It must remain held without expiry/reclamation during replacement',
    'Cancellation before the final preimage/fence check yields cancelled/130 without',
    'any destination change. Check cancellation immediately before entering the bounded',
    'atomic publication section, which starts with that final preimage/fence check.',
    'Once entered, defer cancellation checks through final destination-byte verification;',
    'return finalized or publication-uncertain failed/3, never cancelled after bytes may',
    "finalized result without a late cancellation check reclassifying this publication.",
  ],
  ordering: [
    'duplicate keys in every set-like collection (including identical duplicates)',
    'No deduplication, locale sorting or input-order tie breakers are allowed.',
    'then sort by the keys below using existing compareBinaryStrings semantics:',
    'raw UTF-16 code-unit order for all scalar sort keys and canonical JSON strings',
    'after serialization, with no locale or normalization. Object keys use the same',
    '| artifactDigests; transitions containing Digest; receipt decisions | Digest |',
    '| reasons | reason string |',
    '| coverage; released rows in config/context/report; packages | packageName |',
    '| coverage dimensions | dimension |',
    '| observation entries; Decision coordinates | canonical JSON of full coordinate |',
    '| Comparison transitions and findings | canonical JSON of full coordinate |',
    '| Decision records | decisionId |',
    '| consumerEvidenceRefs | canonical JSON of complete EvidenceRef |',
    '| transitionReceipts | canonical JSON of [before, after] |',
    '| entrypoints; nonTypeExports | exportPath |',
    '| approvedBreakingChanges | fingerprint |',
    'Conditions, fallbacks and resolutionBranch are semantic sequences: retain their',
    'Normative phases order is topology, observation, packed, decision, trusted-base,\nreleased, authority; each appears exactly once in this order',
  ],
  v1: [
    'Preserve the entire v1 branch, including\nvalidation ordering, stable baseline anchors, governance requirements, errors,\ndefaults, audit and promotion behavior.',
    'No second policy/parser implementation.',
    'FoundationCheckReport stays v1.',
    'These growth normalization rules do not reorder v1 inputs',
    'The v2 artifact requires its own release-owned baseline',
  ],
};
function assertContractSemantics(documentation) {
  const context = documentation.match(/type GrowthInputContext = \{([\s\S]*?)\n\};/u)?.[1];
  assert.ok(context, "context declaration required");
  assert.doesNotMatch(context, /candidate/u, "candidate custody is outside context");
  assert.doesNotMatch(documentation, /candidatePath/u, "candidate file selector forbidden");
  for (const [area, requirements] of Object.entries(semanticRequirements)) {
    for (const requirement of requirements) {
      assert.ok(documentation.includes(requirement), `${area}: ${requirement}`);
    }
  }
}
test("C0 independently asserts custody, route, history, outcomes, publication, ordering and v1", () => {
  assertContractSemantics(frozenArtifacts[documentPath]);
});
const semanticMutations = Object.entries(semanticRequirements).flatMap(([area, requirements]) =>
  requirements.map((requirement, index) => [ `${area} ${index + 1}`,
    (document) => document.replaceAll(requirement, "PROHIBITED CONTRACT MUTATION") ]));
semanticMutations.push(
  ["missing typed branch", (document) => document.replace(
    '  readonly typed: { readonly kind: "typed"; readonly snapshot: Evidence<V1CompatibilitySnapshot> };\n', '')],
  ["missing artifact branch", (document) => document.replace(
    '  readonly artifact: { readonly kind: "artifact"; readonly snapshot: Evidence<V1CompatibilitySnapshot> };\n', '')],
  ["conflated artifact tag", (document) => document.replace(
    'readonly artifact: { readonly kind: "artifact";', 'readonly artifact: { readonly kind: "typed";')],
  ["scalar comparator drift", (document) => document.replace(
    'raw UTF-16 code-unit order', 'UTF-8 byte order')],
  ["canonical comparator normalization", (document) => document.replace(
    'after serialization, with no locale or normalization', 'after serialization, with Unicode normalization')],
  ["cancellation after bytes may publish", (document) => document.replace(
    'Once entered, defer cancellation checks through final destination-byte verification;',
    'Once entered, check cancellation immediately after atomic replacement;')],
  ["observer exactly-once changed to twice", (document) => document.replace(
    'invokes GrowthObservationPort exactly once', 'invokes GrowthObservationPort twice')],
  ["identity mismatch downgraded to incomplete/2", (document) => document.replace(
    'failure (failed/3), never missing evidence or admission.',
    'failure (incomplete/2), never missing evidence or admission.')],
  ["candidate selector", (document) => document.replace('type GrowthComparisonInputs = {',
    'type GrowthComparisonInputs = { candidatePath: RepositoryPath;')],
  ["candidate context injection", (document) => document.replace('type GrowthInputContext = {',
    'type GrowthInputContext = { candidate: GrowthSurfaceObservation;')],
);
for (const [name, mutate] of semanticMutations) {
  test(`C0 semantic rejection survives refreshed artifact and sidecar digests: ${name}`, () => {
    const changed = { ...frozenArtifacts, [documentPath]: mutate(frozenArtifacts[documentPath]) };
    assert.notEqual(changed[documentPath], frozenArtifacts[documentPath]);
    const refreshedDigests = Object.fromEntries(Object.keys(frozenDigests).map((path) =>
      [path, digest(changed[path])]));
    editJson(changed, identityPath, (identity) => { identity.files = refreshedDigests; });
    // Prove no stale byte oracle is responsible for the rejection.
    for (const [path, expected] of Object.entries(refreshedDigests)) {
      assert.equal(digest(changed[path]), expected);
      assert.equal(JSON.parse(changed[identityPath]).files[path], expected);
    }
    assert.throws(() => assertContractSemantics(changed[documentPath]), assert.AssertionError);
  });
}
