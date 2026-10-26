import type { ManagedConsumerOperations } from "../../application-api.js";
import {
  Arguments,
  COHORT_ID,
  SHA256,
  GIT_SHA,
  ConsumerCliInputError,
} from "./consumer-cli-arguments.js";

export async function executeFinalizationArguments(
  args: Arguments,
  consumerRoot: string,
  operations: ManagedConsumerOperations,
) {
  const from = args.one("--from", true)!;
  const to = args.one("--to", true)!;
  const sourceGeneration = args.one("--source-generation", true);
  const targetGeneration = args.one("--target-generation", true);
  const preparationPath = args.one("--preparation", true)!;
  const proofPath = args.one("--proof", true)!;
  const expect = args.one("--expect", true)!;
  if (
    !COHORT_ID.test(from) ||
    !COHORT_ID.test(to) ||
    !SHA256.test(expect) ||
    !(
      (sourceGeneration === "1" && targetGeneration === "2") ||
      (sourceGeneration === "2" && targetGeneration === "3")
    )
  ) {
    throw new ConsumerCliInputError(
      "Finalize requires exact Cohorts, selected preparation and explicit generations 1->2 or 2->3.",
    );
  }
  args.assertConsumed();
  const selected = {
    consumerRoot,
    from,
    to,
    preparationPath,
    proofPath,
    expect,
  };
  return operations.finalize(
    sourceGeneration === "1"
      ? { ...selected, sourceGeneration: 1, targetGeneration: 2 }
      : { ...selected, sourceGeneration: 2, targetGeneration: 3 },
  );
}

function currentRestorationArguments(args: Arguments) {
  const currentRevision = args.one("--current-revision");
  const currentTree = args.one("--current-tree");
  const selectionPath = args.one("--selection");
  const selectionExpect = args.one("--selection-expect");
  if (
    [currentRevision, currentTree, selectionPath, selectionExpect].every(
      (value) => value === undefined,
    )
  ) {
    return;
  }
  if (
    currentRevision === undefined ||
    currentTree === undefined ||
    selectionPath === undefined ||
    !GIT_SHA.test(currentRevision) ||
    !GIT_SHA.test(currentTree) ||
    (selectionExpect !== undefined && !SHA256.test(selectionExpect))
  ) {
    throw new ConsumerCliInputError(
      "Committed-target restore requires exact current HEAD/tree, external selection and optional selected digest.",
    );
  }
  return {
    currentRevision,
    currentTree,
    selectionPath,
    ...(selectionExpect === undefined ? {} : { selectionExpect }),
  };
}

export async function executeRestorationArguments(
  args: Arguments,
  consumerRoot: string,
  operations: ManagedConsumerOperations,
) {
  const from = args.one("--from", true)!;
  const to = args.one("--to", true)!;
  const sourceGeneration = args.one("--source-generation", true);
  const targetGeneration = args.one("--target-generation", true);
  const proofPath = args.one("--proof");
  const preparationPath = args.one("--preparation");
  const expect = args.one("--expect", true)!;
  const activationOnly = args.flag("--activation-only");
  const current = currentRestorationArguments(args);
  if (current !== undefined && sourceGeneration !== "3") {
    throw new ConsumerCliInputError("Current-target selection requires explicit generations3->2.");
  }
  if (
    !COHORT_ID.test(from) ||
    !COHORT_ID.test(to) ||
    !SHA256.test(expect) ||
    !(
      (sourceGeneration === "2" &&
        targetGeneration === "1" &&
        proofPath !== undefined &&
        preparationPath === undefined) ||
      (sourceGeneration === "3" &&
        targetGeneration === "2" &&
        preparationPath !== undefined &&
        proofPath === undefined &&
        !activationOnly)
    )
  ) {
    throw new ConsumerCliInputError(
      "Restore requires exact Cohorts, proof digest and explicit generations 2->1 (proof) or 3->2 (preparation).",
    );
  }
  args.assertConsumed();
  return operations.restore(
    sourceGeneration === "3"
      ? {
          consumerRoot,
          from,
          to,
          preparationPath: preparationPath!,
          expect,
          sourceGeneration: 3,
          targetGeneration: 2,
          ...current,
        }
      : {
          consumerRoot,
          from,
          to,
          proofPath: proofPath!,
          expect,
          sourceGeneration: 2,
          targetGeneration: 1,
          activationOnly,
        },
  );
}
