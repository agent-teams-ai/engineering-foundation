import {
  identity,
  descendants,
  isRuntimeProbe,
  currentRuntimeProbe,
  type ProcessIdentity,
} from "./cold-process-observation.ts";
import { spawn } from "node:child_process";
import { observationChildEnvironment } from "../owned-root.ts";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveInstalledPublicKernel } from "../installed-public-kernel.ts";
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
} from "../stage-a/io.ts";
import { invoke } from "../stage-a/publication.ts";
import {
  bytes,
  context,
  equal,
  exactPath,
  git,
  image,
  inventory,
  selectedBytes,
  sourceCohort,
  sourceRevision,
} from "./context.ts";

// A separate external fault fixture. No private imports, replacement ports,
// invented receipt, controller modification or production environment override.

const inputPath = process.argv.at(2);
if (!inputPath || process.argv.length !== 3) {
  throw new Error("Select one committed cold fixture JSON.");
}
const input = bytes(inputPath, 1024 * 1024),
  selection = parse(utf8(input), "cold committed selection");
requireEqual(
  selection["operation"],
  "cold-interrupt-restore-committed",
  "separate selected operation",
);
evidence("selection.json", input);
const c = await context(selection);
const retained = selectedBytes(selection["preparation"], "actual original preparation");
const preparation = parse(utf8(retained.bytes), "actual original preparation");
requireEqual(
  preparation["protocol"],
  "agent-teams.managed-generation3-preparation/v1",
  "actual preparation family",
);
requireEqual(preparation["sourceRevision"], sourceRevision, "original campaign source binding");
const completionPath = exactPath(selection["completionPath"], "selected original completion path");
requireEqual(retained.path, `${completionPath}.prepared`, "original preparation namespace");
requireEqual(preparation["initialProofPath"], completionPath, "original completion namespace");
equal(preparation["targetCohort"], c.targetBinding, "actual qualified target binding");
const currentRevision = string(selection["currentRevision"], "selected current revision");
const currentTree = string(selection["currentTree"], "selected current tree");
requireEqual(
  git(c.consumer, "current-head", ["rev-parse", "HEAD"]),
  currentRevision,
  "actual current HEAD",
);
requireEqual(
  git(c.consumer, "current-tree", ["rev-parse", "HEAD^{tree}"]),
  currentTree,
  "actual current tree",
);
requireEqual(
  git(c.consumer, "current-clean", ["status", "--porcelain=v1", "--untracked-files=no"]),
  "",
  "clean committed target",
);
const currentSelectionPath = exactPath(
  selection["currentSelectionPath"],
  "new current selection path",
);
if (existsSync(currentSelectionPath)) {
  throw new Error("Preserve existing selection; cold first attempt needs a fresh path.");
}
const originalPlan = object(preparation["plan"], "original actual plan");
const originalOperations = array(originalPlan["operations"], "original operations").map((v) =>
  object(v, "operation"),
);
const restoredImages = originalOperations.map((entry) => {
  const accepted = array(
    object(entry["precondition"], "original precondition")["acceptedPreimages"],
    "original source images",
  );
  if (accepted.length !== 1) {
    throw new Error("The actual original image is not unique.");
  }
  const source = object(accepted[0], "original source image");
  return {
    path: string(entry["path"], "managed path"),
    mode: source["mode"],
    bytes: Buffer.from(string(source["contentBase64"], "original image bytes"), "base64"),
  };
});
const sourceImagesPresent = (): boolean =>
  restoredImages.every((entry) => {
    try {
      return (
        bytes(join(c.consumer, entry.path)).equals(entry.bytes) &&
        image(c.consumer, entry.path).mode === entry.mode
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  });
if (sourceImagesPresent()) {
  throw new Error(
    "The selected target is already restored; no fresh inverse interruption is possible.",
  );
}
const backups = () =>
  readdirSync(c.consumer)
    .filter((name) => name.startsWith(".docs-consumer-upgrade-modules-"))
    .toSorted();
if (backups().length !== 0) {
  throw new Error("Existing installation evidence needs owner reconciliation first.");
}
const targetInstalledPath = join(
  c.consumer,
  "node_modules/@agent-teams/docs-protocol-agent-teams/package.json",
);
const targetInstalled = bytes(targetInstalledPath);
const actualTarget = parse(utf8(targetInstalled), "actual installed target adapter");
requireEqual(
  actualTarget["name"],
  "@agent-teams/docs-protocol-agent-teams",
  "actual target package identity",
);
requireEqual(
  actualTarget["version"],
  object(
    object(c.projection["packages"], "qualified packages")["docsProtocolAgentTeams"],
    "qualified adapter",
  )["version"],
  "actual target package version",
);
const { entrypointURL } = resolveInstalledPublicKernel(c.installation);
const publicKernel = object(await import(entrypointURL), "installed public kernel export");
const observeBarrier = async () =>
  object(
    await invoke(publicKernel, "inspectKnownFileTransactionBarrier", [
      { consumerRoot: c.consumer },
    ]),
    "actual public barrier observation",
  );
requireEqual((await observeBarrier())["state"], "idle", "original actual barrier state");
const pin = image(c.consumer, ".node-version");
requireEqual(pin.sha256, digest("26.12.1\n"), "same-pin target bytes");
requireEqual(pin.mode, 0o644, "same-pin target mode");
const before = inventory(c.consumer, "before");
evidence("proofs/original-preparation.json", retained.bytes);
evidence("installed-target-before.json", targetInstalled);
const args = [
  c.cli,
  "restore",
  "--consumer",
  c.consumer,
  "--from",
  c.targetCohort,
  "--to",
  sourceCohort,
  "--source-generation",
  "3",
  "--target-generation",
  "2",
  "--preparation",
  retained.path,
  "--expect",
  retained.digest,
  "--current-revision",
  currentRevision,
  "--current-tree",
  currentTree,
  "--selection",
  currentSelectionPath,
  "--json",
];
const child = spawn(c.node24, args, {
  cwd: c.consumer,
  env: observationChildEnvironment(),
  detached: true,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
});
const stdout: Buffer[] = [],
  stderr: Buffer[] = [];
let outputBytes = 0,
  overflow = false,
  exited = false,
  closed = false;
let processError: string | null = null;
for (const [stream, chunks] of [
  [child.stdout, stdout],
  [child.stderr, stderr],
] as const) {
  stream.on("data", (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > 32 * 1024 * 1024) {
      overflow = true;
    } else {
      chunks.push(Buffer.from(chunk));
    }
  });
}
child.once("error", (error) => {
  processError = error.message;
});
child.once("close", () => {
  closed = true;
});
const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
  child.once("exit", (code, signal) => {
    exited = true;
    resolve({ code, signal });
  });
  child.once("error", () => {
    exited = true;
    resolve({ code: null, signal: null });
  });
});
const pid = child.pid;
if (pid === undefined) {
  throw new Error("Actual controller did not start.");
}
const original = identity(pid);
if (!original || original.pgid !== pid || original.session !== pid) {
  throw new Error("Controller group custody was not established.");
}
requireEqual(realpathSync(`/proc/${pid}/exe`), c.node24, "actual retained controller executable");
jsonEvidence("controller-process.json", { ...original, executable: c.node24, arguments: args });
function signalOwned(signal: NodeJS.Signals): void {
  const observed = identity(pid!);
  if (
    !observed ||
    observed.start !== original!.start ||
    observed.pgid !== pid ||
    observed.session !== pid
  ) {
    throw new Error("Controller identity changed; refuse unattributed signalling.");
  }
  process.kill(-pid!, signal);
}
let interrupted = false,
  stopped = false,
  missed = false;
