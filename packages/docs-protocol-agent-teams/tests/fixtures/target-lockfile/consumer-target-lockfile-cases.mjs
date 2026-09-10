import assert from "node:assert/strict";
import { realpath, mkdtemp, mkdir, writeFile, rm, symlink, link, open, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { nodeConsumerTargetLockfileReader } from "../../../dist/consumer-integration/adapters/node-consumer-target-lockfile.js";
import { assertQualifiedPnpmLockfileV2 } from "../../../dist/consumer-integration/adapters/pnpm-lockfile-validator-v2.js";
import { computePnpmRuntimeClosureDigestV2 } from "../../../dist/consumer-integration/adapters/pnpm-runtime-closure-v2.js";
import { assertRestorationLockScope } from "../../../dist/consumer-integration/adapters/node-consumer-restoration-lock.js";
import { lockfileFor } from "../../consumer-upgrade-e2e-fixtures.mjs";

import { historicalTargetLock, candidate, digest, expected, lock, packages, target, bytes } from "./consumer-target-lockfile-fixture.mjs";

const commented = value => Buffer.concat([Buffer.from("# consumer-owned\n"), bytes(value)]);
const readConsumerTargetLockfile = nodeConsumerTargetLockfileReader.read;

export function registerConsumerTargetLockfileTests() {
test("target lock specimen proves exact ce9b89 to e2c56ef six-delta regression", () => {
  assert.equal(digest(candidate), "sha256:2f4fb89fe7bd03af852272a260a2b6b56276c18c1dee2f6653eb4109c57f2500");
  assert.equal(computePnpmRuntimeClosureDigestV2(lock, target.cohort), expected);
  assert.doesNotThrow(() => assertQualifiedPnpmLockfileV2(candidate, target));
  const old = historicalTargetLock();
  assert.equal(computePnpmRuntimeClosureDigestV2(old, target.cohort),
    "sha256:ce9b89a64b3b5fa9ed76d5ef5f62d77cf3f5c971746da4f320b2288275744fd8");
  assert.throws(() => assertQualifiedPnpmLockfileV2(bytes(old), target), { code: "DOCS_CONSUMER_RUNTIME_CLOSURE_MISMATCH" });
});

test("target lock rejects provenance, SRI, aliases, internal edges, peer context and duplicate YAML", () => {
  const authoring = `@agent-teams/document-authoring@${packages.documentAuthoring.version}`;
  for (const mutate of [
    value => {value.packages[authoring].resolution.integrity = "sha512-invalid";},
    value => {value.packages[authoring].resolution.integrity = `sha512-${"A".repeat(86)}==`;},
    value => {value.packages["fast-uri@3.1.7"].resolution.tarball = "https://foreign.invalid/fast-uri.tgz";},
    value => {value.packages["fast-uri@3.1.7"].resolution.type = "git";},
    value => {delete value.snapshots[authoring].dependencies["@agent-teams/repository-mutation"];},
    value => {value.importers["."].devDependencies.alias = { specifier: `npm:${authoring}`, version: authoring };},
    value => {value.snapshots[`${authoring}(foreign@1.0.0)`] = value.snapshots[authoring]; delete value.snapshots[authoring];},
    value => {delete value.snapshots["fast-uri@3.1.7"];}
  ]) {
    const value = structuredClone(lock); mutate(value);
    assert.throws(() => assertQualifiedPnpmLockfileV2(bytes(value), target));
  }
  assert.throws(() => assertQualifiedPnpmLockfileV2(Buffer.concat([candidate, Buffer.from("\nsettings: {}\n")]), target));
});

test("target lock scope preserves original comments, settings, importers and foreign graph conflicts", () => {
  const source = { cohort: { packages: {
    docsProtocol: { version: "0.1.0", integrity: packages.docsProtocol.integrity },
    engineeringFoundation: { version: "0.1.0", integrity: packages.engineeringFoundation.integrity }
  }, runtime: { runtimeClosureDigest: `sha256:${"0".repeat(64)}` } } };
  const before = parse(lockfileFor(source.cohort));
  const after = structuredClone(lock);
  for (const value of [before, after]) {
    value.importers["."].devDependencies.foreign = { specifier: "1.0.0", version: "1.0.0" };
    value.packages["foreign@1.0.0"] = { resolution: { integrity: packages.docsProtocol.integrity } };
    value.snapshots["foreign@1.0.0"] = {};
  }
  assert.doesNotThrow(() => assertRestorationLockScope(commented(before), commented(after), source, target));
  assert.throws(() => assertRestorationLockScope(commented(before), bytes(after), source, target), /comments/u);
  for (const mutate of [
    value => {value.settings.autoInstallPeers = false;},
    value => {value.importers.extra = {};},
    value => {value.packages["foreign@1.0.0"].resolution.integrity = "changed";},
    value => {value.snapshots["foreign@1.0.0"].dependencies = { "fast-uri": "3.1.7" };}
  ]) {
    const value = structuredClone(after); mutate(value);
    assert.throws(() => assertRestorationLockScope(bytes(before), bytes(value), source, target), /non-owned/u);
  }
});

test("target lock stable input rejects digest, bounds and forbidden paths; retained bytes survive replacement", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "TEST-target-lock-input-")));
  const consumer = join(root, "consumer"), path = join(root, "target.yaml");
  await mkdir(consumer);
  const selected = { path, sha256: digest(candidate) };
  try {
    await writeFile(path, candidate);
    const retained = await readConsumerTargetLockfile(selected, consumer);
    await rename(path, `${path}.old`);
    await writeFile(path, "replacement");
    assert.deepEqual(retained, candidate);
    await assert.rejects(readConsumerTargetLockfile(selected, consumer), /SHA256/u);
    await assert.rejects(readConsumerTargetLockfile({ ...selected, sha256: "sha256:BAD" }, consumer), /SHA256/u);
    await rm(path); await symlink(`${path}.old`, path);
    await assert.rejects(readConsumerTargetLockfile(selected, consumer), /symlink|changed during observation/u);
    await rm(path); await link(`${path}.old`, path);
    await assert.rejects(readConsumerTargetLockfile(selected, consumer), /hardlinked/u);
    await rm(path); await writeFile(path, "");
    await assert.rejects(readConsumerTargetLockfile(selected, consumer), /bounded/u);
    const handle = await open(path, "w");
    await handle.truncate(32 * 1024 * 1024 + 1); await handle.close();
    await assert.rejects(readConsumerTargetLockfile(selected, consumer), /bounded/u);
    await writeFile(join(consumer, "lock.yaml"), candidate);
    for (const forbidden of [join(consumer, "lock.yaml"), fileURLToPath(new URL("../../../package.json", import.meta.url)),
      fileURLToPath(new URL("../../../../repository-mutation/package.json", import.meta.url))]) {
      await assert.rejects(readConsumerTargetLockfile({ ...selected, path: forbidden }, consumer), /outside/u);
    }
    await symlink(root, join(root, "alias"));
    await assert.rejects(readConsumerTargetLockfile({ ...selected, path: join(root, "alias/target.yaml") }, consumer), /canonical/u);
    await assert.rejects(readConsumerTargetLockfile({ ...selected, path: "relative.yaml" }, consumer), /absolute/u);
    await assert.rejects(readConsumerTargetLockfile({ ...selected, path: root }, consumer), /regular/u);
  } finally {await rm(root, { recursive: true, force: true });}
});

