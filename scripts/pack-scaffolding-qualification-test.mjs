import { scaffoldingQualificationProgram } from "./packed-scaffolding-program.ts";
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
  await writeFile(programPath, scaffoldingQualificationProgram(repositoryRoot));
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = await runCommand(
    process.execPath,
    ["--test", "--test-reporter=tap", programPath],
    fixture.consumerRoot,
    { environment, timeoutMs: 900_000 },
  );
  assert.match(result.stdout, /# tests 14\b/u);
  assert.match(result.stdout, /# pass 14\b/u);
  assert.match(result.stdout, /# fail 0\b/u);
  assert.match(result.stdout, /# skipped 0\b/u);
  const typesPath = join(fixture.consumerRoot, "scaffold-qualification-types.mts");
  await writeFile(
    typesPath,
    `
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
`,
  );
  await runCommand(
    process.execPath,
    [
      join(repositoryRoot, "node_modules/typescript/bin/tsc"),
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2024",
      "--types",
      "node",
      "--typeRoots",
      join(repositoryRoot, "node_modules/@types"),
      typesPath,
    ],
    fixture.consumerRoot,
  );
  return result;
}
