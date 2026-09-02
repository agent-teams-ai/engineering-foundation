import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { sha256Json as sha256DocumentJson } from "../packages/engineering-foundation/dist/canonical-json.js";
import { installedFoundationBuildIdentity } from "../packages/engineering-foundation/dist/transaction-coordination/adapters/node/installed-foundation-build-identity.js";
import { NodeFoundationTransactionSlot } from "../packages/engineering-foundation/dist/transaction-coordination/adapters/node/node-foundation-transaction-slot.js";
import {
  planScaffoldFromFile,
} from "../packages/engineering-foundation/dist/scaffolding/index.js";
import { sha256Json as sha256ScaffoldingJson } from "../packages/engineering-foundation/dist/scaffolding/kernel/canonical-json.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const fixture = JSON.parse(
  await readFile(
    join(
      repositoryRoot,
      "tests/fixtures/document-authoring-contracts/legacy-envelope-v2-0.13.1.json",
    ),
    "utf8",
  ),
);
function legacyCanonicalJson(value) {
  if (Array.isArray(value)) {return "[" + value.map(legacyCanonicalJson).join(",") + "]";}
  if (typeof value === "object" && value !== null) {return "{" + Object.entries(value).toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ":" + legacyCanonicalJson(item)).join(",") + "}";}
  return JSON.stringify(value);
}

function sha256LegacyJson(value) {
  return "sha256:" + createHash("sha256").update(legacyCanonicalJson(value)).digest("hex");
}

const installedBuildIdentity = await installedFoundationBuildIdentity();

function slotPath(root) {
  return join(root, ".agent-teams-local", "scaffolding-transaction.json");
}

async function writeEnvelope(root, envelope) {
  const path = slotPath(root);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
}

function legacyEdgeEnvelope(version, buildIdentity, expected) {
  const envelope = structuredClone(fixture);
  envelope.foundation = { version, buildIdentity };
  envelope.journal.plan.compiler.version = version;
  envelope.journal.plan.compiler.buildIdentity = buildIdentity;
  envelope.journal.plan.intent.additionalMetadata.n = -0;
  envelope.journal.plan.intent.additionalMetadata.lone = "\ud800";
  envelope.journal.plan.intentDigest = expected.intentDigest;
  envelope.journal.plan.planDigest = expected.planDigest;
  envelope.payloadDigest = expected.payloadDigest;
  envelope.envelopeDigest = expected.envelopeDigest;
  return envelope;
}

