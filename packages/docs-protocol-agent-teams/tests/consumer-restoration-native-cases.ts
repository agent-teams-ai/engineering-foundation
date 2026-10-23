import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256Bytes, inspectKnownFileTransactionBarrier } from "@agent-teams/repository-mutation";
import { packageRoot } from "./consumer-upgrade-e2e-fixtures.mjs";
import { managedRestorationFixture, fixtureProcess } from "./consumer-restoration-fixture.mjs";
import {
  retrievalTree,
  retrievalStoreCopy,
  withRetrievalEnvironment,
} from "./consumer-restoration-retrieval-fixture.mjs";
import {
  restorationArgs,
  restorationCli,
  assertCliSuccess,
} from "./consumer-restoration-cli-fixture.mjs";
type RestorationFixture = Awaited<ReturnType<typeof managedRestorationFixture>>;
type RestorationHelpers = Pick<
  Parameters<typeof managedRestorationFixture>[0],
  "cohortV2" | "desired"
> &
  Partial<
    Pick<
      Parameters<typeof managedRestorationFixture>[0],
      "sourceEligibleAfter" | "targetEligibleAfter"
    >
  >;
export async function snapshot(
  root: string,
  prefix = "",
): Promise<Record<string, { bytes: string; mode: number }>> {
  const result: Record<string, { bytes: string; mode: number }> = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if ([".git", ".agent-teams-local", "node_modules"].includes(entry.name)) {
      continue;
    }
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      Object.assign(result, await snapshot(root, path));
      continue;
    }
    result[path] = {
      bytes: (await readFile(join(root, path))).toString("base64"),
      mode: (await lstat(join(root, path))).mode & 0o777,
    };
  }
  return result;
}

const uri = (path: string) => pathToFileURL(join(packageRoot, path)).href;

export function killInverse(fixture: RestorationFixture, expect: string, phase: string) {
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
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      try {
        assert.equal(signal, "SIGKILL", `code=${code}: ${stderr}`);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

// Real live ChildProcess: the fault injector pauses in place and signals readiness instead of
// self-terminating, so the external SIGTERM below lands deterministically mid-transaction.
export function terminateInverse(fixture: RestorationFixture, expect: string, phase: string) {
  const sentinel = "FAULT_POINT_REACHED";
  const script = `
import {restoreNodeConsumerIntegration} from ${JSON.stringify(uri("dist/consumer-integration/adapters/node-consumer-restoration.js"))};
import {NodeConsumerUpgradeSandbox} from ${JSON.stringify(uri("dist/consumer-integration/adapters/node-consumer-upgrade-sandbox.js"))};
import {applyKnownFileTransaction as applyKnownFileTransactionWithFaults} from ${JSON.stringify(uri("../repository-mutation/dist/qualification/index.js"))};
const projection=cohort=>({repository:'agent-teams-ai/.github',path:'governance/docs-qualified-cohorts.json',revision:'8'.repeat(40),cohort});
await restoreNodeConsumerIntegration(${JSON.stringify({ ...fixture.restoreOptions, expect })}, {
 authority:{readRestoration:async()=>({source:projection(${JSON.stringify(fixture.target)}),target:projection(${JSON.stringify(fixture.origin)})})},
 sandbox:new NodeConsumerUpgradeSandbox(),
 apply:options=>applyKnownFileTransactionWithFaults({...options,faultInjector:async point=>{if(point.phase===${JSON.stringify(phase)}){process.stderr.write(${JSON.stringify(`${sentinel}\n`)});await new Promise(r=>setTimeout(r,10000));}}})
});`;
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
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
      } catch (error) {
        reject(error);
      }
    });
  });
}

const absent = async (path: string) => assert.rejects(readFile(path), { code: "ENOENT" });

function assertNativeMissing(
  result: Awaited<ReturnType<typeof restorationCli>>,
  fixture: RestorationFixture,
) {
  assert.notEqual(result.code, 0, JSON.stringify(result));
  assert.equal(result.signal, null);
  assert.notEqual(result.execution?.outcome, "upgraded");
  assert.notEqual(result.execution?.outcome, "prepared");
  const message = result.execution.issues[0].message;
  assert.match(message, /ERR_PNPM_NO_OFFLINE_TARBALL/u);
  assert.ok(
    message.includes(
      `/@agent-teams/docs-protocol-agent-teams/-/docs-protocol-agent-teams-${fixture.target.packages.docsProtocolAgentTeams.version}.tgz`,
    ),
    message,
  );
  assert.equal(message.includes(fixture.disposable), false, message);
  assert.doesNotMatch(result.stderr, /real target activation passed/u);
}

