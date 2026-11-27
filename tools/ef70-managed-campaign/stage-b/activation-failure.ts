import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
  type JsonRecord,
} from "../stage-a/io.ts";
import { github } from "../stage-a/publication.ts";
import { bytes, equal, git, image, inventory, sourceCohort, type Image } from "./context.ts";
import { admitActivationFailure, prepareActivationStore } from "./activation-admission.ts";
import {
  descendantProcesses,
  fileState,
  identity,
  processTable,
  sample,
  treeState,
  type ProcessSample,
} from "./activation-observation.ts";

// One actual cold finalize with a fresh empty package store. This fixture never
// rewrites proof, fabricates a receipt, restores, retries, removes a shared cache
// or changes production ports/child isolation. Cold evidence comes from a real
// prior interruption; owner reconciliation precedes this separate invocation.
const inputPath = process.argv.at(2);
if (!inputPath || process.argv.length !== 3) {
  throw new Error("Select one actual activation-failure operation JSON.");
}
const {
  c,
  selection,
  retained,
  completionPath,
  companionPath,
  companionBytes,
  receipt,
  receiptDigest,
  headBefore,
  treeBefore,
  pinBefore,
  before,
  installedBefore,
  assertTargetImages,
  backupNames,
  installedState,
  barrier,
  build,
  controllerBuild,
  kernelBuild,
  kernelRoot,
} = await admitActivationFailure(inputPath);
const { warmStore, corepackHome, emptyStore, emptyIdentity, childEnvironment } =
  prepareActivationStore(c, selection);

const args = [
  c.cli,
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
  retained.path,
  "--expect",
  retained.digest,
  "--proof",
  completionPath,
  "--json",
];
const installArgs = [
  c.node26,
  c.corepack,
  "pnpm",
  "install",
  "--offline",
  "--frozen-lockfile",
  "--package-import-method=copy",
  "--ignore-scripts",
  "--ignore-pnpmfile",
  "--verify-store-integrity",
];
jsonEvidence("selected-child.json", {
  executable: c.node24,
  arguments: args,
  cwd: c.consumer,
  environmentDelta: { pnpm_config_store_dir: emptyStore, COREPACK_ENABLE_NETWORK: "0" },
  warmStore,
  corepackHome,
  preparationDigest: retained.digest,
  contextAuthorityBefore: c.authorityRevision,
});
const child = spawn(c.node24, args, {
  cwd: c.consumer,
  env: childEnvironment,
  detached: true,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
});
const stdout: Buffer[] = [],
  stderr: Buffer[] = [];
let observedBytes = 0,
  overflow = false,
  closed = false,
  processError: string | null = null;
let status: number | null = null,
  signal: NodeJS.Signals | null = null;
for (const [stream, chunks] of [
  [child.stdout, stdout],
  [child.stderr, stderr],
] as const) {
  stream.on("data", (chunk: Buffer) => {
    observedBytes += chunk.length;
    if (observedBytes > 32 * 1024 * 1024) {
      overflow = true;
    } else {
      chunks.push(Buffer.from(chunk));
    }
  });
}
child.once("error", (error) => {
  processError = error.message;
});
child.once("close", (code, actualSignal) => {
  status = code;
  signal = actualSignal;
  closed = true;
});
const pid = child.pid,
  original = pid === undefined ? undefined : identity(pid);
const observed = new Map<string, ProcessSample>();
const witnesses: ProcessSample[] = [];
const captureErrors: string[] = [],
  sentSignals: NodeJS.Signals[] = [];
const deadline = Date.now() + 15 * 60_000;
let timedOut = false,
  terminatedAt: number | undefined;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
