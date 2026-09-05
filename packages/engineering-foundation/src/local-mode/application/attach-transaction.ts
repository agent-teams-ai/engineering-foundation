import { FoundationError } from "./errors/foundation-error.js";
import { isExactVersion } from "../../semantic-version.js";
import { releaseFoundationTransactionLeaseSafely } from "../../transaction-coordination/application/release-foundation-transaction-lease.js";
import type { AttachResult, FoundationLinkState, FoundationStatus } from "./model.js";
import { FOUNDATION_PACKAGE_NAME } from "./model.js";
import type { LocalPackageLifecyclePorts } from "./ports.js";

interface AttachTransactionInput {
  readonly consumerPath: string;
  readonly targetPath: string;
  readonly ports: LocalPackageLifecyclePorts;
  readonly now: () => Date;
  readonly readStatus: (
    consumerPath: string,
    ignoreOperationLock: boolean
  ) => Promise<FoundationStatus>;
}

interface AttachConsumerState {
  readonly consumerRoot: string;
  readonly dependencySpec: string;
  readonly registryPackageRoot: string;
}

interface AttachPreparation extends AttachConsumerState {
  readonly targetPackageRoot: string;
  readonly packageVersion: string;
  readonly gitCommit: string;
  readonly gitDirty: boolean;
}

type AttachPreparationFailureCode = "CONSUMER_INVALID" | "LOCAL_STATE_INVALID";

async function inspectAttachConsumerState(
  input: AttachTransactionInput,
  failureCode: AttachPreparationFailureCode,
  expected?: Pick<AttachConsumerState, "consumerRoot" | "dependencySpec">
): Promise<AttachConsumerState> {
  const before = await input.ports.inspection.mode(input.consumerPath, { ignoreOperationLock: true });
  if (
    before.mode !== "REGISTRY" ||
    before.dependencySpec === undefined ||
    !isExactVersion(before.dependencySpec) ||
    before.installedPackageRoot === undefined
  ) {
    throw new FoundationError(
      failureCode,
      failureCode === "CONSUMER_INVALID"
        ? `Consumer must be in valid registry mode with an exact ${FOUNDATION_PACKAGE_NAME} version before attach: ${before.issues.join(" ") || before.mode}.`
        : "Consumer foundation state changed before attach acquired its operation lock."
    );
  }
  if (
    expected !== undefined &&
    (before.consumerRoot !== expected.consumerRoot ||
      before.dependencySpec !== expected.dependencySpec)
  ) {
    throw new FoundationError(
      "LOCAL_STATE_INVALID",
      "Consumer foundation state changed before attach acquired its operation lock."
    );
  }
  return {
    consumerRoot: before.consumerRoot,
    dependencySpec: before.dependencySpec,
    registryPackageRoot: before.installedPackageRoot
  };
}

async function prepareAttach(
  input: AttachTransactionInput,
  consumer: AttachConsumerState
): Promise<AttachPreparation> {
  const target = await input.ports.target.verify(consumer.consumerRoot, input.targetPath);
  const git = await input.ports.target.git(
    consumer.consumerRoot,
    target.targetPackageRoot
  );
  return {
    ...consumer,
    ...target,
    ...git
  };
}

function createAttachingState(
  preparation: AttachPreparation,
  registryPackageRoot: string,
  entry: { readonly registryEntryKind: FoundationLinkState["registryEntryKind"]; readonly registryBackupPath: string },
  now: () => Date
): FoundationLinkState {
  return {
    schemaVersion: 1,
    phase: "ATTACHING",
    consumerRoot: preparation.consumerRoot,
    targetPackageRoot: preparation.targetPackageRoot,
    registryBackupPath: entry.registryBackupPath,
    registryEntryKind: entry.registryEntryKind,
    registryPackageRoot,
    packageVersion: preparation.packageVersion,
    gitCommit: preparation.gitCommit,
    gitDirty: preparation.gitDirty,
    attachedAt: now().toISOString()
  };
}

async function recoverFailedAttach(
  preparation: AttachPreparation,
  state: FoundationLinkState,
  failure: unknown,
  ports: LocalPackageLifecyclePorts
): Promise<never> {
  const recoveryErrors: unknown[] = [];
  try {
    await ports.links.restore(preparation.consumerRoot, preparation.dependencySpec, state);
  } catch (error) {
    recoveryErrors.push(error);
  }
  try {
    await ports.state.remove(preparation.consumerRoot);
  } catch (error) {
    recoveryErrors.push(error);
  }
  if (recoveryErrors.length > 0) {
    throw new FoundationError(
      "LOCAL_STATE_INVALID",
      "Local attach failed and its registry state could not be fully restored.",
      { cause: new AggregateError([failure, ...recoveryErrors], "Attach and one or more recovery operations failed.") }
    );
  }
  throw new FoundationError(
    "LOCAL_STATE_INVALID",
    "Local attach failed and the registry installation was restored.",
    { cause: failure }
  );
}

async function commitAttach(
  input: AttachTransactionInput,
  preflight: AttachConsumerState
): Promise<AttachResult> {
  let preparation: AttachPreparation | undefined;
  let state: FoundationLinkState | undefined;
  try {
    const consumer = await inspectAttachConsumerState(
      input,
      "LOCAL_STATE_INVALID",
      preflight
    );
    preparation = await prepareAttach(input, consumer);
    const entry = await input.ports.links.prepare(preparation.consumerRoot, preparation.registryPackageRoot);
    await input.ports.links.ignoreLocalState(preparation.consumerRoot);
    state = createAttachingState(
      preparation,
      preparation.registryPackageRoot,
      entry,
      input.now
    );
    await input.ports.state.write(preparation.consumerRoot, state);
    await input.ports.links.replace(state);
    state = { ...state, phase: "LOCAL" };
    await input.ports.state.write(preparation.consumerRoot, state);
    const status = await input.readStatus(preparation.consumerRoot, true);
    if (status.mode !== "LOCAL") {
      throw new FoundationError(
        "LOCAL_STATE_INVALID",
        `Local attach verification failed: ${status.issues.join(" ")}`
      );
    }
    return { status, targetPackageRoot: preparation.targetPackageRoot };
  } catch (error) {
    if (state === undefined || preparation === undefined) {
      throw error;
    }
    return await recoverFailedAttach(preparation, state, error, input.ports);
  }
}

export async function attachFoundation(
  input: AttachTransactionInput
): Promise<AttachResult> {
  const coordinator = await input.ports.coordinator(
    input.consumerPath
  );
  const lease = await coordinator.acquire({ requestedMutation: "attach" });
  try {
    const preflight = await inspectAttachConsumerState(
      input,
      "CONSUMER_INVALID"
    );
    return await commitAttach(input, preflight);
  } finally {
    await releaseFoundationTransactionLeaseSafely({
      lease,
      inspectRetainTransactionBarrier: async () =>
        (await coordinator.inspect()).state !== "idle"
    });
  }
}
