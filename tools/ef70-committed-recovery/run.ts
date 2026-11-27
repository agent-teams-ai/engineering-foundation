import { join } from "node:path";
import { row } from "../ef70-managed-campaign/campaign-io.ts";
import { cohortId } from "../ef70-managed-adoption/configuration.ts";
import { observeRuntimes } from "../ef70-managed-adoption/admission.ts";
import { admitAuthority } from "../ef70-managed-adoption/authority.ts";
import { AdoptionEvidence, errorObservation } from "../ef70-managed-adoption/evidence.ts";
import { inventory, selected, retainAt, bytes } from "../ef70-managed-adoption/files.ts";
import {
  prepareManagers,
  installAuthorityMetadata,
  prepareController,
} from "../ef70-managed-adoption/prerequisites.ts";
import { createProofContext, assertInstalledTarget } from "../ef70-managed-adoption/proofs.ts";
import { processCensus, publicBarrier, retainedDebt } from "../ef70-managed-adoption/processes.ts";
import { configuration } from "./configuration.ts";
import { inspectArchive } from "./artifact-intake.ts";
import {
  admitOriginalArtifact,
  assertCurrentPR,
  assertCallerBindings,
} from "./artifact-admission.ts";
import { admitCheckouts } from "./checkouts.ts";
import { prepareCaches } from "./prerequisites.ts";
import { admitOriginalProofs } from "./proofs.ts";
import { executeRecovery, retainRecoveryOutput } from "./transition.ts";

async function captureFailure(
  evidence: AdoptionEvidence,
  installation: string | undefined,
  stage: string,
  failures: readonly unknown[],
): Promise<void> {
  const c = evidence.config;
  const census = processCensus([c.consumer, c.roots.root]);
  evidence.record("failure-process-census", census);
  const settled =
    census.livePrior.length === 0 && census.ownedCwd.length === 0 && census.unknown.length === 0;
  if (settled) {
    evidence.record("failure-images", inventory(c.consumer));
    evidence.record("failure-debt", retainedDebt(evidence));
    if (installation !== undefined) {
      evidence.record("failure-barrier", await publicBarrier(installation, c.consumer));
    }
  }
  evidence.output("committed-recovery-failure", {
    stage,
    currentRevision: c.sourceRevision,
    failures: failures.map((failure) => errorObservation(failure)),
    observedOwnedRootsSettled: settled,
    scope:
      "No retry, rollback, lease deletion, backup removal or whole-process-tree termination claim.",
  });
}

