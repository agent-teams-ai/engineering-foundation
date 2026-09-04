import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";

import { PUBLISHABLE_PACKAGES } from "../scripts/publishable-packages.mjs";
import {
  assertCanaryReceiptDigest,
  assertPortableCoreClosure,
  assertSafeTarballInventory,
  assertTarballEntryTypes,
  finalizeCanaryReceipt,
  hostilePolicyMatrix,
  parseCanaryAuthority,
  publicationClosureDecision,
} from "../scripts/public-managed-registry-canary-policy.mjs";

const commit = "a".repeat(40);
const integrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
const coordinateInput = JSON.stringify(PUBLISHABLE_PACKAGES.map(({ name }, index) => ({
  integrity,
  name,
  version: `1.0.${index}`,
})));

test("public managed canary authority is the exact closed six-package catalog", () => {
  const authority = parseCanaryAuthority(coordinateInput, commit);
  assert.deepEqual(authority.coordinates.map(({ name }) => name), PUBLISHABLE_PACKAGES.map(({ name }) => name));
  assert.throws(
    () => parseCanaryAuthority(JSON.stringify(JSON.parse(coordinateInput).slice(0, -1)), commit),
    /exactly 6 packages/u,
  );
  const swapped = JSON.parse(coordinateInput);
  [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  assert.throws(() => parseCanaryAuthority(JSON.stringify(swapped), commit), /coordinates\[0\]/u);
});

test("partial publication and missing adapter fail closed", () => {
  const authority = parseCanaryAuthority(coordinateInput, commit);
  const observations = Object.fromEntries(authority.coordinates.map(({ name, version }) => [name, { version }]));
  assert.equal(publicationClosureDecision(authority, observations).status, "ready");
  delete observations["@agent-teams/docs-protocol-agent-teams"];
  assert.deepEqual(publicationClosureDecision(authority, observations), {
    missing: ["@agent-teams/docs-protocol-agent-teams@1.0.3"],
    status: "rejected",
  });
});

test("tarball inventory rejects traversal, aliases, and non-normalized names", () => {
  assert.deepEqual(assertSafeTarballInventory(["package/package.json", "package/dist/index.js"], "fixture"), [
    "package/package.json",
    "package/dist/index.js",
  ]);
  for (const entries of [
    ["package/../escape"],
    ["/package/index.js"],
    ["package\\index.js"],
    ["package/cafe\u0301.js"],
    ["package/File.js", "package/file.js"],
  ]) {
    assert.throws(() => assertSafeTarballInventory(entries, "fixture"), /rejected/u);
  }
  assert.doesNotThrow(() => assertTarballEntryTypes("-rw-r--r-- 0/0 10 package/index.js\n", "fixture"));
  assert.throws(() => assertTarballEntryTypes("lrwxr-xr-x 0/0 0 package/link -> target\n", "fixture"), /link/u);
});

test("portable core denylist rejects managed adapter closure", () => {
  assert.deepEqual(assertPortableCoreClosure({
    dependencies: { "@agent-teams/document-authoring": "1.0.0" },
    entries: ["package/package.json", "package/dist/index.js"],
  }), { adapterAbsent: true, forbiddenTermsAbsent: true });
  assert.throws(() => assertPortableCoreClosure({
    dependencies: { "@agent-teams/docs-protocol-agent-teams": "1.0.0" },
    entries: ["package/package.json"],
  }), /managed adapter/u);
  assert.throws(() => assertPortableCoreClosure({
    dependencies: {},
    entries: ["package/assets/managed-state.json"],
  }), /managed authority/u);
});

test("hostile policy matrix covers every required deterministic rejection", () => {
  const authority = parseCanaryAuthority(coordinateInput, commit);
  const matrix = hostilePolicyMatrix(authority);
  assert.deepEqual(matrix.map(({ id }) => id), [
    "partial-publication", "missing-adapter", "path-traversal", "absolute-path",
    "backslash-alias", "nfc-alias", "case-alias", "symbolic-link",
    "interruption-before-staging", "cancellation", "stale-transaction", "foreign-change",
  ]);
  assert.ok(matrix.every(({ mode, outcome }) => mode === "deterministic-policy" && outcome === "rejected"));
});

test("canonical receipt validates and digest detects mutation", async () => {
  const authority = parseCanaryAuthority(coordinateInput, commit);
  const receipt = finalizeCanaryReceipt({
    schemaVersion: 1,
    run: { repository: "agent-teams-ai/engineering-foundation", runId: 1, runAttempt: 1, createdAt: "2026-09-04T12:00:00.000Z" },
    authority: { expectedCommit: commit, registry: authority.registry },
    packages: authority.coordinates.map((coordinate) => ({
      ...coordinate, latest: coordinate.version, provenanceCommit: commit, tarballEntries: 3,
    })),
    installs: ["npm", "pnpm"].map((manager) => ({ manager, lockfileDigest: `sha256:${"b".repeat(64)}`, packageCount: 6 })),
    portableNegative: { adapterAbsent: true, forbiddenTermsAbsent: true, lockfileDigest: `sha256:${"c".repeat(64)}` },
    managedQualification: {
      evidenceClass: "local-development", cohortAdmissible: false,
      receiptDigest: `sha256:${"d".repeat(64)}`, sourceUnchanged: true,
    },
    hostile: [
      ...hostilePolicyMatrix(authority),
      { id: "tarball-inventory", mode: "installed-execution", outcome: "passed" },
      { id: "portable-managed-denylist", mode: "installed-execution", outcome: "passed" },
      { id: "managed-interruption-recovery", mode: "installed-execution", outcome: "passed" },
    ],
  });
  const schema = JSON.parse(await readFile(new URL(
    "../architecture/foundation/schemas/public-managed-registry-canary-receipt-v1.schema.json",
    import.meta.url,
  ), "utf8"));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(receipt), true, JSON.stringify(validate.errors));
  assert.doesNotThrow(() => assertCanaryReceiptDigest(receipt));
  assert.throws(() => assertCanaryReceiptDigest({ ...receipt, schemaVersion: 2 }), /digest/u);
});

test("workflow is manual and cannot mutate npm or receive write credentials", async () => {
  const source = await readFile(new URL("../.github/workflows/public-managed-registry-canary.yml", import.meta.url), "utf8");
  const runnerSource = await readFile(new URL("../scripts/public-managed-registry-canary.mjs", import.meta.url), "utf8");
  const workflow = parseYaml(source);
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.jobs.qualify.permissions, undefined);
  assert.equal(JSON.stringify(workflow).includes("secrets."), false);
  assert.equal(JSON.stringify(workflow).includes("id-token"), false);
  assert.doesNotMatch(source, /npm\s+(?:publish|unpublish|deprecate|dist-tag)|pnpm\s+publish/u);
  assert.doesNotMatch(runnerSource, /["'](?:publish|unpublish|deprecate|dist-tag)["']/u);
  assert.match(source, /github\.sha == inputs\.expected_commit/u);
  assert.match(source, /public-managed-registry-canary\.mjs/u);
});
