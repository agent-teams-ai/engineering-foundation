import assert from "node:assert/strict";
import { type Row } from "../ef70-managed-campaign/campaign-io.ts";
import { admitCheckouts, observeRuntimes, verifyPreflight } from "./admission.ts";
import { admitAuthority } from "./authority.ts";
import { configuration, type AdoptionConfig } from "./configuration.ts";
import { AdoptionEvidence, errorObservation } from "./evidence.ts";
import { inventory, selected } from "./files.ts";
import { retainActualOutput } from "./output.ts";
import { createProofContext } from "./proofs.ts";
import {
  installAuthorityMetadata,
  prepareController,
  prepareManagers,
  prepareSourceCache,
  prepareTargetCache,
  type Prerequisites,
} from "./prerequisites.ts";
import { processCensus, publicBarrier, retainedDebt } from "./processes.ts";
import { executeTransition } from "./transition.ts";

function selectedEnvironment(config: AdoptionConfig): Row {
  return Object.fromEntries(
    [
      "PATH",
      "COREPACK_HOME",
      "pnpm_config_store_dir",
      "npm_config_cache",
      "TMPDIR",
      "PNPM_MAX_WORKERS",
      "GOMAXPROCS",
      "RAYON_NUM_THREADS",
      "NODE_OPTIONS",
      "EF70_COMPILER_GUARD_LOG",
      "AGENT_TEAMS_DOCS_UPGRADE_NODE24_EXECUTABLE",
      "AGENT_TEAMS_DOCS_UPGRADE_NODE26_EXECUTABLE",
      "AGENT_TEAMS_DOCS_UPGRADE_COREPACK_ENTRYPOINT",
    ].map((name) => [name, config.environment[name]]),
  );
}
async function failureObservation(
  evidence: AdoptionEvidence,
  installation?: string,
): Promise<void> {
  const c = evidence.config;
  const census = processCensus([c.consumer, c.roots.root]);
  evidence.record("failure-process-census", census);
  const settled =
    census.livePrior.length === 0 && census.ownedCwd.length === 0 && census.unknown.length === 0;
  if (settled) {
    evidence.record("failure-observed-source-images", inventory(c.consumer));
    evidence.record("failure-retained-debt", retainedDebt(evidence));
    if (installation !== undefined) {
      evidence.record("failure-public-barrier", await publicBarrier(installation, c.consumer));
    }
  }
  evidence.record("failure-custody-scope", {
    observedOwnedRootsSettled: settled,
    scope:
      "Read-only observations. No retry, rollback, installation reconciliation, guard/lease removal or full-process-tree termination claim.",
  });
}
let evidence: AdoptionEvidence | undefined, authenticatedInstallation: string | undefined;
let stage = "configuration";
try {
  const c = configuration();
  evidence = new AdoptionEvidence(c);
  evidence.record("selected-canonical-inputs", {
    schemaVersion: 1,
    sourceRevision: c.sourceRevision,
    harnessRevision: c.harnessRevision,
    authorityRevision: c.authorityRevision,
    targetCohort: c.targetCohort,
    consumerRoot: c.consumer,
    centralRoot: c.central,
    harnessRoot: c.harness,
    hostRepository: process.env["GITHUB_REPOSITORY"],
    hostRepositoryId: process.env["GITHUB_REPOSITORY_ID"],
    hostRunId: c.roots.runId,
    hostRunAttempt: c.roots.runAttempt,
    roots: c.roots,
    scope: "Fresh canonical adoption inputs; historical8c16/C35 campaign is not relabeled.",
  });
  stage = "checkouts-and-preflight";
  const source = admitCheckouts(evidence);
  const preflight = await verifyPreflight(evidence);
  observeRuntimes(evidence);
  stage = "package-manager-and-authority";
  const corepack = prepareManagers(evidence);
  installAuthorityMetadata(evidence, corepack);
  const target = await admitAuthority(evidence, source);
  stage = "published-controller-authentication";
  const controller = await prepareController(evidence, target);
  authenticatedInstallation = controller.controllerInstallation;
  stage = "frozen-source-and-target-caches";
  prepareSourceCache(evidence, source, corepack);
  const targetLock = prepareTargetCache(evidence, source, corepack);
  const prerequisites: Prerequisites = { ...controller, corepack, targetLock };
  const harnessTree = evidence.git(c.harness, "final-harness-tree", ["rev-parse", "HEAD^{tree}"]);
  evidence.output("bootstrap-result", {
    schemaVersion: 1,
    evidenceClass: "actual-canonical-adoption-prerequisites",
    root: c.roots.root,
    evidenceRoot: c.roots.evidenceRoot,
    sourceRoot: c.consumer,
    centralRoot: c.central,
    controllerInstallation: controller.controllerInstallation,
    node24Executable: c.node24,
    node26Executable: c.node26,
    corepackEntrypoint: corepack,
    candidate: selected(target.candidatePath),
    targetLock,
    environment: selectedEnvironment(c),
    sourceRevision: c.sourceRevision,
    sourceTree: source.tree,
    authorityRevision: c.authorityRevision,
    targetCohort: c.targetCohort,
    hostRepository: "agent-teams-ai/extension-foundation",
    hostRepositoryId: 1333298097,
    hostRevision: c.sourceRevision,
    harnessRevision: c.harnessRevision,
    harnessTree,
    prerequisiteGeneration: c.roots.prerequisiteGeneration,
    producerPreflight: preflight,
    controllerArchivesVerification: controller.controllerArchives,
    qualificationClaim:
      "Authenticated prerequisites only; no managed transition or7+15 campaign completion.",
  });
  stage = "actual-published-transition";
  const proofContext = await createProofContext(evidence, source, target, prerequisites);
  const transition = await executeTransition(proofContext);
  stage = "actual-output-custody";
  const output = retainActualOutput(proofContext, transition);
  stage = "artifact-manifest";
  const manifest = evidence.artifactManifest(true);
  const completion = evidence.output("adoption-complete", {
    schemaVersion: 1,
    evidenceClass: "actual-published-canonical-adoption",
    outcome: "prepare-finalize-installed-check-complete",
    sourceRevision: c.sourceRevision,
    sourceTree: source.tree,
    targetCohort: c.targetCohort,
    authorityRevision: c.authorityRevision,
    workflowRevision: target.workflowRevision,
    harnessRevision: c.harnessRevision,
    harnessTree,
    hostRunId: c.roots.runId,
    hostRunAttempt: c.roots.runAttempt,
    preparation: { path: transition.preparation.path, sha256: transition.preparation.digest },
    completion: selected(proofContext.completionPath),
    receiptCompanion: selected(proofContext.completionPath + ".receipt"),
    receipt: transition.completion.receipt,
    targetCheck: transition.targetCheck,
    sourceRoot: source.identity,
    output,
    manifest: selected(manifest),
    scope:
      "Actual canonical sourceC transition only. Not the historical7+15 campaign, trusted Docs qualification, CANARY, finalCI or merge.",
    recoveryBoundary:
      "Genuine originalP remains root-bound. Committed recovery requires actual C ancestry on the PR branch; no post-squash-main recovery claim.",
  });
  stage = "complete";
  console.log(
    JSON.stringify({
      outcome: "canonical-adoption-complete",
      completion: selected(completion),
      sourceRevision: c.sourceRevision,
      targetCohort: c.targetCohort,
    }),
  );
} catch (error) {
  const failures: unknown[] = [error];
  if (evidence !== undefined) {
    try {
      await failureObservation(evidence, authenticatedInstallation);
    } catch (observationError) {
      failures.push(observationError);
    }
    try {
      evidence.output("adoption-failure", {
        schemaVersion: 1,
        stage,
        sourceRevision: evidence.config.sourceRevision,
        failures: failures.map((failure) => errorObservation(failure)),
        scope:
          "Actual failure/uncertainty retained; no transition completion, retry or cleanup is claimed.",
      });
      evidence.artifactManifest(false);
    } catch (captureError) {
      failures.push(captureError);
    }
  }
  console.error(
    JSON.stringify({
      outcome: "canonical-adoption-failed",
      stage,
      failures: failures.map((failure) => errorObservation(failure)),
    }),
  );
  process.exitCode = 1;
}
assert(stage === "complete" || process.exitCode === 1);