function signalOwned(selectedSignal: NodeJS.Signals): void {
  const current = pid === undefined ? undefined : identity(pid);
  if (
    !original ||
    !current ||
    current.start !== original.start ||
    current.pgid !== pid ||
    current.session !== pid
  ) {
    throw new Error("No current attributed owner group may be signalled.");
  }
  process.kill(-current.pid, selectedSignal);
  sentSignals.push(selectedSignal);
}
try {
  if (
    !original ||
    original.pgid !== pid ||
    original.session !== pid ||
    realpathSync(`/proc/${pid}/exe`) !== c.node24
  ) {
    throw new Error("Actual controller process custody was not observed.");
  }
  for (;;) {
    if (closed) {
      break;
    }
    const table = descendantProcesses(processTable(), original.pid);
    for (const entry of table) {
      const value = sample(entry);
      if (!value) {
        continue;
      }
      const key = `${value.pid}:${value.start}:${digest(JSON.stringify([value.executable, value.cwd, value.arguments]))}`;
      if (observed.size >= 2048 && !observed.has(key)) {
        throw new Error("Process capture exceeds its explicit bound.");
      }
      if (!observed.has(key)) {
        observed.set(key, value);
      }
      if (
        value.ppid === original.pid &&
        value.pgid === original.pid &&
        value.session === original.pid &&
        value.executable === c.node26 &&
        value.cwd === c.consumer &&
        JSON.stringify(value.arguments) === JSON.stringify(installArgs) &&
        value.selectedEnvironment["pnpm_config_store_dir"] === emptyStore &&
        value.selectedEnvironment["COREPACK_HOME"] === corepackHome &&
        value.selectedEnvironment["COREPACK_ENABLE_NETWORK"] === "0" &&
        !witnesses.some((prior) => prior.pid === value.pid && prior.start === value.start)
      ) {
        witnesses.push(value);
      }
    }
    timedOut ||= Date.now() >= deadline;
    if ((timedOut || overflow) && terminatedAt === undefined) {
      signalOwned("SIGTERM");
      terminatedAt = Date.now();
    }
    if (
      terminatedAt !== undefined &&
      Date.now() - terminatedAt >= 2_000 &&
      !sentSignals.includes("SIGKILL")
    ) {
      signalOwned("SIGKILL");
    }
    if (terminatedAt !== undefined && Date.now() - terminatedAt >= 5_000) {
      break;
    }
    await delay(20);
  }
} catch (error) {
  captureErrors.push(message(error));
  if (!closed) {
    try {
      signalOwned("SIGTERM");
      await delay(2_000);
      if (!closed) {
        signalOwned("SIGKILL");
      }
      await delay(100);
    } catch (cleanupError) {
      captureErrors.push(message(cleanupError));
    }
  }
}
await delay(100);
const capturedStdout = Buffer.concat(stdout),
  capturedStderr = Buffer.concat(stderr);
evidence("actual-cli.stdout", capturedStdout);
evidence("actual-cli.stderr", capturedStderr);
jsonEvidence("actual-process-result.json", {
  pid: pid ?? null,
  original: original ?? null,
  status,
  signal,
  processError,
  timedOut,
  overflow,
  sentSignals,
  outputStreamsClosed: closed,
  observedBytes,
  stdoutBytes: capturedStdout.length,
  stderrBytes: capturedStderr.length,
  stdoutDigest: digest(capturedStdout),
  stderrDigest: digest(capturedStderr),
  streamScope:
    closed && !overflow
      ? "complete raw public CLI streams"
      : "incomplete observed streams; cannot qualify the case",
});
if (!closed) {
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
}
jsonEvidence("observed-processes.json", {
  exhaustive: false,
  observations: [...observed.values()],
  installWitnesses: witnesses,
});
jsonEvidence("known-processes-after.json", {
  exhaustive: false,
  observations: [...observed.values()].map((prior) => ({
    prior,
    current: identity(prior.pid) ?? null,
  })),
  boundary:
    "The owner must reconcile any retained child or installation evidence before explicit restore/resume; this does not establish whole-tree termination.",
});
let after: readonly Image[] | undefined,
  completionAfter: JsonRecord | undefined,
  installedAfter: JsonRecord | undefined;
