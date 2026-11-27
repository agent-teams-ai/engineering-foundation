import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Row } from "../ef70-managed-campaign/campaign-io.ts";
import { sourceCohort } from "../ef70-managed-adoption/configuration.ts";
import {
  assertCurrentAuthority,
  errorObservation,
  resultEnvelope,
} from "../ef70-managed-adoption/evidence.ts";
import { bytes, inventory, retainAt, selected } from "../ef70-managed-adoption/files.ts";
import {
  assertTargetImages,
  type ProofContext,
  type Preparation,
} from "../ef70-managed-adoption/proofs.ts";
import {
  requireIdle,
  requireSettled,
  publicBarrier,
  retainedDebt,
} from "../ef70-managed-adoption/processes.ts";
import {
  assertTerminalSuccess,
  publicCommand,
  type PublicCommandResult,
} from "../ef70-managed-adoption/public-command.ts";
import { assertCurrentPR } from "./artifact-admission.ts";
import { assertForeignImages } from "./checkouts.ts";
import { admitCurrentSelection, assertOriginalProofs, type OriginalProofs } from "./proofs.ts";
import { assertInstalledSource, type SourceInstallation } from "./prerequisites.ts";

export function restoreArguments(input: {
  readonly consumer: string;
  readonly targetCohort: string;
  readonly revision: string;
  readonly tree: string;
  readonly preparation: string;
  readonly digest: string;
  readonly selection: string;
}): string[] {
  return [
    "restore",
    "--consumer",
    input.consumer,
    "--from",
    input.targetCohort,
    "--to",
    sourceCohort,
    "--source-generation",
    "3",
    "--target-generation",
    "2",
    "--preparation",
    input.preparation,
    "--expect",
    input.digest,
    "--current-revision",
    input.revision,
    "--current-tree",
    input.tree,
    "--selection",
    input.selection,
    "--json",
  ];
}
function capture(
  context: ProofContext,
  original: OriginalProofs,
  selectionPath: string,
  moment: string,
): void {
  const { evidence } = context;
  evidence.record(moment + "-full-inventory", inventory(evidence.config.consumer));
  assertOriginalProofs(original);
  const selection = existsSync(selectionPath) ? selected(selectionPath) : null;
  if (selection !== null) {
    evidence.retain(moment + "-current-selection.json", bytes(selectionPath));
  }
  evidence.record(moment + "-proofs", {
    original: original.retained.map((entry) => selected(entry.path)),
    currentSelection: selection,
  });
}
async function invokeRestore(
  context: ProofContext,
  original: OriginalProofs,
  path: string,
): Promise<Row> {
  const { evidence, prerequisites } = context,
    c = evidence.config;
  let actual: PublicCommandResult | undefined;
  const failures: unknown[] = [];
  try {
    actual = await publicCommand(evidence, {
      label: "restore-current",
      executable: c.node24,
      cli: prerequisites.controllerCli,
      args: restoreArguments({
        consumer: c.consumer,
        targetCohort: c.targetCohort,
        revision: c.sourceRevision,
        tree: context.source.tree,
        preparation: original.preparation.path,
        digest: original.preparation.digest,
        selection: path,
      }),
    });
  } catch (error) {
    failures.push(error);
  }
  try {
    await requireSettled(
      evidence,
      actual?.terminal.identity ? [actual.terminal.identity] : [],
      "restore-after",
    );
    capture(context, original, path, "restore-after");
    evidence.record("restore-after-owner-state", {
      barrier: await publicBarrier(prerequisites.controllerInstallation, c.consumer),
      debt: retainedDebt(evidence),
    });
  } catch (error) {
    failures.push(error);
  }
  try {
    assert(actual !== undefined, "Actual invocation has no terminal capture");
    assertTerminalSuccess(actual.terminal);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    evidence.record(
      "restore-failures",
      failures.map((error) => errorObservation(error)),
    );
    throw new AggregateError(
      failures,
      "Current recovery failed or custody remains uncertain; no retry or cleanup",
    );
  }
  assert(actual !== undefined);
  await requireIdle(evidence, prerequisites.controllerInstallation, "restore-confirmed-idle");
  return resultEnvelope(actual.stdout, "consumer.restore", "restored");
}
export async function executeRecovery(
  context: ProofContext,
  original: OriginalProofs,
  expectedSource: SourceInstallation,
): Promise<Preparation> {
  const { evidence, prerequisites } = context,
    c = evidence.config;
  const selection = join(evidence.operationRoot, "current-selection.json");
  assert(!existsSync(selection));
  const budget = join(evidence.operationRoot, "1-restore-current.rate-budget.json");
  evidence.command(
    "restore-anonymous-budget",
    c.node26,
    [join(c.harness, "tools/ef70-managed-campaign/rate-budget.ts"), budget, "12"],
    c.harness,
    { timeoutMs: 70 * 60_000 },
  );
  await assertCurrentAuthority(evidence, "restore-current-authority");
  await assertCurrentPR(evidence, "restore-current-pr70");
  await requireSettled(evidence, [], "restore-before");
  await requireIdle(evidence, prerequisites.controllerInstallation, "restore-before-owner-state");
  assert.deepEqual(inventory(c.consumer), context.source.images);
  capture(context, original, selection, "restore-before");
  const envelope = await invokeRestore(context, original, selection);
  const current = admitCurrentSelection(context, original.preparation, selection, envelope);
  assertTargetImages(context, current, "restored-confirmed");
  assertForeignImages(
    context.source.images,
    inventory(c.consumer),
    current.operations.map((entry) => entry.path),
  );
  assertInstalledSource(evidence, expectedSource);
  assertOriginalProofs(original);
  assert(bytes(selection).equals(current.content));
  await assertCurrentAuthority(evidence, "restore-final-authority");
  await assertCurrentPR(evidence, "restore-final-pr70");
  evidence.record("actual-restored-envelope", envelope);
  return current;
}
export function retainRecoveryOutput(context: ProofContext, selection: Preparation): Row {
  const { evidence } = context,
    c = evidence.config;
  const paths = evidence
    .command(
      "actual-inverse-paths",
      "/usr/bin/git",
      [
        "--no-replace-objects",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--name-only",
        "-z",
        c.sourceRevision,
        "--",
      ],
      c.consumer,
    )
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .toSorted();
  assert.deepEqual(paths, selection.operations.map((operation) => operation.path).toSorted());
  const patch = evidence.command(
    "actual-inverse-patch",
    "/usr/bin/git",
    [
      "--no-replace-objects",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--binary",
      "--full-index",
      c.sourceRevision,
      "--",
    ],
    c.consumer,
  );
  const retained = retainAt(c.roots.evidenceRoot, "actual-disposable-inverse.patch", patch);
  const images = inventory(c.consumer);
  const exported = paths.map((path) => {
    const image = images.find((entry) => entry.path === path);
    assert(image && image.kind === "file");
    const destination = retainAt(
      c.roots.evidenceRoot,
      "restored-files/" + path,
      bytes(join(c.consumer, path)),
    );
    return {
      ...image,
      retained: selected(destination),
      gitMode: image.mode === 0o644 ? "100644" : "100755",
    };
  });
  return {
    currentRevision: c.sourceRevision,
    currentTree: context.source.tree,
    files: exported,
    patch: selected(retained),
    scope:
      "Actual inverse in this disposable checkout only. Never apply this recovery delta to PR70; the product branch remains F.",
  };
}
