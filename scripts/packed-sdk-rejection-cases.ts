import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand, runNpmCommand, writeJson } from "./pack-test-support.mjs";
import type { PackedSdkCheck } from "./packed-sdk-report-checks.ts";
type Decision = Record<string, unknown>;
export async function qualifySdkRejections({
  execute,
  decision,
  matched,
  candidate,
  compiler,
  cli,
  check,
  checkpoint,
}: {
  execute: (decisions: readonly Decision[]) => Promise<PackedSdkCheck>;
  decision: Decision;
  matched: PackedSdkCheck;
  candidate: string;
  compiler: string;
  parent: string;
  cli: string;
  check: (
    cli: string,
    root: string,
    expected: number,
    publicationRequired: boolean,
  ) => Promise<{ capabilities: readonly [{ problem: { code: string } }] }>;
  checkpoint: (root: string) => Promise<void>;
}): Promise<PackedSdkCheck> {
  assert.deepEqual((await execute([decision])).bytes, matched.bytes);
  const malformed = await execute([{ ...decision, ownerRef: "" }]);
  assert.ok(
    malformed.aggregate.capabilities[0].diagnostics.some((row) =>
      row.ruleId.endsWith("growth-decision-malformed"),
    ),
  );
  const overlap = await execute([decision, { ...decision, decisionId: "SDK-PACKED-2" }]);
  assert.ok(
    overlap.aggregate.capabilities[0].diagnostics.some((row) =>
      row.ruleId.endsWith("growth-decision-overlap"),
    ),
  );
  const reordered = await execute([{ ...decision, decisionId: "SDK-PACKED-2" }, decision]);
  assert.deepEqual(reordered.bytes, overlap.bytes);
  await writeFile(
    join(candidate, "pkg/src/index.ts"),
    "export function stable(value: number): string { return String(value); }\n",
  );
  await runCommand(process.execPath, [compiler, "--project", "pkg/tsconfig.json"], candidate);
  await runNpmCommand(
    ["pack", "--ignore-scripts", "--json", "--pack-destination", candidate],
    join(candidate, "pkg"),
  );
  await checkpoint(candidate);
  const broken = await execute([]);
  assert.notDeepEqual(broken.bytes, matched.bytes);
  assert.equal(broken.report.verdict, "incomplete");
  // Root metadata and missing released aggregates keep the overall phase unavailable;
  // the original typed comparator must still expose the concrete breaking change.
  assert.equal(broken.report.phases.find((row) => row.name === "released")?.status, "unavailable");
  assert.ok(
    broken.aggregate.capabilities[0].diagnostics.some((row) => row.ruleId.includes("breaking")),
  );
  await writeJson(join(candidate, "evidence/decisions.json"), [
    { authority: { status: "verified" } },
  ]);
  const forged = await check(cli, candidate, 2, false);
  assert.equal(forged.capabilities[0].problem.code, "PUBLIC_API_COMPATIBILITY_CONFIG_INVALID");
  assert.deepEqual(await readFile(join(candidate, "reports/sdk.json")), broken.bytes);
  return broken;
}
