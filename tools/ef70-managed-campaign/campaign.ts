import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Campaign,
  digest,
  jsonFile,
  row,
  text,
  type PreparedCase,
  type Row,
} from "./campaign-support.ts";
import { captureInstallation, reconcileCold, runColdChains } from "./cold-chains.ts";
import { runPreparedRefusals } from "./refusals.ts";

const expectedManaged = [
  ".github/workflows/docs-protocol.yml",
  "architecture/foundation/docs-consumer-integration.json",
  "architecture/foundation/docs-protocol-managed-state.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
];
const hostPaths = [
  ".github/workflows/ci.yml",
  ".github/workflows/package-conformance.yml",
  "AGENTS.md",
  "tests/evidence-custody.test.mjs",
  "tests/node-compatibility.test.mjs",
  "tests/qualification/artifact/packed.qualification.ts",
];
const expectedRefusals = [
  "wrong-controller",
  "wrong-target-runtime",
  "wrong-manager",
  "lock-digest",
  "lock-foreign-scope",
  "foreign-image",
  "pin-bytes",
  "pin-mode",
  "wrong-root",
  "build-drift",
  "stale-preparation-digest",
  "stale-current-digest",
  "host-overlap",
  "stale-current-head",
  "completed-republish",
];

function managedPaths(selectedCase: PreparedCase): readonly string[] {
  const plan = row(jsonFile(selectedCase.preparation.path)["plan"], "actual preparation plan");
  const operations = plan["operations"];
  assert(Array.isArray(operations));
  const paths = operations
    .map((entry: unknown) => text(row(entry, "operation")["path"], "managed path"))
    .toSorted();
  assert.deepEqual(paths, [...expectedManaged].toSorted());
  assert(!paths.includes(".node-version") && !paths.includes("AGENTS.md"));
  return paths;
}

function sourceInstallation(campaign: Campaign, selectedCase: PreparedCase): void {
  const original = jsonFile(join(campaign.sourceRoot, "package.json"));
  const expected = row(original["devDependencies"], "original dependencies");
  const manifest = jsonFile(join(selectedCase.root, "package.json"));
  assert.equal(manifest["packageManager"], "pnpm@11.18.0");
  const packages = [
    "@agent-teams/engineering-foundation",
    "@agent-teams/docs-protocol",
    "@agent-teams/docs-protocol-agent-teams",
  ];
  const installed = packages.map((name) => {
    const path = join(selectedCase.root, "node_modules", name, "package.json");
    const observed = jsonFile(path);
    assert.equal(observed["name"], name);
    assert.equal(observed["version"], expected[name]);
    return { name, version: observed["version"], sha256: digest(readFileSync(path)) };
  });
  campaign.record(`${selectedCase.name}-source-installation-observed`, {
    installed,
    scope:
      "Manifest bytes plus the actual preceding public restore installation/check; old Foundation code is not executed by this observer.",
  });
}

async function ordinary(campaign: Campaign): Promise<void> {
  const specimen = campaign.prepare(campaign.createCase("o"));
  managedPaths(specimen);
  await runPreparedRefusals(campaign, specimen);
  campaign.operation(specimen, "finalize", "applied");
  const completionPath = text(specimen.selection["completionPath"], "completion");
  const completion = readFileSync(completionPath),
    companion = readFileSync(`${completionPath}.receipt`);
  campaign.operation(specimen, "check-target");
  campaign.operation(specimen, "finalize", "already-satisfied");
  assert(readFileSync(completionPath).equals(completion));
  assert(readFileSync(`${completionPath}.receipt`).equals(companion));
  campaign.operation(specimen, "restore", "applied");
  sourceInstallation(campaign, specimen);
  campaign.call(specimen, "refusal", "completed-republish", {
    operation: "refusal",
    refusalCase: "completed-republish",
    fault: {},
  });
  campaign.record("case-o-complete", {
    case: "O",
    preparation: specimen.preparation,
    receiptSequence: ["applied", "already-satisfied", "applied"],
    originalCompletionAndCompanionUnchangedAcrossRepeat: true,
    completedRepublishActuallyRefused: true,
  });
}