test("preserves an exact 0.13.1 document envelope as verified legacy evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-legacy-envelope-"));
  try {
    await writeEnvelope(root, fixture);
    const before = await readFile(slotPath(root));
    const status = await new NodeFoundationTransactionSlot({
      consumerRoot: root,
      installedBuildIdentity,
      installedVersion: "0.13.1",
    }).inspect();
    assert.equal(status.state, "manual-recovery-required");
    assert.equal(status.reason, "recovery-handler-unavailable");
    assert.equal(status.operationKind, "document-authoring");
    assert.equal(status.foundationVersion, "0.13.1");
    assert.equal(status.foundationBuildIdentity, fixture.foundation.buildIdentity);
    assert.deepEqual(await readFile(slotPath(root)), before);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("does not use legacy digest semantics for an unrecognized build", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-legacy-envelope-"));
  try {
    const envelope = structuredClone(fixture);
    const unknownBuild = `sha256:${"e".repeat(64)}`;
    envelope.foundation.buildIdentity = unknownBuild;
    envelope.journal.plan.compiler.buildIdentity = unknownBuild;
    envelope.payloadDigest = sha256DocumentJson(envelope.journal);
    const { envelopeDigest: _digest, ...body } = envelope;
    envelope.envelopeDigest = sha256DocumentJson(body);
    await writeEnvelope(root, envelope);
    const before = await readFile(slotPath(root));
    const status = await new NodeFoundationTransactionSlot({
      consumerRoot: root,
      installedBuildIdentity,
      installedVersion: "0.13.1",
    }).inspect();
    assert.equal(status.state, "manual-recovery-required");
    assert.equal(status.reason, "corrupt-or-incompatible");
    assert.deepEqual(await readFile(slotPath(root)), before);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("does not route a same-build scaffolding envelope through the document legacy verifier", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-legacy-envelope-"));
  try {
    const authorityRoot = join(
      repositoryRoot,
      "tests/fixtures/scaffolding-authority-consumer",
    );
    const planned = await planScaffoldFromFile({
      consumerRoot: authorityRoot,
      intentPath: "intents/create-fixture.yaml",
    });
    const plan = structuredClone(planned);
    const buildIdentity = fixture.foundation.buildIdentity;
    plan.compiler.version = "0.13.1";
    const { planDigest: _planDigest, ...planBody } = plan;
    plan.planDigest = sha256ScaffoldingJson(planBody);
    const journal = {
      schemaVersion: 1,
      state: "PREPARED",
      plan,
      operations: plan.operations.map((operation) => ({
        operationId: operation.id,
        path: operation.path,
        state: "pending",
      })),
    };
    const envelope = {
      schemaVersion: 2,
      operationKind: "scaffolding",
      recoveryHandler: { id: "foundation.scaffolding", contractVersion: 1 },
      foundation: { version: "0.13.1", buildIdentity },
      adapterContractVersion: 1,
      payloadKind: "scaffold-recovery-journal/v1",
      journal,
      payloadDigest: sha256ScaffoldingJson(journal),
      state: "PREPARED",
    };
    envelope.envelopeDigest = sha256ScaffoldingJson(envelope);
    await writeEnvelope(root, envelope);
    const status = await new NodeFoundationTransactionSlot({
      consumerRoot: root,
      installedBuildIdentity,
      installedVersion: "0.13.1",
    }).inspect();
    assert.equal(status.state, "manual-recovery-required");
    assert.equal(status.reason, "recovery-handler-unavailable");
    assert.equal(status.operationKind, "scaffolding");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("verifies current scaffolding envelope digests with frozen scaffolding canonicalization", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-scaffolding-envelope-"));
  try {
    const authorityRoot = join(
      repositoryRoot,
      "tests/fixtures/scaffolding-authority-consumer",
    );
    const plan = structuredClone(await planScaffoldFromFile({
      consumerRoot: authorityRoot,
      intentPath: "intents/create-fixture.yaml",
    }));
    plan.resolved.recipeParameters.edgeNumber = -0;
    plan.resolved.recipeParameters.edgeString = "\ud800";
    const { planDigest: _planDigest, ...planBody } = plan;
    plan.planDigest = sha256LegacyJson(planBody);
    const journal = {
      schemaVersion: 1,
      state: "PREPARED",
      plan,
      operations: plan.operations.map((operation) => ({
        operationId: operation.id,
        path: operation.path,
        state: "pending",
      })),
    };
    const envelope = {
      schemaVersion: 2,
      operationKind: "scaffolding",
      recoveryHandler: { id: "foundation.scaffolding", contractVersion: 1 },
      foundation: { version: plan.compiler.version, buildIdentity: installedBuildIdentity },
      adapterContractVersion: 1,
      payloadKind: "scaffold-recovery-journal/v1",
      journal,
      payloadDigest: sha256LegacyJson(journal),
      state: "PREPARED",
    };
    envelope.envelopeDigest = sha256LegacyJson(envelope);
    const serialized = `${JSON.stringify(envelope, null, 2)}\n`.replace(
      '"edgeNumber": 0',
      '"edgeNumber": -0',
    );
    assert.match(serialized, /"edgeNumber": -0/u);
    await mkdir(dirname(slotPath(root)), { recursive: true });
    await writeFile(slotPath(root), serialized, "utf8");

    const status = await new NodeFoundationTransactionSlot({
      consumerRoot: root,
      installedBuildIdentity,
      installedVersion: plan.compiler.version,
    }).inspect();
    assert.equal(status.state, "manual-recovery-required");
    assert.equal(status.reason, "recovery-handler-unavailable");
    assert.equal(status.operationKind, "scaffolding");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("does not accept frozen scaffolding digest semantics for a current document envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-document-envelope-"));
  try {
    const envelope = structuredClone(fixture);
    const unknownBuild = `sha256:${"e".repeat(64)}`;
    envelope.foundation.buildIdentity = unknownBuild;
    envelope.journal.plan.compiler.buildIdentity = unknownBuild;
    envelope.journal.plan.intent.additionalMetadata.n = -0;
    envelope.journal.plan.intent.additionalMetadata.lone = "\ud800";
    envelope.payloadDigest = sha256LegacyJson(envelope.journal);
    const { envelopeDigest: _envelopeDigest, ...body } = envelope;
    envelope.envelopeDigest = sha256LegacyJson(body);
    await writeEnvelope(root, envelope);

    const status = await new NodeFoundationTransactionSlot({
      consumerRoot: root,
      installedBuildIdentity,
      installedVersion: "0.13.1",
    }).inspect();
    assert.equal(status.state, "manual-recovery-required");
    assert.equal(status.reason, "corrupt-or-incompatible");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("does not reinterpret a corrected-shape Intent as a legacy envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-legacy-envelope-"));
  try {
    const envelope = structuredClone(fixture);
    envelope.journal.plan.intent.slug = "deterministic-documentation-authoring";
    envelope.journal.plan.intentDigest = sha256DocumentJson(envelope.journal.plan.intent);
    const { planDigest: _planDigest, ...planBody } = envelope.journal.plan;
    envelope.journal.plan.planDigest = sha256DocumentJson(planBody);
    envelope.payloadDigest = sha256DocumentJson(envelope.journal);
    const { envelopeDigest: _envelopeDigest, ...envelopeBody } = envelope;
    envelope.envelopeDigest = sha256DocumentJson(envelopeBody);
    await writeEnvelope(root, envelope);
    const status = await new NodeFoundationTransactionSlot({
      consumerRoot: root,
      installedBuildIdentity,
      installedVersion: "0.13.1",
    }).inspect();
    assert.equal(status.state, "manual-recovery-required");
    assert.equal(status.reason, "corrupt-or-incompatible");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

for (const vector of [
  {
    version: "0.13.0",
    buildIdentity: "sha256:f2790b0ad34abf94aa7b44f2d590c77dfcd1119b4a6cfb2dcb1fa4a80f40cc84",
    intentDigest: "sha256:56924fe1d29265d5f18cab22311731a2e297c0dd5b4e3f4e73b866cabb5e3a11",
    planDigest: "sha256:d03d17ed71e13e1374a88dce03111c8b51e18f3e7341c05127940c2b8b655c1f",
    payloadDigest: "sha256:16f0c171a34e03a221b790ce870cb2a4cd099a527e6bb805dfb2d8b257bdb6cf",
    envelopeDigest: "sha256:1ddcd48db05de319a92eda9d01451be28dc27e22bf9d7da892f5067952aac72c",
  },
  {
    version: "0.13.1",
    buildIdentity: "sha256:39dd226ddd4cd861a2535cc59b2fe5c1a23f0e5b2c4be3190851b87f27ad3072",
    intentDigest: "sha256:56924fe1d29265d5f18cab22311731a2e297c0dd5b4e3f4e73b866cabb5e3a11",
    planDigest: "sha256:9c6baae4e7e3639257579c1d392e842a5c4aeb69527020f47f80105e5d28e9ba",
    payloadDigest: "sha256:8c53a99bb8cabd50ceff0780f59bc5466d596488222e6a551e5b5a63a32da818",
    envelopeDigest: "sha256:c7a26adf8fcdf8173ed533ea928d96eb74495965e20ff79c9163363ee6049dfe",
  },
]) {
  test(`preserves ${vector.version} legacy -0 and lone-surrogate evidence`, async () => {
    const root = await mkdtemp(join(tmpdir(), "foundation-legacy-envelope-"));
    try {
      const envelope = legacyEdgeEnvelope(
        vector.version,
        vector.buildIdentity,
        vector,
      );
      await writeEnvelope(root, envelope);
      const before = await readFile(slotPath(root));
      const status = await new NodeFoundationTransactionSlot({
        consumerRoot: root,
        installedBuildIdentity,
        installedVersion: vector.version,
      }).inspect();
      assert.equal(status.state, "manual-recovery-required");
      assert.equal(status.reason, "recovery-handler-unavailable");
      assert.deepEqual(await readFile(slotPath(root)), before);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
}
