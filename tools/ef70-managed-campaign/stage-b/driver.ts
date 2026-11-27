import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  array,
  command,
  digest,
  evidence,
  jsonEvidence,
  object,
  parse,
  requireEqual,
  string,
  transport,
  utf8,
  type JsonRecord,
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
  type ManagedContext,
  type Image,
} from "./context.ts";

function captureOperationAfter(
  c: ManagedContext,
  custody: {
    completionPath: string;
    preparationPath: string;
    operation: string;
    selection: JsonRecord;
    pinBefore: Image;
  },
  exported: string[],
): void {
  const { completionPath, preparationPath, operation, selection, pinBefore } = custody;
  inventory(c.consumer, "after");
  for (const [label, path] of [
    ["preparation", preparationPath],
    ["completion", completionPath],
    ["receipt-companion", `${completionPath}.receipt`],
    ...(operation === "restore-committed"
      ? [
          [
            "current-selection",
            exactPath(selection["currentSelectionPath"], "current rollback selection"),
          ],
        ]
      : []),
  ] as const) {
    if (!existsSync(path)) {
      continue;
    }
    const retained = bytes(path);
    evidence(`proofs/${label}.json`, retained);
    exported.push(`proofs/${label}.json`);
  }
  const paths = utf8(
    command(
      "changed-files",
      "/usr/bin/git",
      ["diff", "--name-only", "-z", sourceRevision, "--"],
      c.consumer,
    ).stdout,
  )
    .split("\0")
    .filter(Boolean);
  const manifests = [];
  for (const path of paths.toSorted()) {
    const observed = image(c.consumer, path);
    if (observed.kind !== "file") {
      throw new Error("Managed campaign export requires actual regular-file outputs.");
    }
    const output = `consumer-files/${path}`;
    evidence(output, readFileSync(join(c.consumer, path)));
    exported.push(output);
    manifests.push({
      ...observed,
      bytes: lstatSync(join(c.consumer, path)).size,
      gitMode:
        observed.mode === 0o644 ? "100644" : observed.mode === 0o755 ? "100755" : "unsupported",
    });
  }
  jsonEvidence("consumer-output-manifest.json", manifests);
  exported.push("consumer-output-manifest.json");
  requireEqual(digest(bytes(c.cli)), c.cliDigest, "retained CLI unchanged");
  equal(
    bytes(join(c.controllerRoot, "package.json")),
    c.controllerManifest,
    "retained manifest unchanged",
  );
  equal(bytes(c.installLockPath), c.installLockBytes, "retained installation lock unchanged");
  equal(bytes(c.selectedLock.path), c.selectedLock.bytes, "same captured target-lock bytes");
  equal(image(c.consumer, ".node-version"), pinBefore, "same-pin mode and bytes read guard");
}

const inputPath = process.argv[2];
if (!inputPath || process.argv.length !== 3) {
  throw new Error("Select one reviewed Stage B operation JSON.");
}
const inputBytes = bytes(inputPath, 1024 * 1024);
const selection = parse(utf8(inputBytes), "Stage B operation selection");
evidence("selection.json", inputBytes);
const operation = string(selection["operation"], "public operation");
if (!["prepare", "finalize", "restore", "restore-committed", "check-target"].includes(operation)) {
  throw new Error(
    "Unknown public operation; recovery and fault injection require separate explicit fixtures.",
  );
}
const c = await context(selection);
const completionPath = exactPath(selection["completionPath"], "retained completion path");
const preparationPath = `${completionPath}.prepared`;
let preparation: JsonRecord | undefined;
let preparationDigest: string | undefined;
if (operation !== "prepare") {
  const retained = selectedBytes(selection["preparation"], "separately selected preparation");
  requireEqual(retained.path, preparationPath, "retained preparation path");
  preparationDigest = retained.digest;
  preparation = parse(utf8(retained.bytes), "retained actual preparation");
  evidence("proofs/preparation-before.json", retained.bytes);
  requireEqual(
    preparation["protocol"],
    "agent-teams.managed-generation3-preparation/v1",
    "actual preparation family",
  );
  requireEqual(preparation["sourceRevision"], sourceRevision, "original source custody");
  requireEqual(preparation["initialProofPath"], completionPath, "selected completion path");
  equal(preparation["targetCohort"], c.targetBinding, "actual qualified target binding");
}
const pinBefore = image(c.consumer, ".node-version");
requireEqual(
  utf8(readFileSync(join(c.consumer, ".node-version"))),
  "26.12.1\n",
  "original same-pin bytes",
);
requireEqual(pinBefore.kind, "file", "original pin kind");
requireEqual(pinBefore.mode, 0o644, "original pin mode");
const head = git(c.consumer, "consumer-head", ["rev-parse", "HEAD"]);
if (operation === "restore-committed") {
  requireEqual(head, selection["currentRevision"], "selected current target revision");
  requireEqual(
    git(c.consumer, "consumer-tree", ["rev-parse", "HEAD^{tree}"]),
    selection["currentTree"],
    "selected current target tree",
  );
} else {
  requireEqual(head, sourceRevision, "original source HEAD");
}
if (operation === "prepare") {
  requireEqual(
    git(c.consumer, "source-clean", ["status", "--porcelain=v1", "--untracked-files=no"]),
    "",
    "clean original source",
  );
  for (const path of [completionPath, preparationPath, `${completionPath}.receipt`]) {
    if (existsSync(path)) {
      throw new Error("Preparation requires fresh external proof paths.");
    }
  }
}
const before = inventory(c.consumer, "before");
const completionBefore = existsSync(completionPath) ? bytes(completionPath) : undefined;
const base = ["--consumer", c.consumer, "--json"];
let args: string[],
  executable = c.node24,
  cli = c.cli;
