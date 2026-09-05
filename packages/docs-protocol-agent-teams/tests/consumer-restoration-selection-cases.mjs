import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { compileKnownFileTransactionPlan, sha256Bytes } from "@agent-teams/repository-mutation";
import { managedRestorationFixture } from "./consumer-restoration-fixture.mjs";
import { assertCliSuccess, resealRestorationProof, restorationArgs, restorationCli, restorationSnapshot } from "./consumer-restoration-cli-fixture.mjs";
import { restorationJson } from "../dist/consumer-integration/application/policies/consumer-restoration-proof.js";
import { restorationConsumer } from "../dist/consumer-integration/adapters/node-consumer-restoration-evidence.js";
import { assertConsumerRestorationExecutionSchema, assertConsumerUpgradeExecutionSchema } from "../dist/consumer-integration/adapters/consumer-integration-schema-validator.js";

function setIdentity(id, name) {
  for (const [key, value] of [["GITHUB_REPOSITORY_ID", id], ["GITHUB_REPOSITORY", name]]) {
    if (value === undefined) {delete process.env[key];} else {process.env[key] = value;}
  }
}

async function expectBlocked(fixture, args, label) {
  const result = await restorationCli(fixture, args, { label });
  assert.notEqual(result.code, 0, JSON.stringify(result));
  assert.equal(result.execution.outcome, "blocked");
  return result;
}

