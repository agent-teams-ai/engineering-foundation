import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertOwnedCasePath } from "../owned-root.ts";
import {
  array,
  jsonEvidence,
  object,
  outputRoot,
  parse,
  requireEqual,
  string,
  utf8,
  type JsonRecord,
} from "../stage-a/io.ts";
import { invoke } from "../stage-a/publication.ts";
import {
  bytes,
  equal,
  exactPath,
  git,
  image,
  selectedBytes,
  sourceRevision,
  type ManagedContext,
} from "./context.ts";
import { contracts, external, relativeFile, type RefusalCase } from "./refusal-contracts.ts";

export function bindRefusalPreparation(
  c: ManagedContext,
  selection: JsonRecord,
  refusalCase: RefusalCase,
) {
  const contract = contracts[refusalCase];
  assertOwnedCasePath(c.consumer);
  requireEqual(
    c.consumer,
    exactPath(selection["consumerRoot"], "owned disposable root"),
    "canonical owned disposable root",
  );
  external(realpathSync(outputRoot), [c.consumer, c.installation]);
  const completionPath = exactPath(selection["completionPath"], "actual completion path");
  external(completionPath, [c.consumer, c.installation]);
  const preparationPath = `${completionPath}.prepared`;
  const isPrepare = contract.operation === "prepare",
    isCommitted = contract.operation === "restore-committed";
  const retained = isPrepare
    ? undefined
    : selectedBytes(selection["preparation"], "actual unchanged preparation");
  const preparation =
    retained === undefined ? undefined : parse(utf8(retained.bytes), "actual preparation");
  if (retained && preparation) {
    requireEqual(retained.path, preparationPath, "actual preparation namespace");
    requireEqual(
      preparation["protocol"],
      "agent-teams.managed-generation3-preparation/v1",
      "actual preparation family",
    );
    requireEqual(preparation["sourceRevision"], sourceRevision, "actual preparation source");
    requireEqual(preparation["initialProofPath"], completionPath, "actual completion namespace");
    equal(preparation["targetCohort"], c.targetBinding, "actual qualified binding");
    const preparedConsumer = object(preparation["consumer"], "prepared consumer");
    if (!isCommitted && refusalCase !== "wrong-root") {
      requireEqual(preparedConsumer["root"], c.consumer, "selected original root");
    }
    if (refusalCase === "wrong-root" && preparedConsumer["root"] === c.consumer) {
      throw new Error("Wrong-root case still selects original root.");
    }
  }
  return { completionPath, preparationPath, isPrepare, isCommitted, retained, preparation };
}
export type RefusalPreparation = ReturnType<typeof bindRefusalPreparation>;

export function observeCurrentSelection(
  c: ManagedContext,
  selection: JsonRecord,
  refusalCase: RefusalCase,
  isCommitted: boolean,
) {
  const currentHead = git(c.consumer, "refusal-head", ["rev-parse", "HEAD"]);
  const currentTree = git(c.consumer, "refusal-tree", ["rev-parse", "HEAD^{tree}"]);
  if (!isCommitted) {
    requireEqual(currentHead, sourceRevision, "original source HEAD");
  }
  const currentSelectionPath = isCommitted
    ? exactPath(selection["currentSelectionPath"], "current selection path")
    : undefined;
  let currentDigest: string | undefined;
  if (currentSelectionPath) {
    external(currentSelectionPath, [c.consumer, c.installation]);
    const revision = string(selection["currentRevision"], "selected current revision");
    const tree = string(selection["currentTree"], "selected current tree");
    if (!/^(?!0{40}$)[0-9a-f]{40}$/u.test(revision) || !/^(?!0{40}$)[0-9a-f]{40}$/u.test(tree)) {
      throw new Error("Current coordinates must be exact.");
    }
    requireEqual(
      git(c.consumer, "selected-current-tree", ["rev-parse", `${revision}^{tree}`]),
      tree,
      "real selected commit tree",
    );
    if (refusalCase === "stale-current-head") {
      if (currentHead === revision) {
        throw new Error("Current HEAD is not stale.");
      }
    } else {
      requireEqual(currentHead, revision, "actual selected current HEAD");
      requireEqual(currentTree, tree, "actual selected current tree");
    }
    if (existsSync(currentSelectionPath)) {
      currentDigest = selectedBytes(
        { path: currentSelectionPath, sha256: selection["currentSelectionDigest"] },
        "actual current selection",
      ).digest;
    } else if (selection["currentSelectionDigest"] !== undefined) {
      throw new Error("No actual current selection exists for supplied digest.");
    }
  }
  if (refusalCase === "stale-current-digest" && currentDigest === undefined) {
    throw new Error("Stale digest case needs an actual retained current selection.");
  }
  if (refusalCase === "host-overlap" && currentDigest !== undefined) {
    throw new Error("Host overlap refusal requires fresh current selection.");
  }
  if (
    refusalCase === "host-overlap" ||
    (refusalCase === "stale-current-head" && currentDigest === undefined)
  ) {
    requireEqual(
      git(c.consumer, "committed-specimen-clean", [
        "status",
        "--porcelain=v1",
        "--untracked-files=no",
      ]),
      "",
      "clean committed refusal specimen",
    );
  }
  return { currentHead, currentTree, currentSelectionPath, currentDigest };
}
export type RefusalCurrentSelection = ReturnType<typeof observeCurrentSelection>;

