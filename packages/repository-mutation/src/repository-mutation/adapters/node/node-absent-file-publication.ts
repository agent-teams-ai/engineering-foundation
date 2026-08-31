import { lstat, link, open, rm, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  AbsentFilePublicationError,
  type AbsentFilePublicationOutcome,
  type ExactFilePostimage,
  type ExactFilePostimageState
} from "../../application/model/exact-postimage.js";
import type { PortablePathIdentity } from "../../application/model/path-identity.js";
import type { OwnedTemporaryCleanupTransitionPort } from "../../application/ports/owned-temporary-cleanup-transition.js";
import { portableRepositoryPathIdentity } from "../../application/model/repository-path.js";
import { readBoundedRegularFile } from "./node-bounded-regular-file.js";
import { cleanupIdentityMatchingOwnedTemporary } from "./node-cleanup-owned-temporary.js";
import { syncDirectoryDurably } from "./node-directory-durability.js";
import {
  assertValidExactPostimage,
  classifyExactFilePostimageWith,
  isMissingPublicationPath
} from "./node-absent-file-publication-private.js";
import { prepareExactSiblingTemporaryWithFaults } from "./node-prepare-exact-sibling-temporary.js";
import {
  publishPreparedAbsentFileWithFaults,
  verifyPublishedAbsentFile
} from "./node-publish-prepared-absent-file.js";

export interface AbsentFilePublicationFaultPoint {
  readonly phase:
    | "after-hard-link"
    | "after-temporary-synced"
    | "after-temporary-written";
}

export type AbsentFilePublicationFaultInjector = (
  point: AbsentFilePublicationFaultPoint
) => Promise<void> | void;

interface AbsentFilePublicationOperations {
  readonly link: typeof link;
  readonly open: (
    path: string,
    flags: "wx",
    mode: number
  ) => Promise<FileHandle>;
  readonly readBoundedRegularFile: typeof readBoundedRegularFile;
  readonly rm: (path: string) => Promise<void>;
  readonly syncDirectory: typeof syncDirectoryDurably;
}

interface PublicationContext {
  readonly allowUnsupportedDirectoryDurability: boolean;
  readonly destinationPath: string;
  readonly displayPath: string;
  readonly faultInjector: AbsentFilePublicationFaultInjector | undefined;
  readonly operations: AbsentFilePublicationOperations;
  readonly parent: string;
  readonly postimage: ExactFilePostimage;
  readonly temporaryPath: string;
  readonly transition: OwnedTemporaryCleanupTransitionPort | undefined;
}

interface PublicationState {
  concurrentSatisfied: boolean;
  error?: unknown;
  published: boolean;
  temporaryIdentity?: PortablePathIdentity;
}

const nodeOperations: AbsentFilePublicationOperations = {
  link,
  open,
  readBoundedRegularFile,
  rm,
  syncDirectory: syncDirectoryDurably
};

function snapshotPostimage(postimage: ExactFilePostimage): ExactFilePostimage {
  const snapshot = {
    bytes: Buffer.from(postimage.bytes),
    digest: postimage.digest,
    mode: postimage.mode,
    size: postimage.size
  };
  assertValidExactPostimage(snapshot);
  return snapshot;
}

function assertValidPublicationPaths(
  temporaryPath: string,
  destinationPath: string,
  displayPath: string
): void {
  const resolvedTemporary = resolve(temporaryPath);
  const resolvedDestination = resolve(destinationPath);
  if (
    portableRepositoryPathIdentity(resolvedTemporary) ===
      portableRepositoryPathIdentity(resolvedDestination) ||
    dirname(resolvedTemporary) !== dirname(resolvedDestination)
  ) {
    throw new AbsentFilePublicationError(
      "PUBLICATION_INVALID",
      `Publication paths are not distinct siblings: ${displayPath}.`
    );
  }
}

export async function classifyExactFilePostimage(
  destinationPath: string,
  postimage: ExactFilePostimage
): Promise<ExactFilePostimageState> {
  return classifyExactFilePostimageWith(
    readBoundedRegularFile,
    destinationPath,
    snapshotPostimage(postimage)
  );
}

export async function assertTemporaryPathsAbsent(
  entries: readonly { readonly displayPath: string; readonly temporaryPath: string }[]
): Promise<void> {
  for (const entry of entries) {
    try {
      await lstat(entry.temporaryPath);
    } catch (error) {
      if (isMissingPublicationPath(error)) {
        continue;
      }
      throw error;
    }
    throw new AbsentFilePublicationError(
      "TEMPORARY_EXISTS",
      `Temporary path already exists: ${entry.displayPath}.`
    );
  }
}

async function runPublicationPhase(
  context: PublicationContext
): Promise<PublicationState> {
  const state: PublicationState = {
    concurrentSatisfied: false,
    published: false
  };
  try {
    const temporaryIdentity = await prepareExactSiblingTemporaryWithFaults({
      displayPath: context.displayPath,
      ...(context.faultInjector === undefined
        ? {}
        : { faultInjector: context.faultInjector }),
      onIdentityCaptured(identity) {
        state.temporaryIdentity = identity;
      },
      open: context.operations.open,
      postimage: context.postimage,
      temporaryPath: context.temporaryPath
    });
    await context.faultInjector?.({ phase: "after-temporary-synced" });
    const outcome = await publishPreparedAbsentFileWithFaults({
      allowUnsupportedDirectoryDurability:
        context.allowUnsupportedDirectoryDurability,
      classifyBoundedRegularFile: context.operations.readBoundedRegularFile,
      destinationPath: context.destinationPath,
      displayPath: context.displayPath,
      expectedIdentity: temporaryIdentity,
      ...(context.faultInjector === undefined
        ? {}
        : { faultInjector: context.faultInjector }),
      link: context.operations.link,
      parent: context.parent,
      postimage: context.postimage,
      readBoundedRegularFile: context.operations.readBoundedRegularFile,
      syncDirectory: context.operations.syncDirectory,
      temporaryPath: context.temporaryPath
    });
    state.concurrentSatisfied = outcome === "already-satisfied";
    state.published = outcome === "published";
  } catch (error) {
    state.error = error;
  }
  return state;
}