export function registerRestorationSelectionTests(helpers) {
  test("production strict schemas and actual CLI preserve success, activation-only and error envelopes", { skip: process.platform === "win32" }, async () => {
    await assertConsumerRestorationExecutionSchema({ schemaVersion: 1, command: "consumer.restore", outcome: "blocked", issues: [] });
    await assertConsumerUpgradeExecutionSchema({ schemaVersion: 1, command: "consumer.finalize", outcome: "blocked", issues: [] });
    await assert.rejects(assertConsumerRestorationExecutionSchema({ schemaVersion: 1, command: "consumer.restore", outcome: "restored", issues: [] }), /proofDigest/u);
    await assert.rejects(assertConsumerUpgradeExecutionSchema({ schemaVersion: 1, command: "consumer.upgrade", outcome: "prepared", issues: [] }), /preparation/u);
    const fixture = await managedRestorationFixture(helpers);
    const saved = [process.env.GITHUB_REPOSITORY_ID, process.env.GITHUB_REPOSITORY];
    try {
      const original = await restorationSnapshot(fixture.consumerRoot);
      for (const [id, name] of [[undefined, undefined], [fixture.current.repository.id, undefined], [undefined, fixture.current.repository.nameWithOwner.toUpperCase()], [fixture.current.repository.id, fixture.current.repository.nameWithOwner.toUpperCase()]]) {
        setIdentity(id, name);
        assert.equal((await restorationConsumer(fixture.consumerRoot, fixture.current.repository)).repository.id, fixture.current.repository.id);
      }
      for (const [id, name] of [["999999", undefined], [undefined, "foreign/repository"], [fixture.current.repository.id, ""], ["", fixture.current.repository.nameWithOwner]]) {
        setIdentity(id, name);
        await assert.rejects(restorationConsumer(fixture.consumerRoot, fixture.current.repository), /does not match/u);
      }
      setIdentity(undefined, undefined);
      const prepared = await fixture.prepare(fixture.upgradeOptions);
      assert.equal(prepared.outcome, "prepared");
      const selection = prepared.preparation;
      const finalize = restorationArgs(fixture, "finalize", selection);
      for (const args of [
        ["restore", "--from", "v2", "--to", "v1", "--json"],
        ["restore", "--from", "v2", "--from", "v2", "--json"],
        [...finalize, "--activation-only"], [...finalize, "--expect", selection.digest],
        ["finalize", "--consumer", fixture.consumerRoot, "--json"]
      ]) {
        const malformed = await expectBlocked(fixture, args, "malformed-" + args.length);
        assert.equal(malformed.code, 2); assert.equal(malformed.execution.issues[0].code, "DOCS_CONSUMER_CLI_INVALID");
      }
      await expectBlocked(fixture, restorationArgs(fixture, "finalize", { ...selection, digest: `sha256:${"f".repeat(64)}` }), "unselected-prepare");
      const bytes = await readFile(selection.path);
      const tampered = JSON.parse(bytes); tampered.sourceTree = "f".repeat(40);
      const tamperedPath = `${selection.path}.tampered`; await writeFile(tamperedPath, `${restorationJson(tampered)}\n`);
      await expectBlocked(fixture, restorationArgs(fixture, "finalize", { ...selection, path: tamperedPath }), "tampered-prepare");
      // Changing both selection and preparation still cannot substitute authentic source Git/artifacts.
      const forgedSelection = { path: tamperedPath, digest: sha256Bytes(await readFile(tamperedPath)) };
      await expectBlocked(fixture, restorationArgs(fixture, "finalize", forgedSelection), "stale-git-prepare");
      const readme = join(fixture.consumerRoot, "README.md"); const oldReadme = await readFile(readme);
      await writeFile(readme, "new consumer content\n");
      await expectBlocked(fixture, finalize, "source-inventory-changed");
      assert.equal(await readFile(readme, "utf8"), "new consumer content\n"); await writeFile(readme, oldReadme);
      const changedAuthority = structuredClone(fixture.target); changedAuthority.recordDigest = `sha256:${"a".repeat(64)}`;
      assert.notEqual((await restorationCli(fixture, finalize, { target: changedAuthority, label: "fresh-target-changed" })).code, 0);
      assert.deepEqual(await restorationSnapshot(fixture.consumerRoot), original);
      const upgraded = assertCliSuccess(await restorationCli(fixture, finalize, { label: "identity-absent-finalize" }), "upgraded");
      assert.equal(upgraded.receipt.outcome, "applied");
      setIdentity(fixture.current.repository.id, fixture.current.repository.nameWithOwner.toUpperCase());
      const args = restorationArgs(fixture, "restore", upgraded.restoration);
      const targetReadme = await readFile(readme);
      await writeFile(readme, "foreign edit after activation\n");
      await expectBlocked(fixture, finalize, "target-inventory-changed");
      assert.equal(await readFile(readme, "utf8"), "foreign edit after activation\n");
      await writeFile(readme, targetReadme);
      assertCliSuccess(await restorationCli(fixture, args, { label: "identity-equivalent-restore" }), "restored");
      setIdentity(undefined, undefined);
      const activated = assertCliSuccess(await restorationCli(fixture, [...args, "--activation-only"], { label: "activation-only-cli" }), "activated-v1");
      assert.equal(activated.receipt, undefined);
      assert.deepEqual(await restorationSnapshot(fixture.consumerRoot), original);
      const stale = await expectBlocked(fixture, finalize, "existing-completion-source-restored");
      assert.match(stale.execution.issues[0].message, /current bytes|completed/u);
    } finally {setIdentity(...saved); await fixture.close();}
  });

  test("independent managed projections reject fully recomputed overreach inside allowed filenames", { skip: process.platform === "win32" }, async (t) => {
    const fixture = await managedRestorationFixture({ ...helpers, preserveForeign: true });
    try {
      const original = await restorationSnapshot(fixture.consumerRoot);
      const upgraded = await fixture.upgrade(fixture.upgradeOptions);
      assert.equal(upgraded.outcome, "upgraded");
      const proof = JSON.parse(await readFile(fixture.proofPath));
      assert.equal(proof.plan.operations.length, 7);
      assert.equal(proof.plan.operations.some(({ path }) => path === "AGENTS.md"), false);
      const migrated = await restorationSnapshot(fixture.consumerRoot);
      const targets = [
        ["AGENTS.md", (bytes) => Buffer.concat([bytes, Buffer.from("\nA new consumer-owned note.\n")])],
        ["package.json", (bytes) => Buffer.from(bytes.toString().replace('"packageManager": "pnpm@11.20.0"', '"packageManager": "pnpm@11.19.0"'))],
        ["package.json", (bytes) => Buffer.from(bytes.toString().replace('"private": true', '"private": false'))],
        ["pnpm-workspace.yaml", (bytes) => Buffer.concat([bytes, Buffer.from("preferOffline: true\n")])],
        ["pnpm-lock.yaml", (bytes) => Buffer.concat([bytes, Buffer.from("consumerUnrelatedPolicy: changed\n")])],
        ["pnpm-lock.yaml", (bytes) => Buffer.concat([bytes, Buffer.from("# consumer-owned lock comment\n")])],
        ["pnpm-lock.yaml", (bytes) => Buffer.from(bytes.toString().replace("consumer-test-tool:", "consumer-forged-tool:"))],
        [fixture.current.callerWorkflowPath, (bytes) => Buffer.concat([bytes, Buffer.from("# unowned workflow change\n")])],
        [fixture.current.managedStatePath, (bytes) => Buffer.concat([bytes, Buffer.from("\n")])],
        [fixture.current.skillPath, (bytes) => Buffer.concat([bytes, Buffer.from("\nUnrelated instructions.\n")])],
        ["architecture/foundation/docs-consumer-integration.json", (bytes) => Buffer.from(bytes.toString().replace('"owner": "', '"owner": "foreign/'))]
      ];
      for (const [path, change] of targets) {
        await t.test(`recomputed overreach: ${path}`, async () => {
          const before = Buffer.from(migrated[path].bytes, "base64"); const after = change(before);
          // The profile has no free owner field; change a preserved path instead.
          const candidateBytes = after.equals(before) ? Buffer.from(before.toString().replace('"profilePath": "', '"profilePath": "foreign/')) : after;
          assert.notDeepEqual(candidateBytes, before);
          await writeFile(join(fixture.consumerRoot, path), candidateBytes);
          const forged = structuredClone(proof);
          const operations = proof.plan.operations.filter((operation) => operation.path !== path).map((operation) => ({ path: operation.path,
            precondition: { state: "known-file", acceptedPreimages: operation.precondition.acceptedPreimages.map((image) => ({ bytes: Buffer.from(image.contentBase64, "base64"), mode: image.mode })) },
            postimage: { bytes: Buffer.from(operation.postimage.contentBase64, "base64"), mode: operation.postimage.mode } }));
          operations.push({ path, precondition: { state: "known-file", acceptedPreimages: [{ bytes: Buffer.from(original[path].bytes, "base64"), mode: original[path].mode }] },
            postimage: { bytes: candidateBytes, mode: original[path].mode } });
          forged.plan = compileKnownFileTransactionPlan({ operations });
          const forgedPath = join(fixture.disposable, "scope-forged.json"); const bytes = resealRestorationProof(forged, forgedPath);
          await writeFile(forgedPath, bytes);
          await assert.rejects(fixture.restore({ expect: upgraded.restoration.digest }), /current bytes|unrelated edits/u);
          await assert.rejects(fixture.restore({ proofPath: forgedPath, expect: upgraded.restoration.digest }), /selection digest/u);
          await assert.rejects(fixture.restore({ proofPath: forgedPath, expect: sha256Bytes(bytes) }), /managed field\/block ownership|exact deterministic managed effects|lock migration/u);
          assert.deepEqual(await readFile(join(fixture.consumerRoot, path)), candidateBytes);
          await writeFile(join(fixture.consumerRoot, path), before);
        });
      }
      assertCliSuccess(await restorationCli(fixture, restorationArgs(fixture, "restore", upgraded.restoration), { label: "scope-positive-control" }), "restored");
      assert.deepEqual(await restorationSnapshot(fixture.consumerRoot), original);
      assert.equal((await fixture.oldCheck()).fixtureCli, "historical-v1");
    } finally {await fixture.close();}
  });
}
