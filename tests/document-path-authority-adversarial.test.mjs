import { assertSchema } from "../packages/document-authoring/dist/document-authoring/adapters/node/schema-catalog.js";
import assert from "node:assert/strict";
import {
  cp,
  link as hardLink,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { NodeDocumentParentMaterializerV2 } from "../packages/document-authoring/dist/document-authoring/adapters/node/node-document-parent-materializer.js";
import { captureNodeRepositoryPathAuthority } from "../packages/document-authoring/dist/document-authoring/adapters/node/node-path-authority.js";
import { NodeDocumentPublisher } from "../packages/document-authoring/dist/document-authoring/adapters/node/node-document-publisher.js";
import { createDocumentTransactionEnvelope as createDocumentTransactionEnvelopeWithSchema } from "../packages/document-authoring/dist/document-authoring/application/policies/document-transaction-envelope-policy.js";
import { envelopeBodyV4 } from "../packages/document-authoring/dist/document-authoring/application/policies/document-transaction-envelope-body.js";
import { materializeDocumentParentDirectories } from "../packages/document-authoring/dist/document-authoring/application/use-cases/document-transaction-continuation.js";
import {
  planDocumentationDocument,
} from "../packages/document-authoring/dist/index.js";

const planningFixtures = fileURLToPath(
  new URL("fixtures/document-planning/orchestrator/", import.meta.url),
);
const qualified = process.platform === "win32" ? test.skip : test;

function directoryPlan() {
  return {
    deepestExistingDirectory: "docs",
    finalParent: "docs/architecture",
    missingDirectories: ["docs/architecture"],
    policy: "create-missing-real-directories",
  };
}

qualified("path authority rejects a post-realpath parent replacement and returns final identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "document-realpath-authority-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const docs = join(root, "docs");
  await mkdir(docs);
  let swapped = false;
  await assert.rejects(
    captureNodeRepositoryPathAuthority({
      consumerRoot: root,
      operations: {
        lstat: (path) => lstat(path, { bigint: true }),
        readdir,
        async realpath(path) {
          const canonical = await realpath(path);
          if (basename(path) === "docs" && !swapped) {
            swapped = true;
            await rename(docs, `${docs}.original`);
            await mkdir(docs);
          }
          return canonical;
        },
      },
      repositoryPath: "docs/output.md",
    }),
    /ancestry identity changed/iu,
  );
  const authority = await captureNodeRepositoryPathAuthority({
    consumerRoot: root,
    repositoryPath: "docs/output.md",
  });
  const finalParent = await lstat(docs, { bigint: true });
  assert.deepEqual(authority.parentIdentity, {
    birthtimeNs: finalParent.birthtimeNs,
    dev: finalParent.dev,
    ino: finalParent.ino,
  });
  assert.equal(authority.destinationPath, join(await realpath(docs), "output.md"));
});

qualified("mkdir replacement cannot be laundered into created-directory evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "document-mkdir-authority-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, "docs"));
  let swapped = false;
  const materializer = new NodeDocumentParentMaterializerV2({
    async lstat(path) {
      const observed = await lstat(path, { bigint: true });
      if (!swapped && path.endsWith(join("docs", "architecture"))) {
        swapped = true;
        await rename(path, `${path}.original`);
        await mkdir(path);
      }
      return observed;
    },
    async syncDirectory() {},
  });
  const journal = await materializer.begin({
    consumerRoot: root,
    plan: directoryPlan(),
  });
  await assert.rejects(
    materializer.createNext({ consumerRoot: root, journal }),
    /changed before|manual recovery/iu,
  );
  assert.equal((await lstat(join(root, "docs/architecture"))).isDirectory(), true);
  assert.equal((await lstat(join(root, "docs/architecture.original"))).isDirectory(), true);
  assert.deepEqual(await materializer.inspect({ consumerRoot: root, journal }), {
    path: "docs/architecture",
    reason: "unbound-directory-exists",
    state: "manual-recovery-required",
  });
});

qualified("post-open recapture rejects a temporary created through swapped symlink ancestry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "document-temp-authority-"));
  const outside = await mkdtemp(join(tmpdir(), "document-temp-outside-"));
  t.after(async () => {
    await rm(root, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  });
  await mkdir(join(root, "docs/decisions"), { recursive: true });
  const fixture = JSON.parse(
    await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("fixtures/document-authoring-contracts/valid-v1.json", import.meta.url), "utf8")),
  );
  let swapped = false;
  const publisher = new NodeDocumentPublisher({
    async open(path, flags, mode) {
      if (!swapped) {
        swapped = true;
        await rename(join(root, "docs/decisions"), join(root, "docs/decisions.original"));
        await symlink(outside, join(root, "docs/decisions"), "dir");
      }
      return open(path, flags, mode);
    },
    async syncDirectoryStrictly() {},
  });
  await assert.rejects(
    publisher.prepare({ consumerRoot: root, plan: fixture.plan }),
    /real directory|redirected|ancestry|parent changed/iu,
  );
  assert.equal(swapped, true);
  assert.equal((await readdir(outside)).length, 1);
});