let fixtureError: string | null = null;
let observedDescendants: readonly ProcessIdentity[] = [];
let currentSelectionAtStop: Buffer | undefined;
let runtimeProbeAtStop: ProcessIdentity | undefined;
const probeArguments = [c.node24, c.corepack, "pnpm", "--version"];
const probeSelection = {
  controllerPid: pid,
  executable: c.node24,
  cwd: c.consumer,
  arguments: probeArguments,
};
const deadline = Date.now() + 15 * 60_000;
try {
  for (;;) {
    if (exited || Date.now() >= deadline || overflow) {
      break;
    }
    if (
      existsSync(currentSelectionPath) &&
      sourceImagesPresent() &&
      (await observeBarrier())["state"] === "idle"
    ) {
      const probe = currentRuntimeProbe(probeSelection);
      if (!probe) {
        await delay(5);
        continue;
      }
      signalOwned("SIGSTOP");
      stopped = true;
      for (
        let attempt = 0;
        attempt < 40 && (identity(pid)?.state !== "T" || identity(probe.pid)?.state !== "T");
        attempt += 1
      ) {
        await delay(25);
      }
      requireEqual(identity(pid)?.state, "T", "actually stopped controller");
      const stoppedProbe = identity(probe.pid);
      if (
        !stoppedProbe ||
        stoppedProbe.start !== probe.start ||
        stoppedProbe.state !== "T" ||
        !isRuntimeProbe(stoppedProbe, probeSelection)
      ) {
        missed = true;
        jsonEvidence("missed-runtime-probe-window.json", {
          selectedProbe: probe,
          stoppedProbe: stoppedProbe ?? null,
        });
        signalOwned("SIGCONT");
        stopped = false;
        break;
      }
      runtimeProbeAtStop = stoppedProbe;
      jsonEvidence("runtime-probe-at-stop.json", {
        ...stoppedProbe,
        executable: c.node24,
        arguments: probeArguments,
        cwd: c.consumer,
        controller: identity(pid),
        controllerArtifact: preparation["controller"],
        kernelArtifact: preparation["kernel"],
        inference:
          "The reviewed retained owner awaits this direct Corepack version probe in the restored consumer before calling installCohort. Its pre-CAS probe uses a distinct temporary root. This positive stopped process observation establishes the serial pre-install phase.",
      });
      const content = bytes(currentSelectionPath),
        current = parse(utf8(content), "actual retained current selection");
      requireEqual(
        current["protocol"],
        "agent-teams.managed-generation3-current-restoration/v1",
        "actual current selection family",
      );
      requireEqual(
        current["originalPreparationDigest"],
        retained.digest,
        "actual original binding",
      );
      requireEqual(current["sourceRevision"], currentRevision, "actual selected current HEAD");
      requireEqual(current["sourceTree"], currentTree, "actual selected current tree");
      equal(current["controller"], preparation["controller"], "retained controller build");
      equal(current["kernel"], preparation["kernel"], "retained kernel build");
      evidence("proofs/current-selection-at-stop.json", content);
      currentSelectionAtStop = content;
      const barrier = await observeBarrier();
      jsonEvidence("barrier-at-stop.json", barrier);
      observedDescendants = descendants(pid);
      jsonEvidence("processes-at-stop.json", { exhaustive: false, observed: observedDescendants });
      const installedStillTarget =
        existsSync(targetInstalledPath) && bytes(targetInstalledPath).equals(targetInstalled);
      if (
        barrier["state"] !== "idle" ||
        !sourceImagesPresent() ||
        backups().length !== 0 ||
        !installedStillTarget
      ) {
        missed = true;
        jsonEvidence("missed-window.json", {
          barrier,
          backups: backups(),
          sourceImagesPresent: sourceImagesPresent(),
          installedStillTarget,
        });
        signalOwned("SIGCONT");
        stopped = false;
        break;
      }
      // The stopped direct runtime probe positively identifies the serial phase
      // before installCohort. Backup absence alone would not establish that history.
      signalOwned("SIGKILL");
      stopped = false;
      interrupted = true;
      break;
    }
    await delay(5);
  }
} catch (error) {
  fixtureError = error instanceof Error ? error.message : String(error);
} finally {
  if (stopped && !exited) {
    signalOwned("SIGCONT");
    stopped = false;
  }
  if (!exited && !interrupted && !missed) {
    signalOwned("SIGTERM");
  }
}
const result = await Promise.race([
  exit,
  delay(Math.max(1000, deadline - Date.now()), undefined, { ref: false }).then(() => {
    if (!exited) {
      signalOwned("SIGKILL");
    }
    return exit;
  }),
]);
await delay(100);
jsonEvidence("observed-processes-after-controller.json", {
  exhaustive: false,
  remainingObserved: observedDescendants.map((prior) => ({
    prior,
    current: identity(prior.pid) ?? null,
  })),
  recoveryBoundary:
    "Controller-group death does not establish detached descendant termination; existing owners reconcile their actual evidence.",
});
const actualStdout = Buffer.concat(stdout),
  actualStderr = Buffer.concat(stderr);
