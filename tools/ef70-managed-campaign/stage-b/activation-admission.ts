import { assertOwnedCasePath, observationChildEnvironment } from "../owned-root.ts";
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  array,
  command,
  digest,
  evidence,
  jsonEvidence,
  object,
  outputRoot,
  parse,
  requireEnvironment,
  requireEqual,
  string,
  utf8,
  type JsonRecord,
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
  sourceRevision,
} from "./context.ts";
import {
  absent,
  backupNames,
  external,
  fileState,
  identity,
  installedState,
  processTable,
  treeState,
} from "./activation-observation.ts";

type ActivationContext = Awaited<ReturnType<typeof context>>;

function readColdSelection(selection: JsonRecord, c: ActivationContext) {
  const retained = selectedBytes(selection["preparation"], "actual cold preparation");
  const preparation = parse(utf8(retained.bytes), "actual cold preparation");
  requireEqual(
    preparation["protocol"],
    "agent-teams.managed-generation3-preparation/v1",
    "preparation family",
  );
  requireEqual(preparation["sourceRevision"], sourceRevision, "original source revision");
  requireEqual(
    object(preparation["consumer"], "prepared consumer")["root"],
    c.consumer,
    "same original consumer root",
  );
  equal(preparation["targetCohort"], c.targetBinding, "actual qualified target binding");
  const completionPath = exactPath(selection["completionPath"], "selected completion path");
  external(completionPath, [c.consumer, c.installation]);
  requireEqual(preparation["initialProofPath"], completionPath, "completion selection");
  requireEqual(retained.path, `${completionPath}.prepared`, "preparation namespace");
  const companionPath = `${completionPath}.receipt`;
  const cold = selectedBytes(
    selection["coldInterruption"],
    "actual interruption completion record",
  );
  const coldReceipt = selectedBytes(selection["coldReceipt"], "actual receipt captured at stop");
  const coldProcesses = selectedBytes(
    selection["coldProcesses"],
    "actual processes captured at stop",
  );
  for (const selected of [cold, coldReceipt, coldProcesses]) {
    external(selected.path, [c.consumer, c.installation]);
  }
  const coldValue = parse(utf8(cold.bytes), "actual completed cold fixture");
  requireEqual(
    coldValue["evidenceClass"],
    "actual-external-controller-interruption",
    "actual cold evidence class",
  );
  requireEqual(coldValue["preparationDigest"], retained.digest, "same interrupted preparation");
  requireEqual(coldValue["completionAbsent"], true, "actual prior incomplete state");
  requireEqual(
    object(coldValue["result"], "actual cold process result")["signal"],
    "SIGKILL",
    "actual prior external interruption",
  );
  const companionBytes = bytes(companionPath);
  equal(companionBytes, coldReceipt.bytes, "original authentic receipt companion remains exact");
  const companion = parse(utf8(companionBytes), "actual original companion");
  requireEqual(companion["preparationDigest"], retained.digest, "original companion preparation");
  const receipt = object(companion["receipt"], "actual historical receipt");
  const plan = object(preparation["plan"], "actual selected plan");
  const operations = array(plan["operations"], "actual operations").map((value) =>
    object(value, "actual operation"),
  );
  if (operations.length === 0 || operations.some((entry) => entry["path"] === ".node-version")) {
    throw new Error("Select a nonempty same-pin managed plan.");
  }
  requireEqual(receipt["schemaVersion"], 1, "historical receipt schema");
  requireEqual(
    receipt["protocol"],
    "agent-teams.repository-mutation.known-file/v1",
    "historical receipt protocol",
  );
  requireEqual(receipt["planDigest"], plan["planDigest"], "historical receipt plan");
  requireEqual(receipt["outcome"], "applied", "genuine original write ownership");
  const receiptOperations = array(receipt["operations"], "historical receipt operations").map(
    (value) => object(value, "receipt operation"),
  );
  requireEqual(receiptOperations.length, operations.length, "complete historical operation list");
  for (const [index, entry] of operations.entries()) {
    requireEqual(receiptOperations[index]!["path"], entry["path"], "historical receipt path");
    requireEqual(
      receiptOperations[index]!["outcome"],
      "replaced",
      "genuine original per-file ownership",
    );
    requireEqual(
      receiptOperations[index]!["resultDigest"],
      object(entry["postimage"], "postimage")["digest"],
      "historical receipt postimage",
    );
  }
  return {
    retained,
    preparation,
    completionPath,
    companionPath,
    cold,
    coldReceipt,
    coldProcesses,
    coldValue,
    companionBytes,
    receipt,
    plan,
    operations,
  };
}

function assertTargetImages(c: ActivationContext, operations: readonly JsonRecord[]): void {
  for (const entry of operations) {
    const path = string(entry["path"], "managed path"),
      post = object(entry["postimage"], "target image");
    const observed = image(c.consumer, path);
    equal(
      bytes(join(c.consumer, path)),
      Buffer.from(string(post["contentBase64"], "target bytes"), "base64"),
      "actual target bytes",
    );
    requireEqual(observed.mode, post["mode"], "actual target mode");
  }
}