async function prepareRetrievalScenario(
  fixture: RestorationFixture,
  phase: string,
  t: import("node:test").TestContext,
) {
  const original = await snapshot(fixture.consumerRoot);
  const seeded = await fixture.upgrade(fixture.upgradeOptions);
  assert.equal(seeded.outcome, "upgraded", JSON.stringify(seeded));
  assert.ok(seeded.restoration);
  assert.equal((await fixture.restore({ expect: seeded.restoration.digest })).outcome, "restored");
  assert.equal((await fixture.oldCheck()).fixtureCli, "historical-v1");
  assert.deepEqual(await snapshot(fixture.consumerRoot), original);
  const store = await retrievalStoreCopy(fixture, `store-${phase}`, (message: string = "") =>
    t.diagnostic(message),
  );
  const proofPath = join(fixture.disposable, `${phase}.json`);
  const seedProof = await readFile(fixture.proofPath);
  const seedPreparation = await readFile(`${fixture.proofPath}.prepared`);
  return { original, store, proofPath, seedProof, seedPreparation };
}

async function assertIdleBarrier(fixture: RestorationFixture): Promise<void> {
  assert.equal(
    (await inspectKnownFileTransactionBarrier({ consumerRoot: fixture.consumerRoot })).state,
    "idle",
  );
}

async function assertInstalledTargetAdapter(fixture: RestorationFixture): Promise<void> {
  const adapterRoot = join(
    fixture.consumerRoot,
    "node_modules/@agent-teams/docs-protocol-agent-teams",
  );
  assert.equal(
    JSON.parse((await readFile(join(adapterRoot, "package.json"))).toString("utf8")).version,
    fixture.target.packages.docsProtocolAgentTeams.version,
  );
  assert.equal(
    JSON.parse(
      await fixtureProcess(
        process.execPath,
        [join(adapterRoot, "dist/cli.js"), "check", "--consumer", fixture.consumerRoot, "--json"],
        fixture.consumerRoot,
      ),
    ).outcome,
    "current",
  );
}