evidence("actual-cli.stdout", actualStdout);
evidence("actual-cli.stderr", actualStderr);
jsonEvidence("actual-process-result.json", {
  ...result,
  processError,
  interrupted,
  missed,
  fixtureError,
  overflow,
  outputStreamsClosed: closed,
  stdoutDigest: digest(actualStdout),
  stderrDigest: digest(actualStderr),
  outputScope: closed
    ? "complete observed child streams"
    : "observed bytes before external stream capture teardown",
});
child.stdout.destroy();
child.stderr.destroy();
const after = inventory(c.consumer, "after-interruption"),
  owned = new Set(restoredImages.map((entry) => entry.path));
equal(
  after.filter((entry) => !owned.has(entry.path)),
  before.filter((entry) => !owned.has(entry.path)),
  "foreign committed images preserved",
);
equal(image(c.consumer, ".node-version"), pin, "same-pin read guard");
equal(bytes(retained.path), retained.bytes, "actual original preparation unchanged");
equal(bytes(c.selectedLock.path), c.selectedLock.bytes, "captured selected lock unchanged");
if (existsSync(currentSelectionPath)) {
  evidence("proofs/current-selection-after.json", bytes(currentSelectionPath));
}
if (
  !interrupted ||
  missed ||
  fixtureError ||
  overflow ||
  result.signal !== "SIGKILL" ||
  !currentSelectionAtStop ||
  !runtimeProbeAtStop
) {
  throw new Error(
    "The actual committed inverse-before-install window was not established; preserve evidence without manufacturing it.",
  );
}
equal(
  bytes(currentSelectionPath),
  currentSelectionAtStop,
  "actual current selection unchanged after interruption",
);
requireEqual((await observeBarrier())["state"], "idle", "actual public barrier after interruption");
requireEqual(
  backups(),
  [],
  "no installation backup present at the positively observed probe phase",
);
equal(
  bytes(targetInstalledPath),
  targetInstalled,
  "actual retained target installation before cold resume",
);
requireEqual(sourceImagesPresent(), true, "actual completed inverse images");
jsonEvidence("cold-committed-interruption-complete.json", {
  evidenceClass: "actual-external-committed-restore-interruption",
  originalPreparationDigest: retained.digest,
  currentSelectionDigest: digest(currentSelectionAtStop),
  currentRevision,
  currentTree,
  controller: original,
  result,
  inverseImagesPresent: true,
  publicBarrier: "idle",
  sourceInstallationStarted: false,
  phaseBasis: "positive stopped direct runtime-version probe before serial install call",
  runtimeProbe: runtimeProbeAtStop,
  controllerArtifact: preparation["controller"],
  receiptOwnershipClaimed: false,
  nextStep:
    "Inspect retained process evidence, then run ordinary restore-committed from a fresh process with the same actual current selection and its separately retained digest. Require a genuine already-satisfied receipt and actual source installation.",
});