function sourceState(c: ActivationContext, data: ReturnType<typeof readColdSelection>) {
  const { preparation, operations } = data;
  const headBefore = git(c.consumer, "failure-head", ["rev-parse", "HEAD"]);
  requireEqual(headBefore, sourceRevision, "original uncommitted cold source HEAD");
  const treeBefore = git(c.consumer, "failure-tree", ["rev-parse", "HEAD^{tree}"]);
  requireEqual(treeBefore, preparation["sourceTree"], "original source tree");
  const pinBefore = image(c.consumer, ".node-version");
  requireEqual(pinBefore.sha256, digest("26.12.1\n"), "same-pin bytes");
  requireEqual(pinBefore.mode, 0o644, "same-pin mode");
  requireEqual(
    parse(utf8(bytes(join(c.consumer, "package.json"))), "actual target manifest")[
      "packageManager"
    ],
    "pnpm@11.20.0",
    "actual target manager pin",
  );
  assertTargetImages(c, operations);
  return { headBefore, treeBefore, pinBefore };
}

async function admitArtifacts(c: ActivationContext, data: ReturnType<typeof readColdSelection>) {
  const { preparation, receipt, plan } = data;
  const publicRequire = createRequire(join(c.installation, "package.json"));
  const kernelRoot = dirname(
    publicRequire.resolve("@agent-teams/repository-mutation/package.json"),
  );
  const kernel = object(
    await import(pathToFileURL(publicRequire.resolve("@agent-teams/repository-mutation")).href),
    "public kernel",
  );
  await invoke(kernel, "assertKnownFileTransactionPlan", [plan]);
  const { receiptDigest, ...receiptBody } = receipt;
  requireEqual(
    await invoke(kernel, "sha256Json", [
      { domain: "agent-teams.repository-mutation.known-file-receipt/v1", body: receiptBody },
    ]),
    receiptDigest,
    "actual historical receipt digest",
  );
  const barrier = async () =>
    object(
      await invoke(kernel, "inspectKnownFileTransactionBarrier", [{ consumerRoot: c.consumer }]),
      "public barrier",
    );
  const build = (packageRoot: string, roots: readonly string[]) =>
    invoke(kernel, "computeInstalledArtifactBuildIdentity", [{ packageRoot, roots }]);
  const controllerBuild = await build(c.controllerRoot, ["dist", "assets", "schemas"]),
    kernelBuild = await build(kernelRoot, ["dist", "schemas"]);
  requireEqual(
    controllerBuild,
    object(preparation["controller"], "retained controller")["buildIdentity"],
    "same controller build",
  );
  requireEqual(
    kernelBuild,
    object(preparation["kernel"], "retained kernel")["buildIdentity"],
    "same kernel build",
  );
  requireEqual((await barrier())["state"], "idle", "reconciled actual RM barrier");
  return { kernelRoot, barrier, build, controllerBuild, kernelBuild, receiptDigest };
}

function assertPriorProcesses(
  c: ActivationContext,
  data: ReturnType<typeof readColdSelection>,
): void {
  const { coldProcesses, coldValue } = data;
  const priorProcesses = array(
    parse(utf8(coldProcesses.bytes), "actual cold processes")["observed"],
    "observed cold descendants",
  ).map((value) => object(value, "observed cold process"));
  const coldOwner = object(coldValue["controller"], "actual cold controller");
  if (
    !priorProcesses.some(
      (value) => value["pid"] === coldOwner["pid"] && value["start"] === coldOwner["start"],
    )
  ) {
    throw new Error("Cold process capture does not bind its actual owner.");
  }
  const priorRecheck = priorProcesses.map((prior) => {
    const pid = prior["pid"];
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1) {
      throw new Error("Invalid actual prior PID.");
    }
    const current = identity(pid) ?? null;
    if (current?.start === prior["start"]) {
      throw new Error("An observed prior process remains; owner reconciliation is required.");
    }
    return { prior, current };
  });
  const effectiveUID = process.geteuid?.();
  if (typeof effectiveUID !== "number") {
    throw new Error("A real Linux effective UID is required.");
  }
  const freshCwdCensus: JsonRecord[] = [];
  let foreignUIDCount = 0;
  for (const entry of processTable()) {
    try {
      const status = readFileSync("/proc/" + entry.pid + "/status", "utf8");
      const uid = /^Uid:\s+[0-9]+\s+([0-9]+)\s+[0-9]+\s+[0-9]+\s*$/mu.exec(status);
      if (!uid) {
        throw new Error("Process effective UID could not be observed.");
      }
      if (Number(uid[1]) !== effectiveUID) {
        foreignUIDCount += 1;
        continue;
      }
      const cwd = realpathSync("/proc/" + entry.pid + "/cwd");
      if (identity(entry.pid)?.start !== entry.start) {
        continue;
      }
      if (cwd === c.consumer || cwd.startsWith(c.consumer + sep)) {
        throw new Error(
          "A process still uses this disposable consumer; reconcile it before the case.",
        );
      }
      freshCwdCensus.push({ pid: entry.pid, start: entry.start, effectiveUID, cwd });
    } catch (error) {
      if (!absent(error)) {
        throw error;
      }
    }
  }
  jsonEvidence("prior-process-recheck.json", {
    exhaustive: false,
    priorRecheck,
    freshCwdCensus,
    effectiveUID,
    foreignUIDCount,
    boundary:
      "Previously attributed identities are checked without an access-error exception. The additional fresh cwd census is limited to this effective UID; no whole-host or detached-tree termination claim.",
  });
}