async function captureAfter(
  label: string,
  observe: () => unknown | Promise<unknown>,
): Promise<void> {
  try {
    jsonEvidence(label, await observe());
  } catch (error) {
    captureErrors.push(`${label}: ${message(error)}`);
  }
}
await captureAfter("after-observations.json", () => {
  after = inventory(c.consumer, "after");
  return {
    head: git(c.consumer, "after-head", ["rev-parse", "HEAD"]),
    tree: git(c.consumer, "after-tree", ["rev-parse", "HEAD^{tree}"]),
  };
});
await captureAfter("proofs-after.json", () => {
  completionAfter = fileState(completionPath, "proofs/completion-after.bin");
  return {
    completion: completionAfter,
    preparation: fileState(retained.path, "proofs/preparation-after.json"),
    originalCompanion: fileState(companionPath, "proofs/original-companion-after.json"),
  };
});
await captureAfter("after-local-evidence.json", () =>
  treeState(join(c.consumer, ".agent-teams-local"), "after-local", true),
);
await captureAfter("installation-after.json", () => {
  installedAfter = installedState("after");
  return installedAfter;
});
await captureAfter("store-after.json", () => treeState(emptyStore, "store-after", false));
await captureAfter("barrier-after.json", barrier);
await captureAfter("authority-after.json", async () => {
  const value = await github("repos/agent-teams-ai/.github/branches/main");
  requireEqual(
    object(value["commit"], "current authority commit")["sha"],
    c.authorityRevision,
    "authority remained selected during this case",
  );
  return value;
});
let envelope: JsonRecord | undefined;
await captureAfter("actual-failure-envelope.json", () => {
  envelope = parse(utf8(capturedStdout), "actual public failure envelope");
  return envelope;
});
jsonEvidence("capture-errors.json", captureErrors);
if (captureErrors.length || !closed || overflow || timedOut || processError || sentSignals.length) {
  throw new Error(
    "The actual attempt was retained but its capture cannot qualify the intended failure.",
  );
}
requireEqual(status, 1, "actual process-failure exit");
requireEqual(signal, null, "ordinary product failure exit");
if (!envelope) {
  throw new Error("No actual failure envelope was observed.");
}
equal(
  Object.keys(envelope).toSorted(),
  ["command", "issues", "outcome", "schemaVersion"],
  "actual public failure shape without a receipt",
);
requireEqual(envelope["schemaVersion"], 1, "public envelope schema");
requireEqual(envelope["command"], "consumer.finalize", "actual public command");
requireEqual(envelope["outcome"], "blocked", "actual incomplete activation outcome");
const issues = array(envelope["issues"], "actual issues");
requireEqual(issues.length, 1, "one actual process failure");
const issue = object(issues[0], "actual issue");
requireEqual(issue["code"], "DOCS_CONSUMER_UPGRADE_PROCESS_FAILED", "actual process owner failure");
requireEqual(issue["severity"], "error", "actual severity");
requireEqual(issue["subject"], "finalize", "actual failure subject");
if (
  !string(issue["message"], "actual diagnostic").includes("ERR_PNPM_NO_OFFLINE_TARBALL") ||
  witnesses.length === 0
) {
  throw new Error(
    "No genuine missing offline package diagnostic plus actual frozen-install process witness was established.",
  );
}
equal(after, before, "all target and foreign tracked images retained");
assertTargetImages();
requireEqual(
  git(c.consumer, "confirmed-head", ["rev-parse", "HEAD"]),
  headBefore,
  "source HEAD retained",
);
requireEqual(
  git(c.consumer, "confirmed-tree", ["rev-parse", "HEAD^{tree}"]),
  treeBefore,
  "source tree retained",
);
requireEqual(completionAfter?.["kind"], "absent", "completion remains absent");
equal(bytes(retained.path), retained.bytes, "preparation unchanged");
equal(bytes(companionPath), companionBytes, "original companion unchanged");
equal(image(c.consumer, ".node-version"), pinBefore, "same-pin bytes/mode retained");
equal(bytes(c.selectedLock.path), c.selectedLock.bytes, "selected lock unchanged");
requireEqual(digest(bytes(c.cli)), c.cliDigest, "retained CLI unchanged");
equal(
  bytes(join(c.controllerRoot, "package.json")),
  c.controllerManifest,
  "retained manifest unchanged",
);
equal(bytes(c.installLockPath), c.installLockBytes, "retained npm lock unchanged");
requireEqual(
  await build(c.controllerRoot, ["dist", "assets", "schemas"]),
  controllerBuild,
  "controller build unchanged",
);
requireEqual(await build(kernelRoot, ["dist", "schemas"]), kernelBuild, "kernel build unchanged");
requireEqual((await barrier())["state"], "idle", "actual final public barrier");
equal(
  installedAfter?.["modules"],
  installedBefore["modules"],
  "prior installation root identity preserved",
);
equal(
  installedAfter?.["manifests"],
  installedBefore["manifests"],
  "selected prior installed manifests preserved",
);
requireEqual(backupNames(), [], "installer left no observed backup debt");
requireEqual(lstatSync(emptyStore).ino, emptyIdentity.ino, "same owned fault store");
requireEqual(lstatSync(emptyStore).dev, emptyIdentity.dev, "same owned store filesystem");
jsonEvidence("activation-failure-observed.json", {
  evidenceClass: "actual-cold-offline-activation-failure",
  preparationDigest: retained.digest,
  contextAuthorityBefore: c.authorityRevision,
  observed: {
    publicExit: status,
    envelope,
    originalReceiptDigest: receiptDigest,
    originalReceiptOutcome: receipt["outcome"],
    currentInvocationReceiptEmitted: false,
    frozenInstallProcessWitnesses: witnesses,
    allTrackedImagesPreserved: true,
    targetPostimagesPresent: true,
    completionAbsent: true,
    originalCompanionUnchanged: true,
    actualBarrier: "idle",
    selectedPriorInstallationImagesPreserved: true,
    installationBackupNames: [],
    emptyStore,
    warmStore,
  },
  sourceOrderInference: {
    expectedLiveReceiptOwnership: "already-satisfied",
    basis:
      "All exact target images preceded this invocation; the observed fixed offline installer is reached only after applyKnownFileTransaction returned. Current production catch grants automatic managed inverse only to all-replaced live receipts.",
    limitation:
      "The failure envelope omits the live receipt. No current receipt is reconstructed, and unchanged snapshots alone do not prove absence of every transient write.",
  },
  compensationBoundary:
    "Tracked target images and the original companion remain exact. Prior node_modules restoration by installCohort is separate from managed inverse compensation.",
  processBoundary:
    "Only observed processes are recorded; no claim of complete detached-child termination. Reconcile owner evidence before recovery.",
  diagnosticBoundary:
    "Raw public CLI streams are complete; the public issue contains production-retained inner-command tails, not complete inner pnpm streams.",
  recoveryExecuted: false,
  completionClaimed: false,
  hostedConsumerQualificationClaimed: false,
  nextStep:
    "After owner reconciliation, use a fresh ordinary driver invocation with the preserved warmed store: explicit restore for M1 or finalize resume for M2. This collector performs neither.",
});