function committedHostFixture(campaign: Campaign): {
  specimen: PreparedCase;
  managed: readonly string[];
  current: { head: string; tree: string };
} {
  const specimen = campaign.prepare(campaign.createCase("c"));
  const managed = managedPaths(specimen);
  campaign.operation(specimen, "finalize", "applied");
  campaign.operation(specimen, "check-target");
  campaign.commit(specimen, "c-managed", "test: commit actual managed target fixture", managed);

  const patch = join(campaign.toolsRoot, "fixtures/host-checkpoint.patch");
  campaign.git(specimen.root, "c-host-apply-check", ["apply", "--check", patch]);
  campaign.git(specimen.root, "c-host-apply", ["apply", patch]);
  const actualHostPaths = campaign
    .git(specimen.root, "c-host-paths", ["diff", "--name-only"])
    .split("\n")
    .filter(Boolean)
    .toSorted();
  assert.deepEqual(actualHostPaths, [...hostPaths].toSorted());
  const intersection = actualHostPaths.filter((path) => managed.includes(path));
  assert.deepEqual(intersection, []);
  const host = campaign.commit(
    specimen,
    "c-host",
    "test: retain reviewed EF Host fixture",
    hostPaths,
  );
  campaign.record("c-real-host-intersection", {
    actualHostPaths,
    actualManagedPaths: managed,
    intersection,
    actualHostCommit: host,
    checkpoint: "db48bb3d1f66a1d01dbca8d8138d35c097beb3c0",
    patch: campaign.selected(patch),
    overlapFixture:
      "A separate explicit inert package description change supplies the negative overlap case; the six real Host changes do not overlap.",
  });

  const packagePath = join(specimen.root, "package.json");
  const packageBefore = readFileSync(packagePath),
    parsed = jsonFile(packagePath);
  parsed["description"] =
    `${text(parsed["description"], "target description")} [EF70 explicit disposable overlap]`;
  const injected = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`);
  assert(!injected.equals(packageBefore));
  writeFileSync(join(specimen.evidence, "host-overlap-original-package.json"), packageBefore, {
    flag: "wx",
  });
  writeFileSync(packagePath, injected);
  const overlapping = campaign.commit(
    specimen,
    "c-explicit-overlap",
    "test: add explicit managed overlap fixture",
    ["package.json"],
  );
  const overlapSelection = join(specimen.evidence, "proofs/overlap-current-selection.json");
  campaign.call(specimen, "refusal", "host-overlap", {
    operation: "refusal",
    refusalCase: "host-overlap",
    fault: { path: "package.json" },
    currentRevision: overlapping.head,
    currentTree: overlapping.tree,
    currentSelectionPath: overlapSelection,
  });
  assert(!existsSync(overlapSelection));
  assert(readFileSync(packagePath).equals(injected));
  writeFileSync(packagePath, packageBefore);
  const current = campaign.commit(
    specimen,
    "c-overlap-reversal",
    "test: reverse only disposable managed overlap",
    ["package.json"],
  );
  assert.equal(current.tree, host.tree);
  assert.notEqual(current.head, host.head);
  campaign.record("c-overlap-owner-reversal", {
    overlapping,
    originalHost: host,
    current,
    reversedPath: "package.json",
    originalPackageSha256: digest(packageBefore),
    injectedPackageSha256: digest(injected),
    completeHostTreePreserved: true,
  });
  const staleSelection = join(specimen.evidence, "proofs/stale-head-current-selection.json");
  campaign.call(specimen, "refusal", "stale-current-head", {
    operation: "refusal",
    refusalCase: "stale-current-head",
    fault: {},
    currentRevision: host.head,
    currentTree: host.tree,
    currentSelectionPath: staleSelection,
  });
  assert(!existsSync(staleSelection));

  return { specimen, managed, current };
}

async function committed(campaign: Campaign): Promise<void> {
  const { specimen, managed, current } = committedHostFixture(campaign);
  // Capture CC while C still has its clean committed target and actual Host work.
  const cold = campaign.cloneCurrent("cc", specimen);
  const originalColdInstallation = await captureInstallation(
    campaign,
    cold,
    "cc-target-before-cold",
  );
  const coldSelectionPath = join(cold.evidence, "proofs/current-selection.json");
  const coldResult = campaign.call(cold, "cold-committed", "cold-committed-restore", {
    operation: "cold-interrupt-restore-committed",
    currentRevision: current.head,
    currentTree: current.tree,
    currentSelectionPath: coldSelectionPath,
  });
  await reconcileCold(campaign, cold, coldResult, "committed", originalColdInstallation);
  const coldSelection = campaign.selected(coldSelectionPath);
  const coldForeign = campaign
    .images(cold.root, "cc-foreign-before-resume")
    .filter((entry) => !managed.includes(entry.path));
  campaign.call(cold, "driver", "restore-committed-resume", {
    operation: "restore-committed",
    expectedReceiptOutcome: "already-satisfied",
    currentRevision: current.head,
    currentTree: current.tree,
    currentSelectionPath: coldSelectionPath,
    currentSelectionDigest: coldSelection.sha256,
  });
  assert.deepEqual(
    campaign
      .images(cold.root, "cc-foreign-after-resume")
      .filter((entry) => !managed.includes(entry.path)),
    coldForeign,
  );
  assert.equal(campaign.git(cold.root, "cc-preserved-head", ["rev-parse", "HEAD"]), current.head);
  assert.equal(
    campaign.git(cold.root, "cc-preserved-tree", ["rev-parse", "HEAD^{tree}"]),
    current.tree,
  );
  sourceInstallation(campaign, cold);
  campaign.record("case-cc-complete", {
    case: "CC",
    originalPreparation: cold.preparation,
    currentSelection: coldSelection,
    current,
    receiptOutcome: "already-satisfied",
    actualColdResult: coldResult.output,
    unrelatedHostImagesPreserved: true,
    interruptedInvocationAppliedReceiptClaimed: false,
  });

  const foreign = campaign
    .images(specimen.root, "c-foreign-before-inverse")
    .filter((entry) => !managed.includes(entry.path));
  const currentSelectionPath = join(specimen.evidence, "proofs/current-selection.json");
  const common: Row = {
    currentRevision: current.head,
    currentTree: current.tree,
    currentSelectionPath,
  };
  campaign.call(specimen, "driver", "restore-committed-applied", {
    ...common,
    operation: "restore-committed",
    expectedReceiptOutcome: "applied",
  });
  const actualSelection = campaign.selected(currentSelectionPath);
  const wrongDigest = `sha256:${"1".repeat(64)}`;
  assert.notEqual(actualSelection.sha256, wrongDigest);
  campaign.call(specimen, "refusal", "stale-current-digest", {
    ...common,
    operation: "refusal",
    refusalCase: "stale-current-digest",
    fault: { wrongDigest },
    currentSelectionDigest: actualSelection.sha256,
  });
  campaign.call(specimen, "driver", "restore-committed-repeat", {
    ...common,
    operation: "restore-committed",
    expectedReceiptOutcome: "already-satisfied",
    currentSelectionDigest: actualSelection.sha256,
  });
  assert.deepEqual(campaign.selected(currentSelectionPath), actualSelection);
  assert.deepEqual(
    campaign
      .images(specimen.root, "c-foreign-after-inverse")
      .filter((entry) => !managed.includes(entry.path)),
    foreign,
  );
  assert.equal(
    campaign.git(specimen.root, "c-preserved-head", ["rev-parse", "HEAD"]),
    current.head,
  );
  assert.equal(
    campaign.git(specimen.root, "c-preserved-tree", ["rev-parse", "HEAD^{tree}"]),
    current.tree,
  );
  sourceInstallation(campaign, specimen);
  campaign.record("case-c-complete", {
    case: "C",
    originalPreparation: specimen.preparation,
    currentSelection: actualSelection,
    current,
    receiptSequence: ["applied", "already-satisfied"],
    unrelatedHostImagesPreserved: true,
    actualRefusals: ["host-overlap", "stale-current-head", "stale-current-digest"],
  });
}

const input = process.argv[2];
assert(input && process.argv.length === 3, "Select one actual bootstrap-result.json");
const campaign = new Campaign(input);
try {
  await ordinary(campaign);
  await runColdChains(campaign);
  await committed(campaign);
  const cases = ["o", "f", "l", "c", "cc", "m1", "m2"];
  const markers = cases.map((id) => {
    const path = join(campaign.evidenceRoot, "orchestration", `case-${id}-complete.json`);
    assert(existsSync(path), `Missing actual case completion: ${id}`);
    return campaign.selected(path);
  });
  const refusals = campaign.calls
    .filter((entry) => entry["kind"] === "refusal")
    .map((entry) =>
      jsonFile(join(text(entry["output"], "refusal output"), "refusal-complete.json")),
    );
  assert.deepEqual(
    refusals.map((entry) => text(entry["refusalCase"], "refusal ID")).toSorted(),
    [...expectedRefusals].toSorted(),
  );
  const actualRefusals = refusals.map((entry) => {
    const issues = row(entry["envelope"], "actual refusal envelope")["issues"];
    assert(
      Array.isArray(issues) && issues.length > 0,
      "Actual owner refusal must contain its observed issue",
    );
    return {
      case: entry["refusalCase"],
      status: entry["status"],
      issue: row(issues[0], "actual issue"),
    };
  });
  campaign.record("campaign-complete", {
    schemaVersion: 1,
    evidenceClass: "actual-published-controller-disposable-campaign",
    cases,
    markers,
    refusals: actualRefusals,
    calls: campaign.calls,
    sourceRevision: campaign.bootstrap["sourceRevision"],
    authorityRevision: campaign.bootstrap["authorityRevision"],
    qualifiedAdoptionClaim: false,
    enrollmentObservedClaim: false,
    canaryClaim: false,
  });
  console.log("EF70 disposable campaign: seven chains and fifteen actual owner refusals passed.");
} catch (error) {
  campaign.record("campaign-failed", {
    schemaVersion: 1,
    completedCalls: campaign.calls,
    observedAt: new Date().toISOString(),
    message: error instanceof Error ? error.message : String(error),
    continuation:
      "Preserve actual state and evidence. No automatic retry, receipt reconstruction or guard removal.",
  });
  throw error;
}