async function cleanupPublicationTemporary(
  context: PublicationContext,
  state: PublicationState
): Promise<void> {
  try {
    const ownership =
      state.temporaryIdentity === undefined
        ? "missing"
        : await cleanupIdentityMatchingOwnedTemporary({
            allowUnsupportedDirectoryDurability:
              context.allowUnsupportedDirectoryDurability,
            displayPath: context.displayPath,
            expectedIdentity: state.temporaryIdentity,
            parent: context.parent,
            rm: context.operations.rm,
            syncDirectory: context.operations.syncDirectory,
            temporaryPath: context.temporaryPath,
            ...(context.transition === undefined
              ? {}
              : { transition: context.transition })
          });
    if (ownership === "different") {
      throw new AbsentFilePublicationError(
        "TEMPORARY_REPLACED",
        `Temporary path was replaced concurrently: ${context.displayPath}.`,
        state.error === undefined ? undefined : { cause: state.error }
      );
    }
  } catch (cleanupError) {
    if (
      cleanupError instanceof AbsentFilePublicationError &&
      cleanupError.code === "TEMPORARY_REPLACED"
    ) {
      throw cleanupError;
    }
    throw new AbsentFilePublicationError(
      "CLEANUP_FAILED",
      `Publication temporary cleanup failed: ${context.displayPath}.`,
      {
        cause: state.error ?? cleanupError,
        cleanupError
      }
    );
  }
}

async function publicationOutcome(
  context: PublicationContext,
  state: PublicationState
): Promise<AbsentFilePublicationOutcome> {
  if (state.error !== undefined) {
    if (!(state.error instanceof Error)) {
      throw new AbsentFilePublicationError(
        "INVALID_ERROR",
        `Publication failed with an invalid error value: ${context.displayPath}.`
      );
    }
    throw state.error;
  }
  if (state.concurrentSatisfied) {
    if (
      (await classifyExactFilePostimageWith(
        context.operations.readBoundedRegularFile,
        context.destinationPath,
        context.postimage
      )) !== "exact"
    ) {
      throw new AbsentFilePublicationError(
        "CONFLICT",
        `Destination changed concurrently: ${context.displayPath}.`
      );
    }
    return "already-satisfied";
  }
  if (!state.published || state.temporaryIdentity === undefined) {
    throw new AbsentFilePublicationError(
      "PUBLICATION_INCOMPLETE",
      `Publication did not reach a terminal state: ${context.displayPath}.`
    );
  }
  await verifyPublishedAbsentFile({
    destinationPath: context.destinationPath,
    displayPath: context.displayPath,
    expectedIdentity: state.temporaryIdentity,
    postimage: context.postimage,
    readBoundedRegularFile: context.operations.readBoundedRegularFile
  });
  return "published";
}

export interface AbsentFilePublicationOptions {
  readonly allowUnsupportedDirectoryDurability?: boolean;
  readonly destinationPath: string;
  readonly displayPath: string;
  readonly postimage: ExactFilePostimage;
  readonly temporaryPath: string;
  readonly transition?: OwnedTemporaryCleanupTransitionPort;
}

export async function publishAbsentFileWithFaults(
  options: AbsentFilePublicationOptions & {
    readonly faultInjector?: AbsentFilePublicationFaultInjector;
    readonly operations?: Partial<AbsentFilePublicationOperations>;
  }
): Promise<AbsentFilePublicationOutcome> {
  const postimage = snapshotPostimage(options.postimage);
  const context: PublicationContext = {
    allowUnsupportedDirectoryDurability:
      options.allowUnsupportedDirectoryDurability === true,
    destinationPath: options.destinationPath,
    displayPath: options.displayPath,
    faultInjector: options.faultInjector,
    operations: { ...nodeOperations, ...options.operations },
    parent: dirname(resolve(options.destinationPath)),
    postimage,
    temporaryPath: options.temporaryPath,
    transition: options.transition
  };
  assertValidPublicationPaths(
    context.temporaryPath,
    context.destinationPath,
    context.displayPath
  );
  const initial = await classifyExactFilePostimageWith(
    context.operations.readBoundedRegularFile,
    context.destinationPath,
    context.postimage
  );
  if (initial === "exact") {
    return "already-satisfied";
  }
  if (initial === "conflict") {
    throw new AbsentFilePublicationError(
      "CONFLICT",
      `Destination changed concurrently: ${context.displayPath}.`
    );
  }
  const state = await runPublicationPhase(context);
  await cleanupPublicationTemporary(context, state);
  return publicationOutcome(context, state);
}

export function publishAbsentFile(
  options: AbsentFilePublicationOptions
): Promise<AbsentFilePublicationOutcome> {
  return publishAbsentFileWithFaults(options);
}
