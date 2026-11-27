import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  array,
  digest,
  evidence,
  jsonEvidence,
  object,
  parse,
  requireEqual,
  string,
  utf8,
  type CommandResult,
} from "../stage-a/io.ts";
import { bytes, context, equal, git, inventory, sourceRevision } from "./context.ts";
import { keys, readRefusalSelection } from "./refusal-contracts.ts";
import {
  localEvidence,
  optionalFile,
  verifyLocalEvidence,
  type LocalEvidenceObservation,
} from "./refusal-evidence.ts";
import {
  bindRefusalPreparation,
  observeCurrentSelection,
  assertRefusalLifecycle,
  observeRefusalBuilds,
} from "./refusal-preparation.ts";
import {
  selectRefusalRuntime,
  selectRefusalInputs,
  observeRefusalImages,
  refusalArguments,
} from "./refusal-command.ts";

// One real public CLI call. Selection and observation helpers never invoke it.
const inputPath = process.argv.at(2);
if (!inputPath || process.argv.length !== 3) {
  throw new Error("Select one actual-refusal operation JSON.");
}
const input = bytes(inputPath, 1024 * 1024),
  selection = parse(utf8(input), "refusal selection");
const selected = readRefusalSelection(selection);
const { refusalCase, contract, fault } = selected;
evidence("selection.json", input);
const c = await context(selection);
const custody = bindRefusalPreparation(c, selection, refusalCase);
const { completionPath, preparationPath, retained, preparation, isCommitted } = custody;
const current = observeCurrentSelection(c, selection, refusalCase, isCommitted);
const { currentHead, currentTree, currentSelectionPath, currentDigest } = current;
assertRefusalLifecycle(c, refusalCase, custody);
const { kernelRoot, barrier, build, observedBuild, observedKernel } = await observeRefusalBuilds(
  c,
  preparation,
  refusalCase,
);
const preservedFiles = new Map<string, string>([
  ["preparation", preparationPath],
  ["completion", completionPath],
  ["receipt", `${completionPath}.receipt`],
  ["selected-lock", c.selectedLock.path],
]);
if (currentSelectionPath) {
  preservedFiles.set("current-selection", currentSelectionPath);
}

const { executable, childEnvironment, environmentDelta } = selectRefusalRuntime(
  c,
  refusalCase,
  fault,
  preservedFiles,
);
const inputs = selectRefusalInputs(c, selected, { retained, currentDigest, preservedFiles });
const expectedMessages = observeRefusalImages(c, selected, preparation, preservedFiles);
const { commandName, args } = refusalArguments(c, selection, custody, current, inputs);
const captureProofs = (phase: string) =>
  [...preservedFiles].map(([name, path]) => optionalFile(path, `proofs/${phase}/${name}.bin`));
requireEqual((await barrier())["state"], "idle", "initial actual RM barrier");
const before = inventory(c.consumer, "before");
const beforeStatus = git(c.consumer, "before-exact-status", [
  "status",
  "--porcelain=v1",
  "--untracked-files=all",
]);
const beforeLocal = localEvidence(c.consumer, "local-evidence-before");
const beforeProofs = captureProofs("before"),
  beforeEntries = readdirSync(c.consumer).toSorted();