if (operation === "prepare") {
  args = [
    "upgrade",
    ...base,
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
    completionPath,
    "--target-lockfile",
    c.selectedLock.path,
    "--target-lockfile-sha256",
    c.selectedLock.digest,
  ];
} else if (operation === "finalize") {
  args = [
    "finalize",
    ...base,
    "--from",
    sourceCohort,
    "--to",
    c.targetCohort,
    "--source-generation",
    "2",
    "--target-generation",
    "3",
    "--preparation",
    preparationPath,
    "--expect",
    preparationDigest!,
    "--proof",
    completionPath,
  ];
} else if (operation === "check-target") {
  executable = c.node26;
  cli = join(c.consumer, "node_modules/@agent-teams/docs-protocol-agent-teams/dist/cli.js");
  const manifest = parse(
    readFileSync(
      join(c.consumer, "node_modules/@agent-teams/docs-protocol-agent-teams/package.json"),
      "utf8",
    ),
    "installed target adapter",
  );
  requireEqual(
    manifest["version"],
    object(
      object(c.projection["packages"], "qualified packages")["docsProtocolAgentTeams"],
      "qualified adapter",
    )["version"],
    "installed target adapter version",
  );
  args = ["check", ...base];
} else {
  args = [
    "restore",
    ...base,
    "--from",
    c.targetCohort,
    "--to",
    sourceCohort,
    "--source-generation",
    "3",
    "--target-generation",
    "2",
    "--preparation",
    preparationPath,
    "--expect",
    preparationDigest!,
  ];
  if (operation === "restore-committed") {
    args.push(
      "--current-revision",
      string(selection["currentRevision"], "current revision"),
      "--current-tree",
      string(selection["currentTree"], "current tree"),
      "--selection",
      exactPath(selection["currentSelectionPath"], "current rollback selection"),
    );
    if (selection["currentSelectionDigest"] !== undefined) {
      args.push(
        "--selection-expect",
        string(selection["currentSelectionDigest"], "separately selected current digest"),
      );
    }
  }
}

const exported = ["selection.json", "candidate-input.json", "qualified-projection.json"];
let result: JsonRecord | undefined,
  status: number | null = null;
const failures: unknown[] = [];
try {
  const observed = command(`public-${operation}`, executable, [cli, ...args], c.consumer, {
    environment: process.env,
    accepted: [0, 1, 2, 3],
  });
  status = observed.status;
  evidence("actual-cli.stdout", observed.stdout);
  evidence("actual-cli.stderr", observed.stderr);
  result = parse(utf8(observed.stdout), "actual bounded public CLI envelope");
} catch (error) {
  failures.push(error);
}
try {
  captureOperationAfter(
    c,
    { completionPath, preparationPath, operation, selection, pinBefore },
    exported,
  );
} catch (error) {
  failures.push(error);
}
if (failures.length > 0) {
  throw new AggregateError(
    failures,
    "Actual operation or after-capture failed; preserve both failures and all observed evidence.",
  );
}
requireEqual(status, 0, "actual positive operation exit");
if (!result) {
  throw new Error("The actual CLI produced no parsed envelope.");
}
requireEqual(result["schemaVersion"], 1, "public envelope schema");
requireEqual(result["issues"], [], "positive operation issues");
const expected =
  operation === "prepare"
    ? "prepared"
    : operation === "finalize"
      ? "upgraded"
      : operation === "check-target"
        ? "current"
        : "restored";
