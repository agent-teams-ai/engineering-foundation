/* oxlint-disable max-lines-per-function -- Sequential hostile cases share one disposable migration. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, cp, lstat, mkdir, open, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { sha256Bytes, sha256Json, compileKnownFileTransactionPlan, recoverKnownFileTransaction, inspectKnownFileTransactionBarrier } from "@agent-teams/repository-mutation";
import { acquireMutationLease, releaseMutationLease } from "@agent-teams/repository-mutation/node";
import { packageRoot } from "./consumer-upgrade-e2e-fixtures.mjs";
import { managedRestorationFixture, fixtureProcess } from "./consumer-restoration-fixture.mjs";
import { retrievalTree, retrievalStoreCopy, withRetrievalEnvironment } from "./consumer-restoration-retrieval-fixture.mjs";
import { restorationArgs, restorationCli, assertCliSuccess, resealRestorationProof } from "./consumer-restoration-cli-fixture.mjs";
import { restorationJson } from "../dist/consumer-integration/application/policies/consumer-restoration-proof.js";
import { GitHubCohortAuthorityReader, projectQualifiedCohortAuthority } from "../dist/consumer-integration/adapters/github-cohort-authority-reader.js";

async function snapshot(root, prefix = "") {
  const result = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if ([".git", ".agent-teams-local", "node_modules"].includes(entry.name)) {continue;}
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {Object.assign(result, await snapshot(root, path)); continue;}
    result[path] = { bytes: (await readFile(join(root, path))).toString("base64"), mode: (await lstat(join(root, path))).mode & 0o777 };
  }
  return result;
}

const uri = (path) => pathToFileURL(join(packageRoot, path)).href;

function killInverse(fixture, expect, phase) {
  const script = `
import {restoreNodeConsumerIntegration} from ${JSON.stringify(uri("dist/consumer-integration/adapters/node-consumer-restoration.js"))};
import {NodeConsumerUpgradeSandbox} from ${JSON.stringify(uri("dist/consumer-integration/adapters/node-consumer-upgrade-sandbox.js"))};
import {applyKnownFileTransactionWithFaults} from ${JSON.stringify(uri("../repository-mutation/dist/repository-mutation/adapters/node/node-known-file-transaction.js"))};
const projection=cohort=>({repository:'agent-teams-ai/.github',path:'governance/docs-qualified-cohorts.json',revision:'8'.repeat(40),cohort});
await restoreNodeConsumerIntegration(${JSON.stringify({ ...fixture.restoreOptions, expect })}, {
 authority:{readRestoration:async()=>({source:projection(${JSON.stringify(fixture.target)}),target:projection(${JSON.stringify(fixture.origin)})})},
 sandbox:new NodeConsumerUpgradeSandbox(),
 apply:options=>applyKnownFileTransactionWithFaults({...options,faultInjector:point=>{if(point.phase===${JSON.stringify(phase)}) process.kill(process.pid,'SIGKILL');}})
});`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (data) => {stderr += data;});
    child.once("error", reject);
    child.once("close", (code, signal) => {
      try {assert.equal(signal, "SIGKILL", `code=${code}: ${stderr}`); resolve();} catch (error) {reject(error);}
    });
  });
}

// Real live ChildProcess: the fault injector pauses in place and signals readiness instead of
// self-terminating, so the external SIGTERM below lands deterministically mid-transaction.
function terminateInverse(fixture, expect, phase) {
  const sentinel = "FAULT_POINT_REACHED";
  const script = `
import {restoreNodeConsumerIntegration} from ${JSON.stringify(uri("dist/consumer-integration/adapters/node-consumer-restoration.js"))};
import {NodeConsumerUpgradeSandbox} from ${JSON.stringify(uri("dist/consumer-integration/adapters/node-consumer-upgrade-sandbox.js"))};
import {applyKnownFileTransactionWithFaults} from ${JSON.stringify(uri("../repository-mutation/dist/repository-mutation/adapters/node/node-known-file-transaction.js"))};
const projection=cohort=>({repository:'agent-teams-ai/.github',path:'governance/docs-qualified-cohorts.json',revision:'8'.repeat(40),cohort});
await restoreNodeConsumerIntegration(${JSON.stringify({ ...fixture.restoreOptions, expect })}, {
 authority:{readRestoration:async()=>({source:projection(${JSON.stringify(fixture.target)}),target:projection(${JSON.stringify(fixture.origin)})})},
 sandbox:new NodeConsumerUpgradeSandbox(),
 apply:options=>applyKnownFileTransactionWithFaults({...options,faultInjector:async point=>{if(point.phase===${JSON.stringify(phase)}){process.stderr.write(${JSON.stringify(`${sentinel}\n`)});await new Promise(r=>setTimeout(r,10000));}}})
});`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let terminated = false;
    child.stderr.on("data", (data) => {
      stderr += data;
      if (!terminated && stderr.includes(sentinel)) {
        terminated = true;
        child.kill("SIGTERM");
      }
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      try {
        assert.equal(terminated, true, `fault point ${phase} was never reached: ${stderr}`);
        assert.equal(signal, "SIGTERM", `code=${code}: ${stderr}`);
        resolve();
      } catch (error) {reject(error);}
    });
  });
}

const absent = async (path) => assert.rejects(readFile(path), { code: "ENOENT" });

function assertNativeMissing(result, fixture) {
  assert.notEqual(result.code, 0, JSON.stringify(result));
  assert.equal(result.signal, null);
  assert.notEqual(result.execution?.outcome, "upgraded");
  assert.notEqual(result.execution?.outcome, "prepared");
  const message = result.execution.issues[0].message;
  assert.match(message, /ERR_PNPM_NO_OFFLINE_TARBALL/u);
  assert.ok(message.includes(`/@agent-teams/docs-protocol-agent-teams/-/docs-protocol-agent-teams-${fixture.target.packages.docsProtocolAgentTeams.version}.tgz`), message);
  assert.doesNotMatch(result.stderr, /real target activation passed/u);
}

export function registerConsumerRestorationTests(helpers) {
  // Supporting native-source evidence only; published R2 still requires root's accepted full store.
  for (const phase of ["before-prepare", "late-finalize"]) {
    test(`native retrieval ${phase}: exact missing adapter row`, async (t) => {
      const fixture = await managedRestorationFixture({ ...helpers, isolatedStore: true });
      const previousTmpdir = process.env.TMPDIR;
      try {
        // All native staging registrations belong to this disposable TEST fixture.
        process.env.TMPDIR = join(fixture.disposable, "retrieval-staging");
        await mkdir(process.env.TMPDIR);
        const original = await snapshot(fixture.consumerRoot);
        const seeded = await fixture.upgrade(fixture.upgradeOptions);
        assert.equal(seeded.outcome, "upgraded", JSON.stringify(seeded));
        assert.equal((await fixture.restore({ expect: seeded.restoration.digest })).outcome, "restored");
        assert.equal((await fixture.oldCheck()).fixtureCli, "historical-v1");
        assert.deepEqual(await snapshot(fixture.consumerRoot), original);
        const store = await retrievalStoreCopy(fixture, `store-${phase}`, (message) => t.diagnostic(message));
        const proofPath = join(fixture.disposable, `${phase}.json`);
        const seedProof = await readFile(fixture.proofPath);
        const seedPreparation = await readFile(`${fixture.proofPath}.prepared`);
        await withRetrievalEnvironment(store.destination, async () => {
          if (phase === "before-prepare") {
            await store.remove();
            assert.equal((await fixtureProcess("git", ["status", "--porcelain"], fixture.consumerRoot)).trim(), "");
            assert.equal((await fixtureProcess("git", ["rev-parse", "HEAD"], fixture.consumerRoot)).trim(), fixture.sourceRevision);
            const before = await retrievalTree(fixture.consumerRoot, [".agent-teams-local"]);
            const result = await restorationCli(fixture, ["upgrade", "--consumer", fixture.consumerRoot,
              "--source-generation", "1", "--target-generation", "2", "--to", fixture.target.cohortId,
              "--restoration-proof", proofPath, "--prepare", "--json"], { label: "native-before-prepare" });
            assertNativeMissing(result, fixture);
            assert.equal(result.execution.command, "consumer.upgrade");
            assert.equal(result.execution.outcome, "blocked");
            assert.equal(result.execution.issues[0].code, "DOCS_CONSUMER_UPGRADE_PROCESS_FAILED");
            assert.match(result.execution.issues[0].message, /<local-path>/u);
            assert.equal(result.execution.preparation, undefined);
            assert.equal(result.execution.receipt, undefined);
            assert.equal(result.execution.restoration, undefined);
            await absent(`${proofPath}.prepared`);
            await absent(`${proofPath}.receipt`);
            await absent(proofPath);
            assert.deepEqual(await retrievalTree(fixture.consumerRoot, [".agent-teams-local"]), before);
          } else {
            const prepared = await fixture.prepare({ ...fixture.upgradeOptions, restorationProofPath: proofPath });
            assert.equal(prepared.outcome, "prepared", JSON.stringify(prepared));
            const selection = prepared.preparation;
            const selectedBytes = await readFile(selection.path);
            await store.remove();
            const args = restorationArgs(fixture, "finalize", selection, proofPath);
            const failure = await restorationCli(fixture, args, { label: "native-late-finalize-failure" });
            assertNativeMissing(failure, fixture);
            await absent(proofPath);
            assert.equal(failure.execution.restoration, undefined);
            const receiptBytes = await readFile(`${proofPath}.receipt`);
            const retained = JSON.parse(receiptBytes);
            assert.equal(retained.preparationDigest, selection.digest);
            assert.equal(retained.receipt.outcome, "applied");
            assert.ok(retained.receipt.operations.every(({ outcome }) => outcome === "replaced"));
            assert.equal(retained.activation, undefined);
            // Apply has completed; installed-tree atomicity is deliberately not claimed here.
            const intent = JSON.parse(selectedBytes);
            for (const operation of intent.plan.operations) {
              assert.equal(sha256Bytes(await readFile(join(fixture.consumerRoot, operation.path))), operation.postimage.digest);
            }
            const failureBytes = `${JSON.stringify(failure, null, 2)}\n`;
            const failurePath = join(fixture.disposable, "native-late-finalize-failure.json");
            await writeFile(failurePath, failureBytes, { flag: "wx" });
            store.repair(); // Only this exact row, only this independent test copy.
            const retry = assertCliSuccess(await restorationCli(fixture, args, { label: "native-late-finalize-explicit-retry" }), "upgraded");
            assert.ok(retry.receipt.operations.every(({ outcome }) => outcome === "already-satisfied"));
            assert.deepEqual(await readFile(selection.path), selectedBytes);
            assert.deepEqual(await readFile(`${proofPath}.receipt`), receiptBytes);
            assert.equal(await readFile(failurePath, "utf8"), failureBytes);
            const proof = JSON.parse(await readFile(proofPath));
            assert.equal(proof.preparationDigest, selection.digest);
            assert.equal(proof.activation, "verified-current-v2");
            const adapterRoot = join(fixture.consumerRoot, "node_modules/@agent-teams/docs-protocol-agent-teams");
            assert.equal(JSON.parse(await readFile(join(adapterRoot, "package.json"))).version, fixture.target.packages.docsProtocolAgentTeams.version);
            assert.equal(JSON.parse(await fixtureProcess(process.execPath,
              [join(adapterRoot, "dist/cli.js"), "check", "--consumer", fixture.consumerRoot, "--json"], fixture.consumerRoot)).outcome, "current");
            const restored = await fixture.restore({ proofPath, expect: retry.restoration.digest });
            assert.equal(restored.outcome, "restored");
            assert.equal((await fixture.oldCheck()).fixtureCli, "historical-v1");
            assert.deepEqual(await snapshot(fixture.consumerRoot), original);
          }
        });
        assert.equal((await inspectKnownFileTransactionBarrier({ consumerRoot: fixture.consumerRoot })).state, "idle");
        assert.deepEqual(await readFile(fixture.proofPath), seedProof);
        assert.deepEqual(await readFile(`${fixture.proofPath}.prepared`), seedPreparation);
        await store.assertSourceUnchanged();
        t.diagnostic(`Supporting source fixture only: real Corepack pnpm ${fixture.pnpmVersion}; ${phase}; no published R2 qualification.`);
      } finally {
        if (previousTmpdir === undefined) {delete process.env.TMPDIR;} else {process.env.TMPDIR = previousTmpdir;}
        await fixture.close();
      }
    });
  }

  test("retains and restores the same managed TEST consumer with real Corepack and CAS", { skip: process.platform === "win32" }, async (t) => {
    const fixture = await managedRestorationFixture(helpers);
    const { consumerRoot, proofPath } = fixture;
    try {
      const original = await snapshot(consumerRoot);
      const upgraded = await fixture.upgrade(fixture.upgradeOptions);
      assert.equal(upgraded.outcome, "upgraded", JSON.stringify(upgraded));
      assert.equal(upgraded.restoration.path, proofPath);
      const expect = upgraded.restoration.digest;
      const proofBytes = await readFile(proofPath);
      const proof = JSON.parse(proofBytes);
      const preparation = await readFile(`${proofPath}.prepared`);
      assert.equal(JSON.parse(preparation).controller.buildIdentity, proof.controller.buildIdentity);
      await assert.rejects(fixture.restore({ proofPath: `${proofPath}.prepared`, expect: sha256Bytes(preparation) }));
      assert.equal(proof.activation, "verified-current-v2");
      assert.equal(proof.sourceRevision, fixture.sourceRevision);
      assert.equal(proof.plan.planDigest, upgraded.receipt.planDigest);
      assert.equal(proof.controller.name, "@agent-teams/docs-protocol-agent-teams");
      assert.equal(proof.kernel.name, "@agent-teams/repository-mutation");
      assert.equal((await lstat(proofPath)).mode & 0o777, 0o600);
      const migrated = await snapshot(consumerRoot);
      assert.notDeepEqual(migrated, original);
      assert.equal(JSON.parse(Buffer.from(migrated["architecture/foundation/docs-consumer-integration.json"].bytes, "base64")).schemaVersion, 3);
      assert.equal(JSON.parse(await fixtureProcess(process.execPath,
        [join(consumerRoot, "node_modules/@agent-teams/docs-protocol-agent-teams/dist/cli.js"), "check", "--consumer", consumerRoot, "--json"], consumerRoot)).outcome, "current");
      assert.equal((await inspectKnownFileTransactionBarrier({ consumerRoot })).state, "idle");
      // Retired snapshots are optional caches. Never rewrite a canonical journal.
      const internal = join(consumerRoot, ".agent-teams-local");
      for (const entry of await readdir(internal)) {
        if (entry.endsWith(".completed-known-file-evidence")) {await rm(join(internal, entry), { recursive: true });}
      }
      const assertUnchanged = async () => assert.deepEqual(await snapshot(consumerRoot), migrated);
      async function editedProof(change, recompute = false, pattern) {
        const edited = structuredClone(proof); change(edited);
        const path = join(fixture.disposable, "hostile-proof.json");
        if (recompute) {
          const receipt = edited.receipt;
          resealRestorationProof(edited, path);
          edited.receipt = receipt;
        }
        const bytes = Buffer.from(`${restorationJson(edited)}\n`);
        await writeFile(path, bytes);
        await assert.rejects(fixture.restore({ expect: recompute ? sha256Bytes(bytes) : expect, proofPath: path }), pattern);
        await assertUnchanged();
      }
      await t.test("tampered, unknown, missing, mixed and wrong-build proof fail closed", async () => {
        await editedProof((p) => {p.sourceTree = "a".repeat(40);});
        await editedProof((p) => {p.extra = true;}, true);
        await editedProof((p) => {delete p.activation;}, true);
        await editedProof((p) => {p.receipt.operations[0].outcome = "already-satisfied";}, true);
        await editedProof((p) => {p.receipt.operations.push(p.receipt.operations[0]);}, true);
        await editedProof((p) => {p.controller.buildIdentity = `sha256:${"a".repeat(64)}`;}, true);
        await editedProof((p) => {p.kernel.buildIdentity = `sha256:${"b".repeat(64)}`;}, true);
        await editedProof((p) => {p.kernel.version = "999.0.0";}, true);
        await editedProof((p) => {p.plan.operations[0].path = "README.md";}, true);
        const duplicate = Buffer.from(proofBytes.toString().replace('"schemaVersion":1,', '"schemaVersion":1,"schemaVersion":1,'));
        const path = join(fixture.disposable, "duplicate.json"); await writeFile(path, duplicate);
        await assert.rejects(fixture.restore({ expect: sha256Bytes(duplicate), proofPath: path }));
        await assertUnchanged();
      });
      await t.test("a coherent forged Plan and receipt cannot use source Git to rewrite unrelated files", async () => {
        await editedProof((p) => {
          const operations = p.plan.operations.map((operation) => ({
            path: operation.path,
            precondition: { state: "known-file", acceptedPreimages: operation.precondition.acceptedPreimages.map((image) => ({ bytes: Buffer.from(image.contentBase64, "base64"), mode: image.mode })) },
            postimage: { bytes: Buffer.from(operation.postimage.contentBase64, "base64"), mode: operation.postimage.mode }
          }));
          operations.pop();
          operations.push({ path: "README.md", precondition: { state: "known-file", acceptedPreimages: [{ bytes: Buffer.from(original["README.md"].bytes, "base64"), mode: original["README.md"].mode }] }, postimage: { bytes: Buffer.from("forged postimage\n"), mode: original["README.md"].mode } });
          p.plan = compileKnownFileTransactionPlan({ operations });
          const body = { schemaVersion: 1, protocol: p.plan.protocol, planDigest: p.plan.planDigest, outcome: "applied", operations: p.plan.operations.map(({ path, postimage }) => ({ path, outcome: "replaced", resultDigest: postimage.digest })) };
          p.receipt = { ...body, receiptDigest: sha256Json({ domain: "agent-teams.repository-mutation.known-file-receipt/v1", body }) };
        }, true, /closed managed replacement set/u);
      });
      await t.test("transplanted proof and root aliases fail without changing either consumer", async () => {
        const transplanted = join(fixture.disposable, "foreign");
        await cp(consumerRoot, transplanted, { recursive: true });
        await assert.rejects(fixture.restore({ consumerRoot: transplanted, expect }), /another consumer/u);
        assert.deepEqual(await snapshot(transplanted), migrated);
        const alias = join(fixture.disposable, "alias"); await symlink(consumerRoot, alias);
        await assert.rejects(fixture.restore({ consumerRoot: alias, expect }));
        await assertUnchanged();
      });
      await t.test("a differently-cased root alias fails without changing either consumer", async (subtest) => {
        // Case aliasing is filesystem-dependent (default macOS/Windows, not Linux ext4); probe
        // the real filesystem instead of assuming behavior from process.platform.
        const parent = dirname(consumerRoot);
        const base = consumerRoot.slice(parent.length + 1);
        const flipped = [...base].map((ch) =>
          ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()).join("");
        if (flipped === base) {
          subtest.skip("consumer root name has no case-bearing characters to alias.");
          return;
        }
        const real = await lstat(consumerRoot, { bigint: true });
        const aliasStat = await lstat(join(parent, flipped), { bigint: true }).catch(() => null);
        if (aliasStat === null || aliasStat.dev !== real.dev || aliasStat.ino !== real.ino) {
          subtest.skip("filesystem does not alias a different-case path to the same consumer root.");
          return;
        }
        await assert.rejects(fixture.restore({ consumerRoot: join(parent, flipped), expect }));
        await assertUnchanged();
      });
      await t.test("foreign file bytes, modes, untracked files and symlinks survive refusals", async () => {
        const readme = join(consumerRoot, "README.md"); const before = await readFile(readme);
        await writeFile(readme, "foreign edit\n");
        await assert.rejects(fixture.restore({ expect }), /unrelated edits/u);
        assert.equal(await readFile(readme, "utf8"), "foreign edit\n"); await writeFile(readme, before);
        const manifest = join(consumerRoot, "package.json"); await chmod(manifest, 0o600);
        await assert.rejects(fixture.restore({ expect }), /mode/u);
        assert.equal((await lstat(manifest)).mode & 0o777, 0o600); await chmod(manifest, original["package.json"].mode);
        const foreign = join(consumerRoot, "unrelated-new.txt"); await writeFile(foreign, "keep\n");
        await assert.rejects(fixture.restore({ expect }), /unrelated edits/u); await rm(foreign);
        const skill = join(consumerRoot, fixture.current.skillPath); const bytes = await readFile(skill);
        await rm(skill); await symlink(readme, skill);
        await assert.rejects(fixture.restore({ expect })); assert.equal(await readlink(skill), readme);
        await rm(skill);
        const restoredSkill = await open(skill, "wx", original[fixture.current.skillPath].mode);
        try {
          await restoredSkill.writeFile(bytes);
          await restoredSkill.chmod(original[fixture.current.skillPath].mode);
        } finally {
          await restoredSkill.close();
        }
        await assertUnchanged();
      });
      await t.test("active transaction, wrong generations and ineligible rollback fail before inverse", async () => {
        const lease = await acquireMutationLease(consumerRoot);
        try {await assert.rejects(fixture.restore({ expect }), /active transaction/u);} finally {await releaseMutationLease(lease);}
        await assert.rejects(fixture.restore({ expect, sourceGeneration: 1 }), /explicit source generation/u);
        await assert.rejects(fixture.restore({ expect, from: "foreign-v2" }), /exact recorded/u);
        const stale = { readRestoration: async () => {
          const observed = await fixture.authority.readRestoration();
          return { ...observed, source: { ...observed.source, cohort: { ...observed.source.cohort, rollbackTo: [] } } };
        } };
        await assert.rejects(fixture.restore({ expect }, { authority: stale }), /fresh protected authority/u);
        await assert.rejects(fixture.restore({ expect }, { authority: { readRestoration: async () => {throw new Error("target support expired");} } }), /support expired/u);
        await assertUnchanged();
      });
      await t.test("APPLYING process death recovers exact V2; COMMITTED remains cleanup", async () => {
        await killInverse(fixture, expect, "after-operation-published");
        assert.notEqual((await inspectKnownFileTransactionBarrier({ consumerRoot })).state, "idle");
        await assert.rejects(fixture.restore({ expect }), /active transaction/u);
        const recovered = await recoverKnownFileTransaction({ consumerRoot });
        assert.equal(recovered.outcome, "rolled-back");
        await assertUnchanged();
        assert.deepEqual(await readFile(proofPath), proofBytes);
      });
      await t.test("an external SIGTERM to a live child mid-transaction fails closed without changing the consumer", async () => {
        await terminateInverse(fixture, expect, "after-operation-published");
        assert.notEqual((await inspectKnownFileTransactionBarrier({ consumerRoot })).state, "idle");
        await assert.rejects(fixture.restore({ expect }), /active transaction/u);
        const recovered = await recoverKnownFileTransaction({ consumerRoot });
        assert.equal(recovered.outcome, "rolled-back");
        await assertUnchanged();
        assert.deepEqual(await readFile(proofPath), proofBytes);
      });
      await t.test("positive restoration returns exact original bytes, modes and old installed CLI", async () => {
        const result = await fixture.restore({ expect });
        assert.equal(result.outcome, "restored");
        if (process.env.MANAGED_RESTORATION_EVIDENCE_DIR) {
          const directory = process.env.MANAGED_RESTORATION_EVIDENCE_DIR;
          await mkdir(directory, { recursive: true });
          for (const [name, value] of Object.entries({
            "original-v1.json": original, "activated-v2.json": migrated,
            "restored-v1.json": await snapshot(consumerRoot), "upgrade.json": upgraded,
            "restore.json": result, "proof.json": proof, "preparation.json": JSON.parse(preparation),
            "old-cli.json": await fixture.oldCheck()
          })) {await writeFile(join(directory, name), `${JSON.stringify(value, null, 2)}\n`);}
          await writeFile(join(directory, "proof.canonical.json"), proofBytes);
        }
        assert.deepEqual(await snapshot(consumerRoot), original);
        assert.equal((await fixture.oldCheck()).fixtureCli, "historical-v1");
        await assert.rejects(fixture.restore({ expect }), /current bytes or mode/u);
      });
      // A second completed migration exercises activation failure and durable inverse interruption.
      const secondPath = join(fixture.disposable, "restoration-second.json");
      const second = await fixture.upgrade({ ...fixture.upgradeOptions, restorationProofPath: secondPath });
      assert.equal(second.outcome, "upgraded", JSON.stringify(second));
      fixture.restoreOptions.proofPath = secondPath;
      const nextExpect = second.restoration.digest;
      await t.test("failed historical activation reports failure and explicit activation-only resumes", async () => {
        const previous = process.env.MANAGED_RESTORATION_TEST_FAIL;
        process.env.MANAGED_RESTORATION_TEST_FAIL = "1";
        try {
          await assert.rejects(fixture.restore({ expect: nextExpect }), /nonzero exit/u);
          assert.deepEqual(await snapshot(consumerRoot), original);
          await assert.rejects(fixture.oldCheck());
        } finally {
          if (previous === undefined) {delete process.env.MANAGED_RESTORATION_TEST_FAIL;}
          else {process.env.MANAGED_RESTORATION_TEST_FAIL = previous;}
        }
        const recovered = await fixture.restore({ expect: nextExpect, activationOnly: true });
        assert.equal(recovered.outcome, "activated-v1");
        assert.deepEqual(await snapshot(consumerRoot), original);
        assert.equal((await fixture.oldCheck()).fixtureCli, "historical-v1");
      });
      const thirdPath = join(fixture.disposable, "restoration-third.json");
      const third = await fixture.upgrade({ ...fixture.upgradeOptions, restorationProofPath: thirdPath });
      fixture.restoreOptions.proofPath = thirdPath;
      await t.test("COMMITTED process death preserves V1 bytes and requires explicit historical activation", async () => {
        await killInverse(fixture, third.restoration.digest, "after-journal-committed");
        const recovered = await recoverKnownFileTransaction({ consumerRoot });
        assert.equal(recovered.outcome, "applied");
        assert.deepEqual(await snapshot(consumerRoot), original);
        await assert.rejects(fixture.oldCheck());
        assert.equal((await fixture.restore({ expect: third.restoration.digest, activationOnly: true })).outcome, "activated-v1");
        assert.equal((await fixture.oldCheck()).fixtureCli, "historical-v1");
      });
      t.diagnostic(`Real Corepack pnpm ${fixture.pnpmVersion}; local fixture tarballs/authority only; source ${fixture.sourceRevision}; proof ${expect}.`);
    } finally {await fixture.close();}
  });
  test("restoration origin selection admits supported SUPERSEDED only for a recorded binding", async () => {
    const { cohort } = await helpers.sourceCohort();
    const registry = helpers.rawRegistry(cohort, "SUPERSEDED");
    registry.events[1].support_until = "2099-01-01T00:00:00Z";
    const input = { cohortId: cohort.cohortId, generation: 1, registry, repository: helpers.desired(cohort).repository, revision: "8".repeat(40) };
    assert.throws(() => projectQualifiedCohortAuthority(input), /not selectable/u);
    assert.deepEqual(projectQualifiedCohortAuthority({ ...input, restorationBinding: "origin" }).cohort, cohort);
    for (const until of ["2020-01-01T00:00:00Z", "bad", undefined]) {
      registry.events[1].support_until = until;
      assert.throws(() => projectQualifiedCohortAuthority({ ...input, restorationBinding: "origin" }), /support has expired/u);
    }
    for (const state of ["SUSPENDED", "SUPPORT_ENDED", "PUBLISHED_UNQUALIFIED"]) {
      registry.events[1].state = state;
      assert.throws(() => projectQualifiedCohortAuthority({ ...input, restorationBinding: "origin" }));
    }
    registry.events[1].state = "CANARY";
    registry.cohorts[0].canary_repositories = [{ repository_id: 123 }];
    assert.throws(() => projectQualifiedCohortAuthority({ ...input, restorationBinding: "origin" }), /not selectable/u);
  });
}

export function registerRestorationAuthorityTest({ sourceCohort, v2Cohort, centralRegistry, v2Registry, authorityDigest, REPOSITORY }) {

test("restoration rereads protected main and keeps source and original target at one revision", async () => {
  const { cohort: origin } = await sourceCohort();
  const successor = v2Cohort(origin);
  successor.upgradeFrom = [origin.cohortId];
  successor.rollbackTo = [origin.cohortId];
  const old = centralRegistry(origin);
  const next = v2Registry(successor);
  const registry = { schema_version: 1, cohorts: [...old.cohorts, ...next.cohorts], events: [...old.events, ...next.events] };
  function bindEvents() {
    let previous = null;
    registry.events.forEach((event, index) => {
      event.sequence = index + 1;
      event.previous_event_digest = previous;
      event.event_digest = authorityDigest(event, "event_digest", "agent-teams.docs-qualified-cohort-event/v1");
      previous = event.event_digest;
    });
  }
  bindEvents();
  let revision = "8".repeat(40);
  const urls = [];
  const reader = new GitHubCohortAuthorityReader(async (url) => {
    urls.push(url);
    return new Response(JSON.stringify(String(url).endsWith("/commits/main") ? { sha: revision } : registry));
  });
  const options = { source: successor, origin, repository: REPOSITORY };
  const first = await reader.readRestoration(options);
  assert.equal(first.source.revision, revision);
  assert.equal(first.target.revision, revision);
  assert.equal(first.target.cohort.cohortId, origin.cohortId);
  revision = "9".repeat(40);
  const second = await reader.readRestoration(options);
  assert.equal(second.source.revision, revision);
  assert.equal(second.target.revision, revision);
  assert.ok(urls[2].endsWith("/commits/main"));
  assert.ok(urls[3].includes(`/${revision}/governance/docs-qualified-cohorts.json`));
  registry.events[1].state = "SUPERSEDED";
  registry.events[1].support_until = "2020-01-01T00:00:00Z";
  bindEvents();
  await assert.rejects(reader.readRestoration(options), /support has expired/u);
  registry.events[1].support_until = "2099-01-01T00:00:00Z";
  bindEvents();
  assert.equal((await reader.readRestoration(options)).target.cohort.cohortId, origin.cohortId);
});

}
