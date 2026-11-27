import {
  identity,
  descendants as observedDescendants,
  type ProcessIdentity,
} from "./cold-process-observation.ts";
import { spawn } from "node:child_process";
import { observationChildEnvironment } from "../owned-root.ts";
import { existsSync, realpathSync } from "node:fs";
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
} from "../stage-a/io.ts";
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

// An external fault fixture only. It never imports a private controller module,
// supplies mock ports, rewrites evidence, or changes a production child environment.

const inputPath = process.argv[2];
if (!inputPath || process.argv.length !== 3) {
  throw new Error("Select one reviewed cold-interruption fixture JSON.");
}
const inputBytes = bytes(inputPath, 1024 * 1024),
  selection = parse(utf8(inputBytes), "cold fixture selection");
requireEqual(selection["operation"], "cold-interrupt-finalize", "separate fault fixture");
evidence("selection.json", inputBytes);
const c = await context(selection);
requireEqual(
  git(c.consumer, "cold-source-head", ["rev-parse", "HEAD"]),
  sourceRevision,
  "original cold source HEAD",
);
const retained = selectedBytes(selection["preparation"], "actual preparation selection");
const preparation = parse(utf8(retained.bytes), "actual preparation");
equal(preparation["targetCohort"], c.targetBinding, "actual qualified cold target");
requireEqual(preparation["sourceRevision"], sourceRevision, "cold source custody");
const completionPath = exactPath(selection["completionPath"], "completion path");
requireEqual(preparation["initialProofPath"], completionPath, "actual completion selection");
requireEqual(retained.path, `${completionPath}.prepared`, "actual preparation path");
const companionPath = `${completionPath}.receipt`;
if (existsSync(companionPath) || existsSync(completionPath)) {
  throw new Error("Cold fault requires a new first finalize attempt; preserve prior proofs.");
}
const plan = object(preparation["plan"], "actual plan");
const operations = array(plan["operations"], "actual plan operations").map((value) =>
  object(value, "operation"),
);
const originalPin = image(c.consumer, ".node-version");
requireEqual(originalPin.sha256, digest("26.12.1\n"), "actual same-pin source bytes");
requireEqual(originalPin.mode, 0o644, "actual same-pin source mode");
const before = inventory(c.consumer, "before");
evidence("proofs/preparation.json", retained.bytes);
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
  throw new Error("Controller process-group custody was not established.");
}
requireEqual(realpathSync(`/proc/${pid}/exe`), c.node24, "actual cold controller executable");
jsonEvidence("controller-process.json", { ...original, executable: c.node24, arguments: args });
function signalOwned(signal: NodeJS.Signals): void {
  const current = identity(pid!);
  if (
    !current ||
    current.start !== original!.start ||
    current.pgid !== pid ||
    current.session !== pid
  ) {
    throw new Error("Controller identity changed; refuse unattributed process-group signalling.");
  }
  process.kill(-pid!, signal);
}
let interrupted = false,
  stopped = false,
  missed = false;
let observed: readonly ProcessIdentity[] = [];
let fixtureError: string | null = null;
let receiptAtStop: Buffer | undefined;
const deadline = Date.now() + 15 * 60_000;
function receiptReady(path: string): boolean {
  try {
    parse(utf8(bytes(path)), "receipt readiness observation");
    return true;
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    return false;
  }
}