requireEqual(result["outcome"], expected, "actual positive operation outcome");
requireEqual(
  result["command"],
  operation === "prepare"
    ? "consumer.upgrade"
    : operation === "check-target"
      ? "consumer.check"
      : operation === "restore-committed"
        ? "consumer.restore"
        : `consumer.${operation}`,
  "actual public command",
);
if (operation === "prepare") {
  const selected = object(result["preparation"], "actual preparation result");
  requireEqual(selected["path"], preparationPath, "actual preparation destination");
  const content = bytes(preparationPath);
  requireEqual(digest(content), selected["digest"], "actual preparation digest");
  preparation = parse(utf8(content), "actual preparation");
  equal(preparation["targetCohort"], c.targetBinding, "qualified preparation target");
  requireEqual(preparation["sourceRevision"], sourceRevision, "prepared original source");
  equal(inventory(c.consumer, "confirmed"), before, "write-free consumer preparation");
  if (existsSync(completionPath)) {
    throw new Error("Preparation unexpectedly emitted completion.");
  }
} else if (operation !== "check-target") {
  const receipt = object(result["receipt"], "actual RM receipt");
  requireEqual(
    receipt["protocol"],
    "agent-teams.repository-mutation.known-file/v1",
    "actual RM protocol",
  );
  const expectedReceipt = selection["expectedReceiptOutcome"];
  if (expectedReceipt !== "applied" && expectedReceipt !== "already-satisfied") {
    throw new Error("Select the actual expected receipt ownership class.");
  }
  requireEqual(receipt["outcome"], expectedReceipt, "honest receipt ownership");
  const receipts = array(receipt["operations"], "actual receipt operations").map((value) =>
    object(value, "receipt operation"),
  );
  for (const item of receipts) {
    requireEqual(
      item["outcome"],
      expectedReceipt === "applied" ? "replaced" : "already-satisfied",
      "honest per-file write ownership",
    );
  }
}
if (!preparation) {
  throw new Error("No actual retained preparation was observed.");
}
const plan = object(preparation["plan"], "actual managed plan");
const operations = array(plan["operations"], "actual managed operations").map((value) =>
  object(value, "managed operation"),
);
if (operations.some((value) => value["path"] === ".node-version")) {
  throw new Error("Same-pin transition must remain a read guard.");
}
const allowed = new Set(operations.map((value) => string(value["path"], "managed operation path")));
const after = inventory(c.consumer, "confirmed-final");
equal(
  after.filter((value) => !allowed.has(value.path)),
  before.filter((value) => !allowed.has(value.path)),
  "foreign tracked images preserved",
);
if (operation === "finalize" || operation === "check-target") {
  for (const entry of operations) {
    const postimage = object(entry["postimage"], "actual planned target image");
    const path = string(entry["path"], "planned path");
    equal(
      bytes(join(c.consumer, path)),
      Buffer.from(string(postimage["contentBase64"], "target image bytes"), "base64"),
      "actual target bytes",
    );
    requireEqual(image(c.consumer, path).mode, postimage["mode"], "actual target mode");
  }
  const completion = bytes(completionPath);
  const value = parse(utf8(completion), "actual completion");
  requireEqual(
    value["protocol"],
    "agent-teams.managed-generation3-completion/v1",
    "actual completion protocol",
  );
  requireEqual(value["preparationDigest"], preparationDigest, "actual completion selection");
  requireEqual(value["activation"], "verified-current-v3", "actual completion activation");
  if (completionBefore) {
    equal(completion, completionBefore, "retained completion immutable across cold invocation");
  }
} else if (operation !== "prepare") {
  for (const entry of operations) {
    const precondition = object(entry["precondition"], "actual source precondition");
    const accepted = array(precondition["acceptedPreimages"], "actual source images");
    if (accepted.length !== 1) {
      throw new Error("Original source image is not unique.");
    }
    const original = object(accepted[0], "original source image");
    const path = string(entry["path"], "source path");
    equal(
      bytes(join(c.consumer, path)),
      Buffer.from(string(original["contentBase64"], "original source bytes"), "base64"),
      "exact original source restoration",
    );
    requireEqual(image(c.consumer, path).mode, original["mode"], "exact original source mode");
  }
  const manifest = parse(
    readFileSync(join(c.consumer, "package.json"), "utf8"),
    "restored manifest",
  );
  requireEqual(manifest["packageManager"], "pnpm@11.18.0", "actual restored source manager");
}
jsonEvidence("operation-complete.json", {
  evidenceClass: "actual-published-controller-operation",
  operation,
  status,
  outcome: result["outcome"],
  authorityRevision: c.authorityRevision,
  sourceRevision,
  targetCohort: c.targetCohort,
  managedOutputCount: operations.length,
  receipt: result["receipt"] ?? null,
  preparation: result["preparation"] ?? null,
  restoration: result["restoration"] ?? null,
  sourcePin: pinBefore,
  qualificationClaim:
    "No hosted consumer qualification or CANARY is established by this local operation.",
});
exported.push("operation-complete.json");
transport(exported);
