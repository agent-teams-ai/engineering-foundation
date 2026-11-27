import assert from "node:assert/strict";
import { mkdtempSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import {
  digest,
  row,
  text,
  type Campaign,
  type HelperResult,
  type PreparedCase,
  type Row,
} from "./campaign-support.ts";
import {
  backups,
  captureInstallation,
  directory,
  inside,
  installation,
  json,
  observeAttemptDebt,
  ownedCase,
  present,
  readBounded,
  reconcileInstallation,
  type InstallationSnapshot,
} from "./cold-custody.ts";
import { idleBarrier, recordedProcesses, settledProcesses } from "./cold-processes.ts";

export { captureInstallation, type InstallationSnapshot };

/** Reconcile only actual captured identities; never erase a lease, journal or attempt. */
export async function reconcileCold(
  campaign: Campaign,
  selected: PreparedCase,
  cold: HelperResult,
  mode: "forward" | "committed" = "forward",
  captured?: InstallationSnapshot,
): Promise<void> {
  ownedCase(campaign, selected);
  inside(selected.evidence, cold.output);
  const label = selected.name + "-" + basename(cold.output) + "-reconcile";
  const result = json(join(cold.output, "actual-process-result.json"));
  assert.equal(result["code"], null);
  assert.equal(result["signal"], "SIGKILL");
  for (const key of ["processError", "fixtureError"]) {
    assert.equal(result[key], null);
  }
  for (const key of ["missed", "overflow"]) {
    assert.equal(result[key], false);
  }
  for (const key of ["interrupted", "outputStreamsClosed"]) {
    assert.equal(result[key], true);
  }
  for (const stream of ["stdout", "stderr"]) {
    assert.equal(
      digest(readBounded(join(cold.output, "actual-cli." + stream)).bytes),
      result[stream + "Digest"],
    );
  }
  const marker = json(
    join(
      cold.output,
      mode === "forward"
        ? "cold-interruption-complete.json"
        : "cold-committed-interruption-complete.json",
    ),
  );
  assert.equal(
    marker["evidenceClass"],
    mode === "forward"
      ? "actual-external-controller-interruption"
      : "actual-external-committed-restore-interruption",
  );
  assert.equal(
    marker[mode === "forward" ? "preparationDigest" : "originalPreparationDigest"],
    selected.preparation.sha256,
  );
  assert.equal(row(marker["result"], "actual interrupted result")["signal"], "SIGKILL");
  const controller = row(marker["controller"], "actual cold controller");
  const prior = recordedProcesses(json(join(cold.output, "processes-at-stop.json"))["observed"]);
  assert(
    prior.some((value) => value.pid === controller["pid"] && value.start === controller["start"]),
  );
  const selectedProof = text(selected.selection["completionPath"], "completion path");
  if (mode === "forward") {
    assert.equal(marker["completionAbsent"], true);
    assert.equal(present(selectedProof), false);
    assert.equal(
      digest(readBounded(selectedProof + ".receipt").bytes),
      digest(readBounded(join(cold.output, "proofs/receipt-at-stop.json")).bytes),
    );
  } else {
    assert.equal(marker["inverseImagesPresent"], true);
    assert.equal(marker["publicBarrier"], "idle");
    assert.equal(marker["sourceInstallationStarted"], false);
    assert.equal(marker["receiptOwnershipClaimed"], false);
    const input = json(join(cold.output, "selection.json"));
    const currentPath = text(input["currentSelectionPath"], "actual current selection");
    assert.equal(campaign.selected(currentPath).sha256, marker["currentSelectionDigest"]);
    assert.deepEqual(
      captured?.manifests,
      installation(selected.root).manifests,
      "Committed probe phase must retain the observed target installation",
    );
  }
  await settledProcesses(campaign, selected, label, prior);
  await idleBarrier(campaign, selected.root, label + "-barrier-before");
  observeAttemptDebt(campaign, label + "-runtime-debt");
  reconcileInstallation(campaign, selected, label, captured);
  await idleBarrier(campaign, selected.root, label + "-barrier-after");
  assert.deepEqual(campaign.selected(selected.preparation.path), selected.preparation);
  campaign.record(label + "-complete", {
    mode,
    preparation: selected.preparation,
    coldOutput: cold.output,
    noUnattributedSignals: true,
    noLeaseOrAttemptEdits: true,
    observationsAreNonexhaustive: true,
  });
}

function receiptOwnership(proof: Row, outcome: "applied" | "already-satisfied"): void {
  const receipt = row(proof["receipt"], "actual receipt");
  assert.equal(receipt["schemaVersion"], 1);
  assert.equal(receipt["protocol"], "agent-teams.repository-mutation.known-file/v1");
  assert.equal(receipt["outcome"], outcome);
  const operations = receipt["operations"];
  assert(Array.isArray(operations) && operations.length > 0);
  for (const operation of operations) {
    assert.equal(
      row(operation, "receipt operation")["outcome"],
      outcome === "applied" ? "replaced" : "already-satisfied",
    );
  }
}
function loseCompanion(campaign: Campaign, selected: PreparedCase): string {
  const completion = text(selected.selection["completionPath"], "completion path");
  assert.equal(present(completion), false);
  const path = completion + ".receipt",
    original = readBounded(path);
  const value = row(JSON.parse(original.bytes.toString("utf8")), "authentic original companion");
  assert.equal(value["preparationDigest"], selected.preparation.sha256);
  receiptOwnership(value, "applied");
  const before = campaign.images(selected.root, selected.name + "-loss-before");
  const quarantine = mkdtempSync(join(selected.evidence, "receipt-loss-"));
  assert.equal(directory(quarantine).device, original.identity.device);
  const destination = join(quarantine, "original-applied-companion.json");
  assert.equal(present(destination), false);
  campaign.record(selected.name + "-receipt-loss-intent", {
    path,
    destination,
    identity: original.identity,
    sha256: digest(original.bytes),
    contentBase64: original.bytes.toString("base64"),
    classification:
      "Deliberate external loss after an observed real interruption; not a natural pre-companion crash.",
  });
  assert.deepEqual(readBounded(path), original);
  renameSync(path, destination);
  assert.equal(present(path), false);
  assert.deepEqual(readBounded(destination), original);
  assert.equal(present(completion), false);
  assert.deepEqual(campaign.selected(selected.preparation.path), selected.preparation);
  assert.deepEqual(campaign.images(selected.root, selected.name + "-loss-after"), before);
  campaign.record(selected.name + "-receipt-loss-observed", {
    selectedPathAbsent: true,
    quarantine: campaign.selected(destination),
    originalIdentity: original.identity,
    preservedRawBytes: true,
    consumerTrackedImagesUnchanged: true,
  });
  return destination;
}
async function reconcileFailure(
  campaign: Campaign,
  selected: PreparedCase,
  failure: HelperResult,
): Promise<void> {
  const label = selected.name + "-" + basename(failure.output) + "-reconcile";
  const result = json(join(failure.output, "actual-process-result.json"));
  assert.equal(result["status"], 1);
  for (const key of ["signal", "processError"]) {
    assert.equal(result[key], null);
  }
  for (const key of ["timedOut", "overflow"]) {
    assert.equal(result[key], false);
  }
  assert.equal(result["outputStreamsClosed"], true);
  assert.deepEqual(result["sentSignals"], []);
  assert.equal(failure.result["evidenceClass"], "actual-cold-offline-activation-failure");
  const observations = json(join(failure.output, "observed-processes.json"));
  const prior = recordedProcesses(observations["observations"]);
  const witnesses = observations["installWitnesses"];
  assert(Array.isArray(witnesses) && witnesses.length > 0);
  await settledProcesses(campaign, selected, label, prior);
  await idleBarrier(campaign, selected.root, label + "-barrier");
  observeAttemptDebt(campaign, label + "-runtime-debt");
  assert.deepEqual(backups(selected.root), []);
  assert.equal(present(text(selected.selection["completionPath"], "completion")), false);
  campaign.record(label + "-complete", {
    failureOutput: failure.output,
    currentInvocationReceiptReconstructed: false,
    recoveryExecuted: false,
  });
}

/** Four real serial chains. Existing public helpers own every managed operation. */
export async function runColdChains(campaign: Campaign): Promise<void> {
  for (const name of ["f", "l", "m1", "m2"]) {
    const selected = campaign.prepare(campaign.createCase(name));
    const captured = captureInstallation(campaign, selected, "before-cold-installation");
    const cold = campaign.call(selected, "cold", "cold", { operation: "cold-interrupt-finalize" });
    await reconcileCold(campaign, selected, cold, "forward", captured);
    const completion = text(selected.selection["completionPath"], "completion path");
    const originalCompanion = campaign.selected(completion + ".receipt");
    let quarantined: string | undefined;
    let failedActivation: HelperResult | undefined;
    let resumed: HelperResult | undefined;
    let checked: HelperResult | undefined;
    if (name === "l") {
      quarantined = loseCompanion(campaign, selected);
    }
    if (name === "m1" || name === "m2") {
      const failure = campaign.call(selected, "activation-failure", "activation-failure", {
        operation: "activation-failure",
        coldInterruption: campaign.selected(join(cold.output, "cold-interruption-complete.json")),
        coldReceipt: campaign.selected(join(cold.output, "proofs/receipt-at-stop.json")),
        coldProcesses: campaign.selected(join(cold.output, "processes-at-stop.json")),
        emptyStoreRoot: join(campaign.root, "case-" + name + "-empty-store"),
      });
      failedActivation = failure;
      await reconcileFailure(campaign, selected, failure);
      assert.deepEqual(campaign.selected(completion + ".receipt"), originalCompanion);
    }
    if (name !== "m1") {
      resumed = campaign.operation(selected, "finalize", "already-satisfied");
      const completed = json(completion);
      assert.deepEqual(Object.keys(completed).toSorted(), [
        "activation",
        "preparationDigest",
        "protocol",
        "receipt",
        "schemaVersion",
      ]);
      assert.equal(completed["schemaVersion"], 1);
      assert.equal(completed["protocol"], "agent-teams.managed-generation3-completion/v1");
      assert.equal(completed["preparationDigest"], selected.preparation.sha256);
      assert.equal(completed["activation"], "verified-current-v3");
      receiptOwnership(completed, "already-satisfied");
      assert.deepEqual(completed["receipt"], resumed.result["receipt"]);
      if (name === "l") {
        const companion = json(completion + ".receipt");
        assert.deepEqual(Object.keys(companion).toSorted(), ["preparationDigest", "receipt"]);
        assert.equal(companion["preparationDigest"], selected.preparation.sha256);
        receiptOwnership(companion, "already-satisfied");
        assert.deepEqual(companion["receipt"], resumed.result["receipt"]);
        assert(quarantined !== undefined);
        assert.equal(campaign.selected(quarantined).sha256, originalCompanion.sha256);
      } else {
        assert.deepEqual(campaign.selected(completion + ".receipt"), originalCompanion);
      }
      checked = campaign.operation(selected, "check-target");
    }
    const retainedProofs = {
      preparation: campaign.selected(selected.preparation.path),
      companion: campaign.selected(completion + ".receipt"),
      completion: present(completion) ? campaign.selected(completion) : null,
      quarantined: quarantined === undefined ? null : campaign.selected(quarantined),
    };
    const restored = campaign.operation(selected, "restore", "applied");
    for (const retained of Object.values(retainedProofs)) {
      if (retained !== null) {
        assert.deepEqual(campaign.selected(retained.path), retained);
      }
    }
    assert.deepEqual(campaign.selected(selected.preparation.path), selected.preparation);
    if (name === "m1") {
      assert.equal(present(completion), false);
    }
    campaign.record("case-" + name + "-complete", {
      evidenceClass: "actual-published-controller-cold-chain",
      case: name,
      consumerRoot: selected.root,
      preparation: selected.preparation,
      coldOutput: cold.output,
      failedActivationOutput: failedActivation?.output ?? null,
      resumedOutput: resumed?.output ?? null,
      targetCheckOutput: checked?.output ?? null,
      sourceRestoreOutput: restored.output,
      sourceRestoreReceipt: restored.result["receipt"],
      targetReceipt: resumed?.result["receipt"] ?? null,
      explicitOriginalRestore: true,
      hostedConsumerQualificationClaimed: false,
      retainedProofs,
      retainedInstallationAndProofs: true,
    });
  }
}
