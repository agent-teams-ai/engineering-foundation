/* oxlint-disable max-lines-per-function -- Sequential hostile cases share one disposable migration. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, cp, lstat, mkdir, open, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { sha256Bytes, sha256Json, compileKnownFileTransactionPlan, recoverKnownFileTransaction, inspectKnownFileTransactionBarrier } from "@agent-teams/repository-mutation";
import { acquireMutationLease, releaseMutationLease } from "@agent-teams/repository-mutation/node";
import { packageRoot } from "./consumer-upgrade-e2e-fixtures.mjs";
import { managedRestorationFixture, fixtureProcess } from "./consumer-restoration-fixture.mjs";
import { resealRestorationProof } from "./consumer-restoration-cli-fixture.mjs";
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
import {applyKnownFileTransaction as applyKnownFileTransactionWithFaults} from ${JSON.stringify(uri("../repository-mutation/dist/qualification/index.js"))};
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

export function registerConsumerRestorationTests(helpers) {
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