let evidence: AdoptionEvidence | undefined, installation: string | undefined;
let stage = "configuration";
try {
  const setup = configuration();
  stage = "bounded-original-archive";
  const archive = inspectArchive(setup);
  const c = { ...setup, targetCohort: cohortId(archive.marker["targetCohort"]) };
  evidence = new AdoptionEvidence(c);
  evidence.record("selected-recovery-inputs", {
    currentRevision: c.sourceRevision,
    authorityRevision: c.authorityRevision,
    harnessRevision: c.harnessRevision,
    original: c.artifact,
    roots: c.roots,
    originalSource: archive.marker["sourceRevision"],
    originalInitialRoot: archive.marker["sourceRoot"],
    scope:
      "One current-selection inverse for actual F; no forward preparation or old-root transfer.",
  });
  stage = "official-artifact-and-checkouts";
  const preflight = await admitOriginalArtifact(evidence, c, archive);
  await assertCurrentPR(evidence, "admission-current-pr70");
  const checkouts = admitCheckouts(evidence, archive);
  await assertCallerBindings(evidence, c, archive);
  observeRuntimes(evidence);
  stage = "authenticated-prerequisites";
  const corepack = prepareManagers(evidence);
  installAuthorityMetadata(evidence, corepack);
  const target = await admitAuthority(evidence, checkouts.original);
  const controller = await prepareController(evidence, target);
  installation = controller.controllerInstallation;
  const frozenTargetLock = retainAt(
    c.roots.evidenceRoot,
    "bootstrap/actual-f-target-lock.yaml",
    bytes(join(c.consumer, "pnpm-lock.yaml")),
  );
  const prerequisites = { ...controller, corepack, targetLock: selected(frozenTargetLock) };
  const context = await createProofContext(evidence, checkouts.current, target, prerequisites);
  stage = "original-proof-and-current-images";
  const original = admitOriginalProofs(context, archive, c.artifact, checkouts.original);
  stage = "frozen-source-and-target-caches";
  const sourceInstallation = prepareCaches(evidence, checkouts, corepack);
  assertInstalledTarget(context);
  const harnessTree = evidence.git(c.harness, "harness-final-tree", ["rev-parse", "HEAD^{tree}"]);
  evidence.output("bootstrap-result", {
    schemaVersion: 1,
    evidenceClass: "actual-committed-recovery-prerequisites",
    root: c.roots.root,
    evidenceRoot: c.roots.evidenceRoot,
    sourceRoot: c.consumer,
    originalSourceRoot: checkouts.originalRoot,
    currentRevision: c.sourceRevision,
    sourceRevision: checkouts.originalRevision,
    currentTree: checkouts.current.tree,
    authorityRevision: c.authorityRevision,
    targetCohort: c.targetCohort,
    harnessRevision: c.harnessRevision,
    harnessTree,
    producerPreflight: preflight,
    prerequisiteGeneration: c.roots.prerequisiteGeneration,
    originalArtifact: archive.archive,
    originalPreparation: selected(original.preparation.path),
    controllerArchivesVerification: controller.controllerArchives,
    scope: "Authenticated inputs only; no recovery completion yet.",
  });
  stage = "actual-current-selection-restore";
  const current = await executeRecovery(context, original, sourceInstallation);
  stage = "actual-inverse-custody";
  const output = retainRecoveryOutput(context, current);
  const manifest = evidence.output("artifact-manifest", {
    schemaVersion: 1,
    success: true,
    selfExcluded: true,
    files: inventory(c.roots.evidenceRoot, false),
    scope: "Actual retained recovery files; completion marker written only after all assertions.",
  });
  const completion = evidence.output("committed-recovery-complete", {
    schemaVersion: 1,
    evidenceClass: "actual-published-committed-current-selection-recovery",
    outcome: "restored",
    currentRevision: c.sourceRevision,
    currentTree: checkouts.current.tree,
    originalSourceRevision: checkouts.originalRevision,
    originalSourceTree: checkouts.original.tree,
    originalPreparation: selected(original.preparation.path),
    currentSelection: selected(current.path),
    inversePlanDigest: row(current.value["plan"], "Current inverse")["planDigest"],
    originalArtifact: c.artifact,
    hostRunId: c.roots.runId,
    hostRunAttempt: c.roots.runAttempt,
    actualCurrentRoot: checkouts.current.identity,
    authorityRevision: c.authorityRevision,
    harnessRevision: c.harnessRevision,
    harnessTree,
    output,
    manifest: selected(manifest),
    scope:
      "One actual current-selection inverse at final PR70 F, preserving all independent F images. No post-squash-main recovery, rollout, CANARY, 7+15 or merge claim.",
  });
  stage = "complete";
  console.log(
    JSON.stringify({
      outcome: "committed-recovery-complete",
      currentRevision: c.sourceRevision,
      completion: selected(completion),
    }),
  );
} catch (error) {
  const failures: unknown[] = [error];
  if (evidence !== undefined) {
    try {
      await captureFailure(evidence, installation, stage, failures);
    } catch (captureError) {
      failures.push(captureError);
    }
  }
  console.error(
    JSON.stringify({
      outcome: "committed-recovery-failed",
      stage,
      failures: failures.map((failure) => errorObservation(failure)),
    }),
  );
  process.exitCode = 1;
}