qualified("root replacement during temporary open is never accepted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "document-root-authority-"));
  const originalRoot = `${root}.original`;
  t.after(async () => {
    await rm(root, { force: true, recursive: true });
    await rm(originalRoot, { force: true, recursive: true });
  });
  await mkdir(join(root, "docs/decisions"), { recursive: true });
  const fixture = JSON.parse(
    await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("fixtures/document-authoring-contracts/valid-v1.json", import.meta.url), "utf8")),
  );
  const publisher = new NodeDocumentPublisher({
    async open(path, flags, mode) {
      await rename(root, originalRoot);
      await mkdir(join(root, "docs/decisions"), { recursive: true });
      return open(path, flags, mode);
    },
    async syncDirectoryStrictly() {},
  });
  await assert.rejects(
    publisher.prepare({ consumerRoot: root, plan: fixture.plan }),
    /root|ancestry|parent changed/iu,
  );
  assert.equal((await readdir(join(root, "docs/decisions"))).length, 1);
});

qualified("a link through replaced ancestry is never accepted as publication", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "document-link-authority-"));
  const outside = await mkdtemp(join(tmpdir(), "document-link-outside-"));
  t.after(async () => {
    await rm(root, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  });
  await mkdir(join(root, "docs/decisions"), { recursive: true });
  const fixture = JSON.parse(
    await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("fixtures/document-authoring-contracts/valid-v1.json", import.meta.url), "utf8")),
  );
  const temporary = await new NodeDocumentPublisher({
    async syncDirectoryStrictly() {},
  }).prepare({ consumerRoot: root, plan: fixture.plan });
  let linked = false;
  const publisher = new NodeDocumentPublisher({
    async link(source, destination) {
      const original = join(root, "docs/decisions.original");
      await rename(join(root, "docs/decisions"), original);
      await hardLink(join(original, basename(source)), join(outside, basename(source)));
      await symlink(outside, join(root, "docs/decisions"), "dir");
      await hardLink(source, destination);
      linked = true;
    },
    async syncDirectoryStrictly() {},
  });
  await assert.rejects(
    publisher.publishPrepared({ consumerRoot: root, plan: fixture.plan, temporary }),
    /ancestry changed|real directory|redirected/iu,
  );
  assert.equal(linked, true);
  assert.equal((await lstat(join(outside, basename(fixture.plan.destination)))).isFile(), true);
});

async function featurePlanV2(root) {
  await cp(planningFixtures, root, { recursive: true });
  const { cases, profilePath } = JSON.parse(
    await import("node:fs/promises").then(({ readFile }) =>
      readFile(join(root, "cases.json"), "utf8")),
  );
  const vector = cases.find(({ name }) => name === "feature");
  const { readFile, writeFile } = await import("node:fs/promises");
  const source = await readFile(join(root, profilePath), "utf8");
  await writeFile(join(root, profilePath), source
    .replace("schemaVersion: 1", "schemaVersion: 2")
    .replaceAll(/(    - type: [^\n]+\n)/gu,
      "$1      allowedOwnerIds: [architecture/tooling, example/create-widget]\n")
    .replace("reachability: {kind: not-required}",
      "reachability: {kind: not-required, reason: indexed by bounded-context hierarchy}"));
  await rm(join(root, "packages/example/src/features/create-widget"), {
    force: true,
    recursive: true,
  });
  return planDocumentationDocument({
    consumerRoot: root,
    profilePath,
    intent: vector.intent,
    parentPolicy: "create-missing-real-directories",
  });
}

qualified("transaction materialization never journals a successfully replaced mkdir", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "document-materialize-authority-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const plan = await featurePlanV2(root);
  let swapped = false;
  const firstMissing = plan.parentMaterialization.missingDirectories[0];
  const materializer = new NodeDocumentParentMaterializerV2({
    async lstat(path) {
      const observed = await lstat(path, { bigint: true });
      if (!swapped && path.endsWith(firstMissing)) {
        swapped = true;
        await rename(path, `${path}.original`);
        await mkdir(path);
      }
      return observed;
    },
    async syncDirectory() {},
  });
  const parentJournal = await materializer.begin({
    consumerRoot: root,
    plan: plan.parentMaterialization,
  });
  const envelope = await createDocumentTransactionEnvelope(
    envelopeBodyV4(plan, parentJournal, { destination: "pending", state: "PREPARED" }),
  );
  const identity = {
    adapter: "node-filesystem",
    birthtimeNs: "1",
    dev: "1",
    ino: "1",
    version: 1,
  };
  let currentEnvelope = envelope;
  let replacements = 0;
  const runtime = {
    schema: { assertSchema },
    coordinator: {},
    journal: {
      async replace({ envelope: replacement }) {
        currentEnvelope = replacement;
        replacements += 1;
        return {
          authorityDigest: `sha256:${"1".repeat(64)}`,
          identity,
        };
      },
    },
    parentMaterializer: materializer,
  };
  await assert.rejects(
    materializeDocumentParentDirectories(
      runtime,
      { consumerRoot: root },
      {
        authority: {
          authorityDigest: `sha256:${"0".repeat(64)}`,
          identity,
        },
        envelope,
      },
    ),
    /ambiguous|manual recovery/iu,
  );
  assert.equal(replacements, 1);
  assert.equal(currentEnvelope.state, "MATERIALIZING");
  assert.deepEqual(currentEnvelope.journal.parentMaterialization.createdDirectories, []);
  assert.equal(
    currentEnvelope.journal.parentMaterialization.pendingDirectory,
    plan.parentMaterialization.missingDirectories[0],
  );
});

function createDocumentTransactionEnvelope(...args) { return createDocumentTransactionEnvelopeWithSchema({ assertSchema }, ...args); }
