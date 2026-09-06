import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "./pack-test-support.mjs";

/** Runs against the caller's existing installed package fixture; never installs.
 * The existing library authority fixture uses the same built-in recipe as the
 * consumer crash contract, while keeping all catalog and owner data generic.
 */
export async function verifyPackedScaffoldingQualification({ fixture, repositoryRoot }) {
  const programPath = join(fixture.consumerRoot, "scaffold-qualification.test.mjs");
  await writeFile(programPath, `
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import * as rootApi from "@agent-teams/engineering-foundation";
import * as production from "@agent-teams/engineering-foundation/scaffolding";
import * as qualification from "@agent-teams/engineering-foundation/scaffolding/qualification";
const { applyFilesystemScaffold, planScaffoldFromFile, recoverFilesystemScaffold } = production;
const exec = promisify(execFile);
const phases = [
  "after-journal-temporary-synced", "after-journal-prepared",
  "before-operation-authority-recheck", "after-journal-operation-publishing",
  "after-temporary-synced", "after-hard-link", "after-journal-operation-published",
  "before-final-authority-recheck", "after-final-verification",
  "before-journal-quarantine", "after-journal-unlinked"
];
async function exists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
test("installed qualification has a curated public boundary", async () => {
  assert.deepEqual(Object.keys(qualification), ["runScaffoldCrashQualification"]);
  assert.equal("runScaffoldCrashQualification" in rootApi, false);
  assert.equal(rootApi.scaffolding?.runScaffoldCrashQualification, undefined);
  assert.equal("runScaffoldCrashQualification" in production, false);
  for (const path of ["dist/composition/scaffold-filesystem.js", "scaffolding/testing/api", "dist/scaffolding/adapters/node/filesystem-authority-workspace.js"]) {
    await assert.rejects(import("@agent-teams/engineering-foundation/" + path), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  }
});
test("production ignores an extra JavaScript callback on a valid apply", async () => {
  const root = await mkdtemp(join(process.cwd(), "production-"));
  try {
    await cp(${JSON.stringify(join(repositoryRoot, "tests/fixtures/scaffolding-library-consumer"))}, root, { recursive: true });
    const plan = await planScaffoldFromFile({ consumerRoot: root, intentPath: "intents/create-beta.yaml" });
    let called = false;
    const receipt = await applyFilesystemScaffold(root, plan, () => { called = true; });
    assert.equal(receipt.outcome, "applied");
    assert.equal(called, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("eleven installed scaffold crash cuts preserve recovery and user evidence", async t => {
  for (const phase of phases) await t.test(phase, async cut => {
    const root = await mkdtemp(join(process.cwd(), "qualification-"));
    try {
      await cp(${JSON.stringify(join(repositoryRoot, "tests/fixtures/scaffolding-library-consumer"))}, root, { recursive: true });
      const plan = await planScaffoldFromFile({ consumerRoot: root, intentPath: "intents/create-beta.yaml" });
      const writer = ${JSON.stringify(`
import { planScaffoldFromFile } from "@agent-teams/engineering-foundation/scaffolding";
import { runScaffoldCrashQualification } from "@agent-teams/engineering-foundation/scaffolding/qualification";
const root = process.argv[1];
const phase = process.argv[2];
const plan = await planScaffoldFromFile({ consumerRoot: root, intentPath: "intents/create-beta.yaml" });
await runScaffoldCrashQualification(root, plan, async point => {
  if (point.phase === phase) process.exit(73);
});
`)};
      await assert.rejects(exec(process.execPath, ["--input-type=module", "--eval", writer, root, phase], { timeout: 60000 }), error => error.code === 73 && error.signal === null);
      cut.diagnostic("writer exit=73 signal=null");
      const recoverer = 'import { recoverFilesystemScaffold } from "@agent-teams/engineering-foundation/scaffolding"; console.log(JSON.stringify((await recoverFilesystemScaffold(process.argv[1])) ?? null));';
      let stdout;
      try {
        ({ stdout } = await exec(process.execPath, ["--input-type=module", "--eval", recoverer, root], { timeout: 60000 }));
      } catch (error) {
        assert.equal(phase, "after-journal-temporary-synced", error.stderr);
        assert.match(error.stderr ?? "", /orphan Foundation transaction temporary/u);
        assert.equal(await exists(join(root, "packages/deep/nested/beta")), false);
        return;
      }
      const recovered = JSON.parse(stdout);
      cut.diagnostic("recovery=" + (recovered?.outcome ?? "null"));
      if (recovered !== null) {
        if (recovered.outcome === "recovery-required") {
          assert.ok(["after-temporary-synced", "after-hard-link"].includes(phase));
          assert.equal((await recoverFilesystemScaffold(root))?.outcome, "recovery-required");
          for (const op of plan.operations) if (await exists(join(root, op.path))) {
            assert.deepEqual(await readFile(join(root, op.path)), Buffer.from(op.after.contentBase64, "base64"));
          }
          return;
        }
        assert.ok(["applied", "failed-recovered"].includes(recovered.outcome));
      }
      for (const op of plan.operations) assert.deepEqual(await readFile(join(root, op.path)), Buffer.from(op.after.contentBase64, "base64"));
      assert.equal((await applyFilesystemScaffold(root, plan)).outcome, "already-applied");
      const driftPath = join(root, plan.operations[0].path);
      await writeFile(driftPath, "user-owned drift\\n");
      let called = false;
      assert.equal((await applyFilesystemScaffold(root, plan, () => { called = true; })).outcome, "rejected");
      assert.equal(called, false);
      assert.equal(await readFile(driftPath, "utf8"), "user-owned drift\\n");
      assert.equal(await recoverFilesystemScaffold(root), undefined);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
`);
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = await runCommand(process.execPath, ["--test", "--test-reporter=tap", programPath], fixture.consumerRoot, { environment, timeoutMs: 900_000 });
  assert.match(result.stdout, /# tests 14\b/u);
  assert.match(result.stdout, /# pass 14\b/u);
  assert.match(result.stdout, /# fail 0\b/u);
  assert.match(result.stdout, /# skipped 0\b/u);
  const typesPath = join(fixture.consumerRoot, "scaffold-qualification-types.mts");
  await writeFile(typesPath, `
import { runScaffoldCrashQualification, type ScaffoldQualificationPhase, type ScaffoldQualificationPoint, type ScaffoldQualificationPhaseCallback } from "@agent-teams/engineering-foundation/scaffolding/qualification";
import { applyFilesystemScaffold, type ScaffoldPlan, type ScaffoldReceipt } from "@agent-teams/engineering-foundation/scaffolding";
declare const plan: ScaffoldPlan;
const phase: ScaffoldQualificationPhase = "after-hard-link";
const point: ScaffoldQualificationPoint = { phase };
const callback: ScaffoldQualificationPhaseCallback = async p => { const value: ScaffoldQualificationPhase = p.phase; void value; };
const receipt: Promise<ScaffoldReceipt> = runScaffoldCrashQualification("fixture", plan, callback);
void receipt;
// @ts-expect-error private phase is unsupported
const unsupported: ScaffoldQualificationPhase = "after-temporary-written";
// @ts-expect-error recovery phase is unsupported
const recovery: ScaffoldQualificationPhase = "after-recovery-scope-checked";
// @ts-expect-error unknown future phases are unsupported
const future: ScaffoldQualificationPhase = "future-phase";
// @ts-expect-error callback is required
runScaffoldCrashQualification("fixture", plan);
// @ts-expect-error dependencies are not consumer capabilities
runScaffoldCrashQualification("fixture", plan, callback, {});
// @ts-expect-error production signature remains two arguments
applyFilesystemScaffold("fixture", plan, callback);
// @ts-expect-error internal metadata is not public
point.operationPath;
// @ts-expect-error projected point is readonly
point.phase = "after-journal-prepared";
`);
  await runCommand(process.execPath, [join(repositoryRoot, "node_modules/typescript/bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2024", "--types", "node", "--typeRoots", join(repositoryRoot, "node_modules/@types"), typesPath], fixture.consumerRoot);
  return result;
}