export function registerNativeRetrievalTests(helpers: RestorationHelpers) {
  // Supporting native-source evidence only; published R2 still requires root's accepted full store.
  for (const phase of ["before-prepare", "late-finalize"]) {
    test(`native retrieval ${phase}: exact missing adapter row`, async (t) => {
      const fixture = await managedRestorationFixture({
        sourceEligibleAfter: undefined,
        targetEligibleAfter: undefined,
        ...helpers,
        isolatedStore: true,
      });
      const previousTmpdir = process.env.TMPDIR;
      try {
        // All native staging registrations belong to this disposable TEST fixture.
        process.env.TMPDIR = join(fixture.disposable, "retrieval-staging");
        await mkdir(process.env.TMPDIR);
        const { original, store, proofPath, seedProof, seedPreparation } =
          await prepareRetrievalScenario(fixture, phase, t);
        await withRetrievalEnvironment(store.destination, async () => {
          if (phase === "before-prepare") {
            await store.remove();
            assert.equal(
              (await fixtureProcess("git", ["status", "--porcelain"], fixture.consumerRoot)).trim(),
              "",
            );
            assert.equal(
              (await fixtureProcess("git", ["rev-parse", "HEAD"], fixture.consumerRoot)).trim(),
              fixture.sourceRevision,
            );
            const before = await retrievalTree(fixture.consumerRoot, [".agent-teams-local"]);
            const result = await restorationCli(
              fixture,
              [
                "upgrade",
                "--consumer",
                fixture.consumerRoot,
                "--source-generation",
                "1",
                "--target-generation",
                "2",
                "--to",
                fixture.target.cohortId,
                "--restoration-proof",
                proofPath,
                "--prepare",
                "--json",
              ],
              { label: "native-before-prepare" },
            );
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
            assert.deepEqual(
              await retrievalTree(fixture.consumerRoot, [".agent-teams-local"]),
              before,
            );
          } else {
            const prepared = await fixture.prepare({
              ...fixture.upgradeOptions,
              restorationProofPath: proofPath,
            });
            assert.equal(prepared.outcome, "prepared", JSON.stringify(prepared));
            const selection = prepared.preparation;
            assert.ok(selection);
            const selectedBytes = await readFile(selection.path);
            await store.remove();
            const args = restorationArgs(fixture, "finalize", selection, proofPath);
            const failure = await restorationCli(fixture, args, {
              label: "native-late-finalize-failure",
            });
            assertNativeMissing(failure, fixture);
            await absent(proofPath);
            assert.equal(failure.execution.restoration, undefined);
            const receiptBytes = await readFile(`${proofPath}.receipt`);
            const retained = JSON.parse(receiptBytes.toString("utf8"));
            assert.equal(retained.preparationDigest, selection.digest);
            assert.equal(retained.receipt.outcome, "applied");
            assert.ok(
              retained.receipt.operations.every(
                ({ outcome }: { outcome: string }) => outcome === "replaced",
              ),
            );
            assert.equal(retained.activation, undefined);
            // Apply has completed; installed-tree atomicity is deliberately not claimed here.
            const intent = JSON.parse(selectedBytes.toString("utf8"));
            for (const operation of intent.plan.operations) {
              assert.equal(
                sha256Bytes(await readFile(join(fixture.consumerRoot, operation.path))),
                operation.postimage.digest,
              );
            }
            const failureBytes = `${JSON.stringify(failure, null, 2)}\n`;
            const failurePath = join(fixture.disposable, "native-late-finalize-failure.json");
            await writeFile(failurePath, failureBytes, { flag: "wx" });
            store.repair(); // Only this exact row, only this independent test copy.
            const retry = assertCliSuccess(
              await restorationCli(fixture, args, { label: "native-late-finalize-explicit-retry" }),
              "upgraded",
            );
            assert.ok(
              retry.receipt.operations.every(
                ({ outcome }: { outcome: string }) => outcome === "already-satisfied",
              ),
            );
            assert.deepEqual(await readFile(selection.path), selectedBytes);
            assert.deepEqual(await readFile(`${proofPath}.receipt`), receiptBytes);
            assert.equal(await readFile(failurePath, "utf8"), failureBytes);
            const proof = JSON.parse((await readFile(proofPath)).toString("utf8"));
            assert.equal(proof.preparationDigest, selection.digest);
            assert.equal(proof.activation, "verified-current-v2");
            await assertInstalledTargetAdapter(fixture);
            const restored = await fixture.restore({ proofPath, expect: retry.restoration.digest });
            assert.equal(restored.outcome, "restored");
            assert.equal((await fixture.oldCheck()).fixtureCli, "historical-v1");
            assert.deepEqual(await snapshot(fixture.consumerRoot), original);
          }
        });
        await assertIdleBarrier(fixture);
        assert.deepEqual(await readFile(fixture.proofPath), seedProof);
        assert.deepEqual(await readFile(`${fixture.proofPath}.prepared`), seedPreparation);
        await store.assertSourceUnchanged();
        t.diagnostic(
          `Supporting source fixture only: real Corepack pnpm ${fixture.pnpmVersion}; ${phase}; no published R2 qualification.`,
        );
      } finally {
        if (previousTmpdir === undefined) {
          delete process.env.TMPDIR;
        } else {
          process.env.TMPDIR = previousTmpdir;
        }
        await fixture.close();
      }
    });
  }
}

export async function caseAliasedConsumerRoot(
  consumerRoot: string,
): Promise<{ supported: true; path: string } | { supported: false; reason: string }> {
  const parent = dirname(consumerRoot);
  const base = consumerRoot.slice(parent.length + 1);
  const flipped = [...base]
    .map((ch) => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()))
    .join("");
  if (flipped === base) {
    return {
      supported: false,
      reason: "consumer root name has no case-bearing characters to alias.",
    };
  }
  const real = await lstat(consumerRoot, { bigint: true });
  const aliasStat = await lstat(join(parent, flipped), { bigint: true }).catch(() => null);
  if (aliasStat === null || aliasStat.dev !== real.dev || aliasStat.ino !== real.ino) {
    return {
      supported: false,
      reason: "filesystem does not alias a different-case path to the same consumer root.",
    };
  }
  return { supported: true, path: join(parent, flipped) };
}
