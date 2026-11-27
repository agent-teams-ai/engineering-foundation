import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { type Row } from "../ef70-managed-campaign/campaign-io.ts";
import { sourceCohort } from "./configuration.ts";
import {
  AdoptionEvidence,
  assertCurrentAuthority,
  errorObservation,
  resultEnvelope,
} from "./evidence.ts";
import { bytes, inventory, retainAt, selected } from "./files.ts";
import {
  assertInstalledTarget,
  assertTargetImages,
  readCompletion,
  selectPreparation,
  type Preparation,
  type ProofContext,
} from "./proofs.ts";
import { publicBarrier, requireIdle, requireSettled, retainedDebt } from "./processes.ts";
import {
  assertTerminalSuccess,
  publicCommand,
  type PublicCommandResult,
} from "./public-command.ts";

type Phase = "prepare" | "finalize" | "check-target";
function capturePhase(context: ProofContext, phase: Phase, moment: "before" | "after"): void {
  const { evidence, completionPath } = context;
  const images = inventory(evidence.config.consumer);
  evidence.record(phase + "-" + moment + "-source-images", images);
  const proofs: Row[] = [];
  for (const [name, path] of [
    ["preparation", completionPath + ".prepared"],
    ["completion", completionPath],
    ["receipt", completionPath + ".receipt"],
  ] as const) {
    if (!existsSync(path)) {
      proofs.push({ name, path, absent: true });
      continue;
    }
    const content = bytes(path);
    const retained = retainAt(
      evidence.operationRoot,
      phase + "-" + moment + "/" + name + ".json",
      content,
    );
    proofs.push({ name, original: selected(path), retained: selected(retained) });
  }
  evidence.record(phase + "-" + moment + "-proofs", proofs);
}
async function pace(evidence: AdoptionEvidence, phase: Phase): Promise<void> {
  if (phase === "check-target") {
    return;
  }
  const index = phase === "prepare" ? 1 : 2;
  const output = join(evidence.operationRoot, index + "-" + phase + ".rate-budget.json");
  evidence.command(
    phase + "-anonymous-budget",
    evidence.config.node26,
    [join(evidence.config.harness, "tools/ef70-managed-campaign/rate-budget.ts"), output, "12"],
    evidence.config.harness,
    { timeoutMs: 70 * 60_000 },
  );
}
async function observeAfter(
  context: ProofContext,
  phase: Phase,
  actual?: PublicCommandResult,
): Promise<void> {
  const { evidence, prerequisites } = context;
  const previous = actual?.terminal.identity;
  await requireSettled(evidence, previous ? [previous] : [], phase);
  capturePhase(context, phase, "after");
  const barrier = await publicBarrier(
    prerequisites.controllerInstallation,
    evidence.config.consumer,
  );
  evidence.record(phase + "-after-owner-state", { barrier, debt: retainedDebt(evidence) });
}
async function executePhase(
  context: ProofContext,
  request: {
    readonly phase: Phase;
    readonly executable: string;
    readonly cli: string;
    readonly args: readonly string[];
  },
): Promise<Row> {
  const { evidence, prerequisites } = context;
  await pace(evidence, request.phase);
  await assertCurrentAuthority(evidence, request.phase + "-current-authority");
  await requireSettled(evidence, [], request.phase + "-before");
  await requireIdle(
    evidence,
    prerequisites.controllerInstallation,
    request.phase + "-before-owner-state",
  );
  capturePhase(context, request.phase, "before");
  let actual: PublicCommandResult | undefined;
  const failures: unknown[] = [];
  try {
    actual = await publicCommand(evidence, {
      label: request.phase,
      executable: request.executable,
      cli: request.cli,
      args: request.args,
    });
  } catch (error) {
    failures.push(error);
  }
  try {
    await observeAfter(context, request.phase, actual);
  } catch (error) {
    failures.push(error);
  }
  if (actual !== undefined) {
    try {
      assertTerminalSuccess(actual.terminal);
    } catch (error) {
      failures.push(error);
    }
  } else {
    failures.push(new Error("Actual public invocation did not yield a terminal capture"));
  }
  if (failures.length > 0) {
    evidence.record(
      request.phase + "-failures",
      failures.map((error) => errorObservation(error)),
    );
    throw new AggregateError(
      failures,
      "Actual operation or after-capture failed; preserve evidence without retry or cleanup.",
    );
  }
  assert(actual !== undefined);
  await requireIdle(
    evidence,
    prerequisites.controllerInstallation,
    request.phase + "-confirmed-idle",
  );
  const command =
    request.phase === "prepare"
      ? "consumer.upgrade"
      : request.phase === "finalize"
        ? "consumer.finalize"
        : "consumer.check";
  const outcome =
    request.phase === "prepare"
      ? "prepared"
      : request.phase === "finalize"
        ? "upgraded"
        : "current";
  const envelope = resultEnvelope(actual.stdout, command, outcome);
  evidence.record(request.phase + "-verified-envelope", envelope);
  return envelope;
}
function prepareArguments(context: ProofContext): string[] {
  const c = context.evidence.config,
    { targetLock } = context.prerequisites;
  return [
    "upgrade",
    "--consumer",
    c.consumer,
    "--to",
    c.targetCohort,
    "--authority-revision",
    c.authorityRevision,
    "--source-generation",
    "2",
    "--target-generation",
    "3",
    "--prepare",
    "--restoration-proof",
    context.completionPath,
    "--target-lockfile",
    targetLock.path,
    "--target-lockfile-sha256",
    targetLock.sha256,
    "--json",
  ];
}
function finalizeArguments(context: ProofContext, preparation: Preparation): string[] {
  const c = context.evidence.config;
  return [
    "finalize",
    "--consumer",
    c.consumer,
    "--from",
    sourceCohort,
    "--to",
    c.targetCohort,
    "--source-generation",
    "2",
    "--target-generation",
    "3",
    "--preparation",
    preparation.path,
    "--expect",
    preparation.digest,
    "--proof",
    context.completionPath,
    "--json",
  ];
}
export interface TransitionResult {
  readonly preparation: Preparation;
  readonly completion: ReturnType<typeof readCompletion>;
  readonly targetCheck: Row;
}
export async function executeTransition(context: ProofContext): Promise<TransitionResult> {
  const c = context.evidence.config,
    cli = context.prerequisites.controllerCli;
  const preparedEnvelope = await executePhase(context, {
    phase: "prepare",
    executable: c.node24,
    cli,
    args: prepareArguments(context),
  });
  const preparation = selectPreparation(context, preparedEnvelope);
  const appliedEnvelope = await executePhase(context, {
    phase: "finalize",
    executable: c.node24,
    cli,
    args: finalizeArguments(context, preparation),
  });
  const completion = readCompletion(context, preparation, appliedEnvelope);
  assertTargetImages(context, preparation, "finalize-confirmed");
  const targetCli = assertInstalledTarget(context);
  assert.equal(realpathSync(targetCli), targetCli);
  const targetCheck = await executePhase(context, {
    phase: "check-target",
    executable: c.node26,
    cli: targetCli,
    args: ["check", "--consumer", c.consumer, "--json"],
  });
  assertTargetImages(context, preparation, "check-target-confirmed");
  assert(bytes(context.completionPath).equals(completion.completionBytes));
  assert(bytes(context.completionPath + ".receipt").equals(completion.companionBytes));
  await assertCurrentAuthority(context.evidence, "authority-after-transition");
  return { preparation, completion, targetCheck };
}