test("target lock rejects replacement and growth during the bounded descriptor read", async (t) => {
  const fs = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const root = await realpath(await mkdtemp(join(tmpdir(), "TEST-target-lock-race-")));
  const consumer = join(root, "consumer"), path = join(root, "lock.yaml");
  await mkdir(consumer);
  const originalOpen = fs.open;
  try {
    for (const mutate of [
      async () => {await rename(path, `${path}.old`); await writeFile(path, candidate);},
      async () => {await fs.appendFile(path, "growth");}
    ]) {
      await writeFile(path, candidate);
      let reads = 0;
      t.mock.method(fs, "open", async (...args) => {
        const handle = await originalOpen(...args);
        if (args[0] === path) {
          const read = handle.read.bind(handle);
          handle.read = async (...readArgs) => {
            const result = await read(...readArgs);
            if (reads++ === 0) {await mutate();}
            return result;
          };
        }
        return handle;
      });
      syncBuiltinESMExports();
      await assert.rejects(readConsumerTargetLockfile({ path, sha256: digest(candidate) }, consumer), /changed during observation/u);
      assert.ok(reads <= 2, "reader never follows unbounded file growth");
      t.mock.restoreAll(); syncBuiltinESMExports();
    }
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports(); await rm(root, { recursive: true, force: true });
  }
});

}