export async function admitActivationFailure(inputPath: string) {
  const input = bytes(inputPath, 1024 * 1024),
    selection = parse(utf8(input), "activation-failure selection");
  requireEqual(
    selection["operation"],
    "activation-failure",
    "separate incomplete-operation collector",
  );
  evidence("selection.json", input);
  const c = await context(selection);
  assertOwnedCasePath(c.consumer);
  external(realpathSync(outputRoot), [c.consumer, c.installation]);
  const data = readColdSelection(selection, c);
  const source = sourceState(c, data);
  const artifacts = await admitArtifacts(c, data);
  requireEqual(
    backupNames(c.consumer),
    [],
    "prior installation backups require owner reconciliation first",
  );
  assertPriorProcesses(c, data);
  const { retained, completionPath, companionBytes, cold, coldReceipt, coldProcesses } = data;
  const before = inventory(c.consumer, "before");
  const completionBefore = fileState(completionPath, "proofs/completion-before.bin");
  requireEqual(completionBefore["kind"], "absent", "genuine absent completion");
  evidence("proofs/preparation-before.json", retained.bytes);
  evidence("proofs/original-companion-before.json", companionBytes);
  evidence("cold/interruption.json", cold.bytes);
  evidence("cold/receipt-at-stop.json", coldReceipt.bytes);
  evidence("cold/processes-at-stop.json", coldProcesses.bytes);
  jsonEvidence(
    "before-local-evidence.json",
    treeState(join(c.consumer, ".agent-teams-local"), "before-local", true),
  );
  const installedBefore = installedState(c.consumer, "before");
  requireEqual(
    object(installedBefore["modules"], "prior module root")["kind"],
    "directory",
    "reconciled real prior installation",
  );
  jsonEvidence("installation-before.json", installedBefore);
  return {
    c,
    selection,
    ...data,
    ...source,
    ...artifacts,
    before,
    installedBefore,
    assertTargetImages: () => assertTargetImages(c, data.operations),
    backupNames: () => backupNames(c.consumer),
    installedState: (phase: string) => installedState(c.consumer, phase),
  };
}

export function prepareActivationStore(c: ActivationContext, selection: JsonRecord) {
  const warmStore = realpathSync(requireEnvironment("pnpm_config_store_dir"));
  const corepackHome = realpathSync(requireEnvironment("COREPACK_HOME"));
  const emptyStore = exactPath(selection["emptyStoreRoot"], "fresh case-owned empty store");
  assertOwnedCasePath(emptyStore, "-empty-store", false);
  requireEqual(realpathSync(dirname(emptyStore)), dirname(emptyStore), "canonical store parent");
  external(emptyStore, [c.consumer, c.installation, warmStore, corepackHome]);
  external(warmStore, [emptyStore]);
  external(corepackHome, [emptyStore]);
  mkdirSync(emptyStore, { recursive: false, mode: 0o700 });
  const emptyIdentity = lstatSync(emptyStore);
  const childEnvironment: NodeJS.ProcessEnv = {
    ...observationChildEnvironment(),
    pnpm_config_store_dir: emptyStore,
    COREPACK_ENABLE_NETWORK: "0",
  };
  requireEqual(
    utf8(
      command(
        "empty-store-manager-preflight",
        c.node26,
        [c.corepack, "pnpm", "--version"],
        c.consumer,
        { environment: childEnvironment },
      ).stdout,
    ).trim(),
    "11.20.0",
    "actual cached target manager",
  );
  requireEqual(
    utf8(
      command(
        "empty-store-path-preflight",
        c.node26,
        [c.corepack, "pnpm", "store", "path"],
        c.consumer,
        { environment: childEnvironment },
      ).stdout,
    ).trim(),
    `${emptyStore}/v11`,
    "actual selected empty store",
  );
  const storeBefore = treeState(emptyStore, "store-before", false);
  if (storeBefore.some((entry) => entry["kind"] !== "directory")) {
    throw new Error("The separately selected store contains content before activation.");
  }
  jsonEvidence("store-before.json", {
    root: emptyStore,
    dev: emptyIdentity.dev,
    ino: emptyIdentity.ino,
    entries: storeBefore,
    warmStorePreserved: warmStore,
    corepackHome,
    environmentDelta: { pnpm_config_store_dir: emptyStore, COREPACK_ENABLE_NETWORK: "0" },
  });
  return { warmStore, corepackHome, emptyStore, emptyIdentity, childEnvironment };
}
