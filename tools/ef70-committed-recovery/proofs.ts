import assert from "node:assert/strict";
import { join } from "node:path";
import { row, type Row } from "../ef70-managed-campaign/campaign-io.ts";
import { sourceCohort } from "../ef70-managed-adoption/configuration.ts";
import { invoke, resultEnvelope } from "../ef70-managed-adoption/evidence.ts";
import {
  bytes,
  list,
  regularImage,
  relativePath,
  retainAt,
  sha256,
  text,
} from "../ef70-managed-adoption/files.ts";
import {
  assertReceipt,
  type ExpectedImage,
  type PlanOperation,
  type Preparation,
  type ProofContext,
} from "../ef70-managed-adoption/proofs.ts";
import type { SourceAdmission } from "../ef70-managed-adoption/admission.ts";
import type { ArtifactSelection } from "./configuration.ts";
import { originalFile, originalJson, type OriginalArchive } from "./artifact-intake.ts";

function keys(value: Row, expected: readonly string[]): void {
  assert.deepEqual(Object.keys(value).toSorted(), [...expected].toSorted());
}
function image(value: unknown): ExpectedImage {
  const actual = row(value, "Exact known file");
  keys(actual, ["contentBase64", "digest", "mode", "size"]);
  const encoded = text(actual["contentBase64"], "Image base64"),
    content = Buffer.from(encoded, "base64");
  assert.equal(content.toString("base64"), encoded);
  assert(content.length > 0 && content.length <= 8 * 1024 * 1024);
  assert.equal(content.length, actual["size"]);
  assert.equal("sha256:" + sha256(content), actual["digest"]);
  assert(actual["mode"] === 0o644 || actual["mode"] === 0o755);
  return { content, digest: text(actual["digest"], "Image digest"), mode: actual["mode"] };
}
function operations(context: ProofContext, value: Row): PlanOperation[] {
  const plan = row(value["plan"], "Actual original plan");
  invoke(context.kernel, "assertKnownFileTransactionPlan", [plan]);
  const result = list(plan["operations"], "Actual operations").map((entry) => {
    const operation = row(entry, "Operation"),
      condition = row(operation["precondition"], "Condition");
    assert.equal(condition["state"], "known-file");
    const originals = list(condition["acceptedPreimages"], "Accepted preimages");
    assert.equal(originals.length, 1);
    return {
      path: relativePath(operation["path"]),
      original: image(originals[0]),
      target: image(operation["postimage"]),
    };
  });
  assert(result.length > 0 && result.length <= 8);
  assert.equal(new Set(result.map((operation) => operation.path)).size, result.length);
  return result;
}
function originalCapture(
  archive: OriginalArchive,
  phase: string,
  command: string,
  outcome: string,
): Row {
  const capture = originalJson(archive, "case-canonical/" + phase + ".json");
  for (const [key, expected] of Object.entries({
    label: phase,
    status: 0,
    signal: null,
    error: null,
    timedOut: false,
    streamsClosed: true,
    stdoutOverflow: false,
    stderrOverflow: false,
  })) {
    assert.deepEqual(capture[key], expected, "Original public command: " + key);
  }
  assert.deepEqual(capture["captureErrors"], []);
  const identity = row(capture["identity"], "Original public PID");
  assert(Number.isSafeInteger(identity["pid"]) && Number(identity["pid"]) > 0);
  assert(/^[0-9]+$/u.test(text(identity["start"], "Original PID start")));
  const stdout = originalFile(archive, "case-canonical/" + phase + ".stdout");
  const stderr = originalFile(archive, "case-canonical/" + phase + ".stderr");
  assert.equal(capture["stdoutSha256"], sha256(stdout));
  assert.equal(capture["stderrSha256"], sha256(stderr));
  assert.equal(capture["stdoutBytes"], stdout.length);
  assert.equal(capture["stderrBytes"], stderr.length);
  return resultEnvelope(stdout, command, outcome);
}
function originalImages(
  context: ProofContext,
  preparation: Preparation,
  original: SourceAdmission,
): void {
  const allowed = new Set([
    "AGENTS.md",
    "architecture/foundation/docs-consumer-integration.json",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    relativePath(original.profile["skillPath"]),
    relativePath(original.profile["callerWorkflowPath"]),
    relativePath(original.profile["managedStatePath"]),
  ]);
  for (const operation of preparation.operations) {
    assert(allowed.has(operation.path) && operation.path !== ".node-version");
    const sourceImage = original.images.find((entry) => entry.path === operation.path);
    assert(sourceImage && sourceImage.kind === "file");
    assert.equal(sourceImage.mode, operation.original.mode);
    assert.equal("sha256:" + sourceImage.sha256, operation.original.digest);
    assert(bytes(join(original.identity.root, operation.path)).equals(operation.original.content));
    const currentPath = join(context.evidence.config.consumer, operation.path);
    assert.equal(regularImage(currentPath).mode, operation.target.mode);
    assert(
      bytes(currentPath).equals(operation.target.content),
      "Final F overlaps the original managed path: " + operation.path,
    );
  }
}
export interface OriginalProofs {
  readonly preparation: Preparation;
  readonly retained: readonly { readonly path: string; readonly content: Buffer }[];
}
export function admitOriginalProofs(
  context: ProofContext,
  archive: OriginalArchive,
  selection: ArtifactSelection,
  original: SourceAdmission,
): OriginalProofs {
  const content = originalFile(archive, "case-canonical/completion.json.prepared");
  const digest = "sha256:" + sha256(content);
  assert.equal(digest, selection.preparationDigest);
  const value = row(JSON.parse(content.toString("utf8")), "Original unchanged preparation");
  keys(value, [
    "schemaVersion",
    "protocol",
    "sourceGeneration",
    "targetGeneration",
    "consumer",
    "sourceRevision",
    "sourceTree",
    "sourceInventoryDigest",
    "sourceCohort",
    "targetCohort",
    "controller",
    "kernel",
    "plan",
    "initialProofPath",
  ]);
  assert.equal(value["schemaVersion"], 1);
  assert.equal(value["protocol"], "agent-teams.managed-generation3-preparation/v1");
  assert.equal(value["sourceGeneration"], 2);
  assert.equal(value["targetGeneration"], 3);
  assert.equal(value["sourceRevision"], archive.marker["sourceRevision"]);
  assert.equal(value["sourceTree"], original.tree);
  assert.deepEqual(value["sourceCohort"], original.profile["cohort"]);
  assert.equal(row(value["sourceCohort"], "Original cohort")["cohortId"], sourceCohort);
  assert.deepEqual(value["targetCohort"], context.target.binding);
  assert.deepEqual(value["targetCohort"], context.source.profile["cohort"]);
  assert.deepEqual(value["controller"], context.builds["controller"]);
  assert.deepEqual(value["kernel"], context.builds["kernel"]);
  const historical = row(archive.marker["sourceRoot"], "Historical actual root");
  assert.deepEqual(value["consumer"], {
    root: historical["root"],
    device: historical["device"],
    inode: historical["inode"],
    birthtimeNs: historical["birthtimeNs"],
    repository: original.profile["repository"],
  });
  assert.equal(
    value["initialProofPath"],
    row(archive.marker["completion"], "Historical completion")["path"],
  );
  assert.equal(
    row(archive.marker["preparation"], "Historical preparation")["path"],
    String(value["initialProofPath"]) + ".prepared",
  );
  assert.equal(
    value["sourceInventoryDigest"],
    invoke(context.kernel, "sha256Json", [
      original.images.map((entry) => ({
        path: entry.path,
        digest: "sha256:" + entry.sha256,
        mode: entry.mode,
      })),
    ]),
  );
  const root = context.evidence.config.roots.evidenceRoot;
  const retained = ["completion.json.prepared", "completion.json", "completion.json.receipt"].map(
    (name) => {
      const raw = originalFile(archive, "case-canonical/" + name);
      return { path: retainAt(root, "original-proofs/" + name, raw), content: raw };
    },
  );
  const preparation = {
    path: retained[0]!.path,
    digest,
    content,
    value,
    operations: operations(context, value),
  };
  originalImages(context, preparation, original);
  const prepared = originalCapture(archive, "prepare", "consumer.upgrade", "prepared");
  assert.equal(row(prepared["preparation"], "Original preparation response")["digest"], digest);
  const finalized = originalCapture(archive, "finalize", "consumer.finalize", "upgraded");
  const receipt = assertReceipt(context, preparation, finalized["receipt"]);
  for (const [key, item] of [
    ["preparation", retained[0]!],
    ["completion", retained[1]!],
    ["receiptCompanion", retained[2]!],
  ] as const) {
    assert.equal(
      row(archive.marker[key], "Original retained selection")["sha256"],
      "sha256:" + sha256(item.content),
    );
  }
  const restoration = row(finalized["restoration"], "Original completion selection");
  assert.equal(restoration["path"], value["initialProofPath"]);
  assert.equal(restoration["digest"], "sha256:" + sha256(retained[1]!.content));
  const completed = originalJson(archive, "case-canonical/completion.json");
  keys(completed, ["schemaVersion", "protocol", "preparationDigest", "receipt", "activation"]);
  assert.equal(completed["schemaVersion"], 1);
  assert.equal(completed["protocol"], "agent-teams.managed-generation3-completion/v1");
  assert.equal(completed["preparationDigest"], digest);
  assert.equal(completed["activation"], "verified-current-v3");
  assert.deepEqual(completed["receipt"], receipt);
  const companion = originalJson(archive, "case-canonical/completion.json.receipt");
  keys(companion, ["preparationDigest", "receipt"]);
  assert.equal(companion["preparationDigest"], digest);
  assert.deepEqual(companion["receipt"], receipt);
  assert.deepEqual(archive.marker["receipt"], receipt);
  assert.deepEqual(
    archive.marker["targetCheck"],
    originalCapture(archive, "check-target", "consumer.check", "current"),
  );
  for (const [name, item] of [
    ["actual-preparation.json", retained[0]!],
    ["actual-completion.json", retained[1]!],
    ["actual-receipt-companion.json", retained[2]!],
  ] as const) {
    assert(originalFile(archive, "bootstrap/" + name).equals(item.content));
  }
  context.evidence.record("original-proof-transport", {
    originalDigest: digest,
    originalPath: row(archive.marker["preparation"], "P")["path"],
    selectedPath: preparation.path,
    historicalConsumer: value["consumer"],
    currentConsumer: context.source.identity,
    originalBytesUnchanged: true,
    initialProofPathUnchanged: true,
    scope:
      "Only the published committed current-selection route admits this transport; no original root is recreated or transferred.",
  });
  return { preparation, retained };
}
export function assertOriginalProofs(proofs: OriginalProofs): void {
  for (const retained of proofs.retained) {
    assert(bytes(retained.path).equals(retained.content), "Original proof changed");
  }
}
export function admitCurrentSelection(
  context: ProofContext,
  original: Preparation,
  path: string,
  envelope: Row,
): Preparation {
  const content = bytes(path),
    digest = "sha256:" + sha256(content),
    value = row(JSON.parse(content.toString("utf8")), "Actual new current selection");
  keys(value, [
    "schemaVersion",
    "protocol",
    "sourceGeneration",
    "targetGeneration",
    "originalPreparationDigest",
    "consumer",
    "sourceRevision",
    "sourceTree",
    "sourceInventoryDigest",
    "controller",
    "kernel",
    "plan",
  ]);
  assert.equal(value["schemaVersion"], 1);
  assert.equal(value["protocol"], "agent-teams.managed-generation3-current-restoration/v1");
  assert.equal(value["sourceGeneration"], 3);
  assert.equal(value["targetGeneration"], 2);
  assert.equal(value["originalPreparationDigest"], original.digest);
  assert.equal(value["sourceRevision"], context.evidence.config.sourceRevision);
  assert.equal(value["sourceTree"], context.source.tree);
  const { root, device, inode, birthtimeNs } = context.source.identity;
  assert.deepEqual(value["consumer"], {
    root,
    device,
    inode,
    birthtimeNs,
    repository: context.source.profile["repository"],
  });
  assert.deepEqual(value["controller"], context.builds["controller"]);
  assert.deepEqual(value["kernel"], context.builds["kernel"]);
  assert.equal(
    value["sourceInventoryDigest"],
    invoke(context.kernel, "sha256Json", [
      context.source.images.map((entry) => ({
        path: entry.path,
        digest: "sha256:" + entry.sha256,
        mode: entry.mode,
      })),
    ]),
  );
  const expected = invoke(context.kernel, "compileKnownFileTransactionPlan", [
    {
      operations: original.operations.map((operation) => ({
        path: operation.path,
        precondition: {
          state: "known-file",
          acceptedPreimages: [{ bytes: operation.target.content, mode: operation.target.mode }],
        },
        postimage: { bytes: operation.original.content, mode: operation.original.mode },
      })),
    },
  ]);
  assert.deepEqual(value["plan"], expected, "Actual owner selection is the exact inverse");
  assert.equal(envelope["proofDigest"], digest);
  assert.equal(envelope["inversePlanDigest"], row(value["plan"], "Selected inverse")["planDigest"]);
  const current = { path, digest, content, value, operations: operations(context, value) };
  assertReceipt(context, current, envelope["receipt"]);
  context.evidence.record("actual-current-selection", {
    path,
    digest,
    currentRevision: value["sourceRevision"],
    currentTree: value["sourceTree"],
    originalDigest: original.digest,
    scope:
      "Actual newly created owner selection; the first restore both selects and executes the inverse.",
  });
  return current;
}