jsonEvidence("before-local-evidence.json", beforeLocal);
jsonEvidence("before-proof-images.json", beforeProofs);
jsonEvidence("selected-child.json", {
  refusalCase,
  executable,
  arguments: [c.cli, ...args],
  cwd: c.consumer,
  environmentDelta,
  inheritedEnvironment:
    "Existing production environment and diagnostic observer preserved; only these finite selected fault deltas are added.",
});
let result: CommandResult | undefined;
let actualChildPid: number | undefined;
let localObservation: LocalEvidenceObservation | undefined;
try {
  // Capture this one actual child directly so the retained lease owner can be
  // bound to its OS-reported PID without changing the shared accepted io helper.
  const child = spawnSync(executable, [c.cli, ...args], {
    cwd: c.consumer,
    env: childEnvironment,
    timeout: 15 * 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const stdout = child.stdout ?? Buffer.alloc(0),
    stderr = child.stderr ?? Buffer.alloc(0);
  if (Number.isSafeInteger(child.pid) && child.pid > 0) {
    actualChildPid = child.pid;
  }
  evidence("actual-cli.stdout", stdout);
  evidence("actual-cli.stderr", stderr);
  jsonEvidence("actual-child.json", {
    executable,
    arguments: [c.cli, ...args],
    cwd: c.consumer,
    pid: actualChildPid ?? null,
    status: child.status,
    signal: child.signal,
    error: child.error?.message ?? null,
    stdoutDigest: digest(stdout),
    stderrDigest: digest(stderr),
  });
  if (
    child.error ||
    child.status === null ||
    ![0, 1, 2, 3].includes(child.status) ||
    actualChildPid === undefined
  ) {
    throw new Error(
      "The sole actual public CLI process did not complete within its selected capture contract.",
    );
  }
  result = { status: child.status, stdout, stderr };
} finally {
  const after = inventory(c.consumer, "after"),
    afterLocal = localEvidence(c.consumer, "local-evidence-after");
  const afterProofs = captureProofs("after");
  jsonEvidence("after-local-evidence.json", afterLocal);
  jsonEvidence("after-proof-images.json", afterProofs);
  equal(after, before, "tracked images preserved");
  requireEqual(git(c.consumer, "after-head", ["rev-parse", "HEAD"]), currentHead, "HEAD unchanged");
  requireEqual(
    git(c.consumer, "after-tree", ["rev-parse", "HEAD^{tree}"]),
    currentTree,
    "tree unchanged",
  );
  requireEqual(
    git(c.consumer, "after-exact-status", ["status", "--porcelain=v1", "--untracked-files=all"]),
    beforeStatus,
    "complete Git status unchanged",
  );
  localObservation = verifyLocalEvidence(
    c.consumer,
    refusalCase,
    beforeLocal,
    afterLocal,
    actualChildPid,
  );
  const expectedEntries = localObservation.addedPaths.includes(".agent-teams-local")
    ? [...beforeEntries, ".agent-teams-local"].toSorted()
    : beforeEntries;
  equal(
    readdirSync(c.consumer).toSorted(),
    expectedEntries,
    "only the required owner evidence root may be added",
  );
  jsonEvidence("local-evidence-delta.json", localObservation);
  equal(afterProofs, beforeProofs, "actual proof and selected input bytes unchanged");
  requireEqual((await barrier())["state"], "idle", "final actual RM barrier");
  requireEqual(digest(bytes(c.cli)), c.cliDigest, "same retained CLI");
  equal(
    bytes(join(c.controllerRoot, "package.json")),
    c.controllerManifest,
    "same retained manifest",
  );
  equal(bytes(c.installLockPath), c.installLockBytes, "same retained npm lock");
  requireEqual(
    await build(c.controllerRoot, ["dist", "assets", "schemas"]),
    observedBuild,
    "observed controller build unchanged by refusal",
  );
  requireEqual(
    await build(kernelRoot, ["dist", "schemas"]),
    observedKernel,
    "observed kernel build unchanged by refusal",
  );
}
if (!result || !localObservation) {
  throw new Error("No actual CLI result and complete local evidence observation were obtained.");
}
const envelope = parse(utf8(result.stdout), "actual public refusal envelope");
keys(envelope, ["schemaVersion", "command", "outcome", "issues"]);
requireEqual(envelope["schemaVersion"], 1, "public envelope version");
requireEqual(envelope["command"], `consumer.${commandName}`, "public command");
requireEqual(envelope["outcome"], "blocked", "actual blocked outcome");
const issues = array(envelope["issues"], "actual refusal issues").map((value) =>
  object(value, "actual issue"),
);
requireEqual(issues.length, 1, "one selected owner refusal");
const issue = issues[0]!;
keys(issue, ["code", "severity", "subject", "message"]);
requireEqual(issue["code"], contract.code, "actual owner issue code");
requireEqual(issue["severity"], "error", "actual issue severity");
requireEqual(issue["subject"], commandName, "actual issue subject");
const message = string(issue["message"], "actual issue message");
if (!expectedMessages.some((fragment) => message.includes(fragment))) {
  throw new Error("Actual refusal is not the selected owner guard.");
}
requireEqual(
  result.status,
  contract.code === "DOCS_CONSUMER_EXECUTION_FAILURE" ? 3 : 1,
  "actual public failure exit",
);
jsonEvidence("refusal-complete.json", {
  evidenceClass: "actual-published-controller-admission-refusal",
  refusalCase,
  operation: contract.operation,
  status: result.status,
  envelope,
  authorityRevision: c.authorityRevision,
  sourceRevision,
  targetCohort: c.targetCohort,
  runtimeExecutable: executable,
  environmentDelta,
  spawnedChildPid: actualChildPid,
  trackedImagesUnchanged: true,
  localEvidenceUnchanged: localObservation.state === "unchanged",
  priorLocalEvidenceUnchanged: true,
  localEvidenceDelta: localObservation,
  proofsUnchanged: true,
  publicBarrier: "idle",
  guardBasis:
    "The matched exact source-owned admission guard precedes claim/apply. Four explicitly selected guards run under a lease and retain its one captured release image. Snapshot observations alone are not a claim about unobserved transient writes.",
  limits:
    "One real public CLI call; no automatic retry/recovery or qualification/adoption/CANARY grant. A harness, transport, timeout, compiler-guard or unrelated CLI failure does not satisfy this result.",
});