try {
  for (;;) {
    if (exited || Date.now() >= deadline || overflow) {
      break;
    }
    if (existsSync(companionPath)) {
      // The producer may have created its exclusive file before finishing the
      // write. Observe complete JSON first; then stop and re-read actual bytes.
      if (!receiptReady(companionPath)) {
        await delay(5);
        continue;
      }
      signalOwned("SIGSTOP");
      stopped = true;
      for (let attempt = 0; attempt < 40 && identity(pid)?.state !== "T"; attempt += 1) {
        await delay(25);
      }
      requireEqual(identity(pid)?.state, "T", "actual stopped controller");
      const companion = bytes(companionPath);
      const value = parse(utf8(companion), "actual retained receipt companion");
      requireEqual(
        value["preparationDigest"],
        retained.digest,
        "actual retained receipt selection",
      );
      const receipt = object(value["receipt"], "actual published receipt");
      requireEqual(receipt["planDigest"], plan["planDigest"], "actual published plan");
      requireEqual(receipt["outcome"], "applied", "actual fresh write ownership");
      for (const item of array(receipt["operations"], "actual receipt operations")) {
        requireEqual(
          object(item, "receipt operation")["outcome"],
          "replaced",
          "actual fresh per-file ownership",
        );
      }
      evidence("proofs/receipt-at-stop.json", companion);
      receiptAtStop = companion;
      observed = observedDescendants(pid);
      jsonEvidence("processes-at-stop.json", {
        observationClass: "instantaneous-observed-descendants",
        exhaustive: false,
        observed,
      });
      if (existsSync(completionPath)) {
        missed = true;
        evidence("proofs/completion-window-missed.json", bytes(completionPath));
        signalOwned("SIGCONT");
        stopped = false;
        break;
      }
      for (const item of operations) {
        const target = object(item["postimage"], "target postimage");
        const path = string(item["path"], "target path");
        equal(
          bytes(join(c.consumer, path)),
          Buffer.from(string(target["contentBase64"], "target bytes"), "base64"),
          "actual published target bytes before interruption",
        );
        requireEqual(image(c.consumer, path).mode, target["mode"], "actual published target mode");
      }
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
// Detached production children can own different groups. Do not infer their death
// from this controller-group result; preserve their actual identities for the owner.
await delay(100);
const remainingObserved = observed.map((prior) => ({
  prior,
  current: identity(prior.pid) ?? null,
}));
jsonEvidence("observed-processes-after-controller.json", {
  exhaustive: false,
  remainingObserved,
  recoveryBoundary:
    "Existing runtime/recovery owners must reconcile any retained child/attempt evidence before resume; this fixture does not claim whole-tree termination.",
});
const capturedStdout = Buffer.concat(stdout),
  capturedStderr = Buffer.concat(stderr);
evidence("actual-cli.stdout", capturedStdout);
evidence("actual-cli.stderr", capturedStderr);
jsonEvidence("actual-process-result.json", {
  ...result,
  processError,
  interrupted,
  missed,
  fixtureError,
  overflow,
  outputStreamsClosed: closed,
  stdoutDigest: digest(capturedStdout),
  stderrDigest: digest(capturedStderr),
  outputScope: closed
    ? "complete observed child streams"
    : "bytes observed before external capture teardown; descendant-held streams may remain",
});
child.stdout.destroy();
child.stderr.destroy();
const after = inventory(c.consumer, "after-interruption");
const ownedPaths = new Set(operations.map((entry) => string(entry["path"], "managed path")));
equal(
  after.filter((entry) => !ownedPaths.has(entry.path)),
  before.filter((entry) => !ownedPaths.has(entry.path)),
  "foreign images preserved across interruption",
);
equal(bytes(retained.path), retained.bytes, "selected preparation unchanged");
equal(bytes(c.selectedLock.path), c.selectedLock.bytes, "selected target-lock unchanged");
equal(image(c.consumer, ".node-version"), originalPin, "same-pin read guard preserved");
if (existsSync(companionPath)) {
  const companionAfter = bytes(companionPath);
  evidence("proofs/receipt-after.json", companionAfter);
  if (interrupted && receiptAtStop) {
    equal(companionAfter, receiptAtStop, "actual receipt companion remains exact");
  }
}
if (existsSync(completionPath)) {
  evidence("proofs/completion-after.json", bytes(completionPath));
}
if (
  !interrupted ||
  missed ||
  fixtureError ||
  overflow ||
  result.signal !== "SIGKILL" ||
  existsSync(completionPath)
) {
  throw new Error(
    "The attempted cold fixture did not establish the selected actual interruption window; preserve all evidence and do not manufacture it.",
  );
}
jsonEvidence("cold-interruption-complete.json", {
  evidenceClass: "actual-external-controller-interruption",
  preparationDigest: retained.digest,
  controller: original,
  result,
  completionAbsent: true,
  nextStep:
    "Inspect retained process/installation evidence; then use ordinary driver finalize in a fresh process/evidence namespace with the same preparation and expected already-satisfied receipt. No automatic retry is performed.",
});