export function assertRefusalLifecycle(
  c: ManagedContext,
  refusalCase: RefusalCase,
  custody: RefusalPreparation,
): void {
  const { isPrepare, completionPath, preparationPath, retained, preparation } = custody;
  if (isPrepare) {
    requireEqual(
      git(c.consumer, "prepare-clean", ["status", "--porcelain=v1", "--untracked-files=no"]),
      "",
      "clean prepare specimen",
    );
    for (const path of [completionPath, preparationPath, `${completionPath}.receipt`]) {
      if (existsSync(path)) {
        throw new Error("Refused preparation requires fresh proof paths.");
      }
    }
  }
  if (refusalCase === "completed-republish") {
    if (!existsSync(completionPath)) {
      throw new Error("Completed republish case needs an actual completion.");
    }
    const completion = parse(utf8(bytes(completionPath)), "actual prior completion");
    requireEqual(
      completion["protocol"],
      "agent-teams.managed-generation3-completion/v1",
      "actual completion family",
    );
    requireEqual(completion["preparationDigest"], retained!.digest, "actual completed selection");
    for (const value of array(
      object(preparation?.["plan"], "actual plan")["operations"],
      "operations",
    )) {
      const operation = object(value, "operation");
      const original = object(
        array(
          object(operation["precondition"], "precondition")["acceptedPreimages"],
          "preimages",
        )[0],
        "original image",
      );
      const actual = image(c.consumer, relativeFile(operation["path"]));
      requireEqual(actual.sha256, original["digest"], "actually restored original bytes");
      requireEqual(actual.mode, original["mode"], "actually restored original mode");
    }
  }
}

export async function observeRefusalBuilds(
  c: ManagedContext,
  preparation: JsonRecord | undefined,
  refusalCase: RefusalCase,
) {
  const publicRequire = createRequire(join(c.installation, "package.json"));
  const kernelRoot = dirname(
    publicRequire.resolve("@agent-teams/repository-mutation/package.json"),
  );
  const kernel = object(
    await import(pathToFileURL(publicRequire.resolve("@agent-teams/repository-mutation")).href),
    "public kernel exports",
  );
  const barrier = async () =>
    object(
      await invoke(kernel, "inspectKnownFileTransactionBarrier", [{ consumerRoot: c.consumer }]),
      "public barrier",
    );
  const build = (packageRoot: string, roots: readonly string[]) =>
    invoke(kernel, "computeInstalledArtifactBuildIdentity", [{ packageRoot, roots }]);
  const observedBuild = await build(c.controllerRoot, ["dist", "assets", "schemas"]);
  const observedKernel = await build(kernelRoot, ["dist", "schemas"]);
  if (preparation) {
    requireEqual(
      observedKernel,
      object(preparation["kernel"], "retained kernel")["buildIdentity"],
      "same actual kernel build",
    );
    const expectedBuild = object(preparation["controller"], "retained controller")["buildIdentity"];
    if (refusalCase === "build-drift") {
      if (observedBuild === expectedBuild) {
        throw new Error("Controller build has not changed.");
      }
    } else {
      requireEqual(observedBuild, expectedBuild, "same actual controller build");
    }
  }
  jsonEvidence("artifact-observations.json", {
    observedBuild,
    observedKernel,
    preparationController: preparation?.["controller"] ?? null,
  });
  return { kernelRoot, barrier, build, observedBuild, observedKernel };
}
