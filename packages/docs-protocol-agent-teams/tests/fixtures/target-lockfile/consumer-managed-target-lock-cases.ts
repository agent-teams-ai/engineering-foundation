import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createManagedConsumerCommand } from "../../../dist/consumer-integration/adapters/inbound/consumer-integration-cli.js";
import {
  assertCapturedConsumerTargetLockfile,
  validateConsumerTargetLockfile,
  verifyConsumerTargetLockfile,
} from "../../../dist/consumer-integration/adapters/node-consumer-target-lockfile.js";
import { createConsumerUpgradeUseCase } from "../../../dist/consumer-integration/application/use-cases/upgrade-consumer-integration.js";
import type { ConsumerUpgradeOptions } from "../../../dist/consumer-integration/application/use-cases/consumer-upgrade-inspection.js";
import { fixture, forbidden } from "../../consumer-upgrade-generation3-fixture.ts";
import { at, encoded, managedTargetLockFixture } from "./consumer-managed-target-lock-fixture.ts";

const preparationDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

async function selectedLockAdmission(t: TestContext): Promise<void> {
  const f = managedTargetLockFixture();
  const root = await mkdtemp(join(tmpdir(), "TEST-managed-lock-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pnpm-lock.yaml"), f.beforeBytes);
  const profile = Buffer.from(JSON.stringify(f.successor));
  const selected = await validateConsumerTargetLockfile(f.selectedBytes, profile, f.current, root);
  assert.ok(selected);
  assert.deepEqual(selected.bytes, f.selectedBytes);
  for (const [source, target] of [
    [f.current, f.current], [f.successor, f.current], [f.successor, f.successor],
  ] as const) {
    await assert.rejects(
      validateConsumerTargetLockfile(
        f.selectedBytes, Buffer.from(JSON.stringify(target)), source, root,
      ),
      /1->2 or 2->3/u,
    );
  }
  assert.equal(
    await validateConsumerTargetLockfile(undefined, profile, f.current, root), undefined,
  );
  await writeFile(join(root, "pnpm-lock.yaml"), f.selectedBytes);
  await verifyConsumerTargetLockfile(selected, root);
  const operation = {
    path: "pnpm-lock.yaml",
    precondition: {
      state: "known-file" as const,
      acceptedPreimages: [{ bytes: f.beforeBytes, mode: 0o644 }],
    },
    postimage: { bytes: f.selectedBytes, mode: 0o644 },
  };
  assertCapturedConsumerTargetLockfile(selected, [operation]);
  assert.throws(() => assertCapturedConsumerTargetLockfile(selected, []), /Captured target lock/u);
  const rewritten = Buffer.concat([f.selectedBytes, Buffer.from("\n")]);
  await writeFile(join(root, "pnpm-lock.yaml"), rewritten);
  await assert.rejects(verifyConsumerTargetLockfile(selected, root), /bytes changed/u);
  assert.throws(
    () => assertCapturedConsumerTargetLockfile(selected, [
      { ...operation, postimage: { bytes: rewritten, mode: 0o644 } },
    ]),
    /Captured target lock/u,
  );
}

async function selectedLockScope(t: TestContext): Promise<void> {
  const f = managedTargetLockFixture();
  const root = await mkdtemp(join(tmpdir(), "TEST-managed-lock-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pnpm-lock.yaml"), f.beforeBytes);
  const validate = (value: unknown) => validateConsumerTargetLockfile(
    encoded(value), Buffer.from(JSON.stringify(f.successor)), f.current, root,
  );
  const peerVariant = structuredClone(f.after);
  const foundation = "@agent-teams/engineering-foundation@" +
    f.successor.cohort.packages.engineeringFoundation.version;
  at(peerVariant, "snapshots", foundation, "dependencies")["@types/node"] = "24.13.3";
  await assert.rejects(validate(peerVariant), {
    code: "DOCS_CONSUMER_RUNTIME_CLOSURE_MISMATCH",
  });
  for (const mutate of [
    (value: unknown) => { at(value, "settings")["autoInstallPeers"] = false; },
    (value: unknown) => {
      at(value, "importers", ".", "devDependencies", "@types/node")["specifier"] = "changed";
    },
    (value: unknown) => {
      at(value, "importers", "packages/host", "devDependencies", "@types/node")["specifier"] =
        "changed";
    },
    (value: unknown) => {
      at(value, "packages", "@types/node@24.13.3", "resolution")["integrity"] =
        "sha512-" + "B".repeat(86) + "==";
    },
    (value: unknown) => {
      at(value, "snapshots", "foreign-tool@1.0.0")["dependencies"] = {};
    },
  ]) {
    const changed = structuredClone(f.after);
    mutate(changed);
    await assert.rejects(validate(changed), /non-owned/u);
  }
  await assert.rejects(
    validateConsumerTargetLockfile(
      Buffer.from(JSON.stringify(f.after)),
      Buffer.from(JSON.stringify(f.successor)), f.current, root,
    ),
    /comments/u,
  );
  const conflictingSource = structuredClone(f.before);
  at(conflictingSource, "packages", "fast-uri@3.1.7", "resolution")["integrity"] =
    "sha512-" + "B".repeat(86) + "==";
  await writeFile(join(root, "pnpm-lock.yaml"), encoded(conflictingSource));
  await assert.rejects(validate(f.after), /non-owned/u);
}

async function selectedLockForwarding(t: TestContext): Promise<void> {
  const f = await fixture(t);
  const observed = Buffer.from("inert selected input; the sandbox owns graph admission");
  const selection = {
    path: join(f.root, "..", "TEST-selected.yaml"),
    sha256: "sha256:" + "a".repeat(64),
  };
  let reads = 0;
  const upgrade = createConsumerUpgradeUseCase({
    ...f.ports,
    targetLockfile: { read: async (input, root) => {
      reads++;
      assert.deepEqual(input, selection);
      assert.equal(root, f.root);
      return observed;
    } },
    sandbox: { ...f.ports.sandbox, prepareManaged: async (input) => {
      assert.equal(input.targetLockfile, observed);
      return f.ports.sandbox.prepareManaged(input);
    } },
    restoration: {
      prepare: forbidden,
      prepareManaged: async (input) => ({
        path: input.proofPath, digest: preparationDigest,
      }),
    },
  });
  const options = {
    consumerRoot: f.root,
    to: f.successor.cohort.cohortId,
    targetGeneration: 3 as const,
    sourceGeneration: 2 as const,
    prepare: true,
    restorationProofPath: join(f.root, "..", "TEST-selected.prepared"),
    targetLockfile: selection,
  };
  assert.equal((await upgrade(options)).outcome, "prepared");
  assert.equal(reads, 1);
  assert.deepEqual(f.calls, ["prepare"]);
  const { restorationProofPath: _proof, ...withoutProof } = options;
  const invalid: readonly ConsumerUpgradeOptions[] = [
    withoutProof,
    { ...options, prepare: false },
    { ...options, targetLockfile: { ...selection, sha256: "sha256:bad" } },
    ...([[1, 1], [1, 3], [2, 1], [2, 2]] as const).map(
      ([sourceGeneration, targetGeneration]) => ({ ...options, sourceGeneration, targetGeneration }),
    ),
  ];
  for (const input of invalid) {
    const result = await upgrade(input);
    assert.equal(result.outcome, "blocked");
    assert.equal(result.issues[0]?.code, "DOCS_CONSUMER_TARGET_LOCK_INVALID");
  }
  assert.equal(reads, 1);
  assert.deepEqual(f.calls, ["prepare"]);
}

async function selectedLockCli(t: TestContext): Promise<void> {
  const calls: ConsumerUpgradeOptions[] = [];
  const run = createManagedConsumerCommand({
    check: forbidden, plan: forbidden, apply: forbidden, recover: forbidden,
    restore: forbidden, finalize: forbidden,
    upgrade: async (options) => {
      calls.push(options);
      return {
        schemaVersion: 1, command: "consumer.upgrade", outcome: "prepared", issues: [],
        preparation: { path: "/proof.prepared", digest: preparationDigest },
      };
    },
  });
  const argv = (source: number, target: number) => [
    "upgrade", "--to", "target", "--source-generation", String(source),
    "--target-generation", String(target), "--prepare", "--restoration-proof", "/proof",
    "--target-lockfile", "/selected.yaml", "--target-lockfile-sha256",
    "sha256:" + "a".repeat(64), "--json",
  ];
  t.mock.method(process.stdout, "write", () => true);
  t.mock.method(process.stderr, "write", () => true);
  try {
    for (const [source, target] of [[1, 2], [2, 3]] as const) {
      assert.equal(await run(argv(source, target)), 0);
    }
    assert.deepEqual(
      calls.map((entry) => [entry.sourceGeneration, entry.targetGeneration]),
      [[1, 2], [2, 3]],
    );
    assert.deepEqual(calls[1]?.targetLockfile, {
      path: "/selected.yaml", sha256: "sha256:" + "a".repeat(64),
    });
    for (const [source, target] of [[1, 1], [1, 3], [2, 1], [2, 2], [3, 3]] as const) {
      assert.notEqual(await run(argv(source, target)), 0);
    }
    for (const flag of [
      "--prepare", "--restoration-proof", "--source-generation",
      "--target-lockfile", "--target-lockfile-sha256",
    ]) {
      const invalid = argv(2, 3);
      invalid.splice(invalid.indexOf(flag), flag === "--prepare" ? 1 : 2);
      assert.notEqual(await run(invalid), 0);
    }
    assert.equal(calls.length, 2);
  } finally {
    t.mock.restoreAll();
  }
}

export function registerManagedTargetLockTests(): void {
  void test("managed target lock admits only profile3-to4 and retains exact captured bytes", selectedLockAdmission);
  void test("managed target lock rejects peer graph drift and foreign projection mutations", selectedLockScope);
  void test("managed target lock forwards observed bytes and refuses unsupported selections", selectedLockForwarding);
  void test("managed target lock CLI admits bounded preparation pairs and refuses incomplete dispatch", selectedLockCli);
}
