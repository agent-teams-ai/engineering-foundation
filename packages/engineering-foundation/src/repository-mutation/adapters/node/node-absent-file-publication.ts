import { createHash } from "node:crypto";
import { link, lstat, open, rm, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  AbsentFilePublicationError,
  type AbsentFilePublicationOutcome,
  type ExactFilePostimage,
  type ExactFilePostimageState
} from "../../application/model/exact-postimage.js";
import type { PortablePathIdentity } from "../../application/model/path-identity.js";
import { portableRepositoryPathIdentity } from "../../application/model/repository-path.js";
import {
  captureFileHandleIdentity,
  pathMatchesRegularFileIdentity,
  readBoundedRegularFile
} from "./node-bounded-regular-file.js";
import { syncDirectoryDurably } from "./node-directory-durability.js";

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
  rm,
  syncDirectory: syncDirectoryDurably
};

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isUnsupportedLink(error: unknown): boolean {
  return ["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"].includes(
    errorCode(error) ?? ""
  );
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sameIdentity(
  left: PortablePathIdentity,
  right: PortablePathIdentity
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function exactReadMatchesPostimage(
  result: Awaited<ReturnType<typeof readBoundedRegularFile>>,
  postimage: ExactFilePostimage
): result is Extract<typeof result, { readonly outcome: "read" }> {
  return (
    result.outcome === "read" &&
    result.bytes.byteLength === postimage.size &&
    sha256(result.bytes) === postimage.digest &&
    (process.platform === "win32" ||
      (result.mode & 0o777) === postimage.mode)
  );
}

async function verifyTemporaryForPublication(
  temporaryPath: string,
  postimage: ExactFilePostimage,
  expectedIdentity: PortablePathIdentity,
  displayPath: string
): Promise<void> {
  const stableTemporary = await readBoundedRegularFile(
    temporaryPath,
    postimage.size
  );
  if (
    exactReadMatchesPostimage(stableTemporary, postimage) &&
    sameIdentity(stableTemporary.identity, expectedIdentity)
  ) {
    return;
  }
  throw new AbsentFilePublicationError(
    "TEMPORARY_REPLACED",
    `Temporary path was replaced or modified concurrently: ${displayPath}.`
  );
}

async function verifyPublishedFile(
  destinationPath: string,
  postimage: ExactFilePostimage,
  expectedIdentity: PortablePathIdentity,
  displayPath: string
): Promise<void> {
  const publishedFile = await readBoundedRegularFile(
    destinationPath,
    postimage.size
  );
  if (
    exactReadMatchesPostimage(publishedFile, postimage) &&
    sameIdentity(publishedFile.identity, expectedIdentity)
  ) {
    return;
  }
  throw new AbsentFilePublicationError(
    "VERIFICATION_FAILED",
    `Published file failed identity or content verification: ${displayPath}.`
  );
}

function assertValidPostimage(postimage: ExactFilePostimage): void {
  if (
    !Number.isSafeInteger(postimage.size) ||
    postimage.size < 0 ||
    postimage.bytes.byteLength !== postimage.size ||
    sha256(postimage.bytes) !== postimage.digest ||
    !Number.isSafeInteger(postimage.mode) ||
    postimage.mode < 0 ||
    postimage.mode > 0o777
  ) {
    throw new AbsentFilePublicationError(
      "INVALID_POSTIMAGE",
      "Exact file postimage metadata does not match its bytes."
    );
  }
}

function snapshotPostimage(postimage: ExactFilePostimage): ExactFilePostimage {
  const snapshot = {
    bytes: Buffer.from(postimage.bytes),
    digest: postimage.digest,
    mode: postimage.mode,
    size: postimage.size
  };
  assertValidPostimage(snapshot);
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
  const snapshot = snapshotPostimage(postimage);
  try {
    const result = await readBoundedRegularFile(destinationPath, snapshot.size);
    if (result.outcome !== "read") {
      return "conflict";
    }
    const modeMatches =
      process.platform === "win32" ||
      (result.mode & 0o777) === snapshot.mode;
    return result.bytes.byteLength === snapshot.size &&
      sha256(result.bytes) === snapshot.digest &&
      modeMatches
      ? "exact"
      : "conflict";
  } catch (error) {
    if (isMissing(error)) {
      return "absent";
    }
    throw error;
  }
}

export async function assertTemporaryPathsAbsent(
  entries: readonly { readonly displayPath: string; readonly temporaryPath: string }[]
): Promise<void> {
  for (const entry of entries) {
    try {
      await lstat(entry.temporaryPath);
    } catch (error) {
      if (isMissing(error)) {
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

async function syncPublicationParent(context: PublicationContext): Promise<void> {
  const durability = await context.operations.syncDirectory(context.parent);
  if (
    durability === "unsupported" &&
    !context.allowUnsupportedDirectoryDurability
  ) {
    throw new AbsentFilePublicationError(
      "PUBLICATION_UNSUPPORTED",
      `Directory durability is unsupported: ${context.displayPath}.`
    );
  }
}

async function createPublicationTemporary(
  context: PublicationContext,
  state: PublicationState
): Promise<void> {
  const handle = await context.operations
    .open(context.temporaryPath, "wx", 0o600)
    .catch((error: unknown) => {
      if (errorCode(error) === "EEXIST") {
        throw new AbsentFilePublicationError(
          "TEMPORARY_EXISTS",
          `Temporary path already exists: ${context.displayPath}.`,
          { cause: error }
        );
      }
      throw error;
    });
  try {
    state.temporaryIdentity = await captureFileHandleIdentity(handle);
    await handle.writeFile(context.postimage.bytes);
    await context.faultInjector?.({ phase: "after-temporary-written" });
    await handle.chmod(context.postimage.mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function linkPublicationDestination(
  context: PublicationContext
): Promise<boolean> {
  try {
    await context.operations.link(
      context.temporaryPath,
      context.destinationPath
    );
    return false;
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      const state = await classifyExactFilePostimage(
        context.destinationPath,
        context.postimage
      );
      if (state === "exact") {
        return true;
      }
      throw new AbsentFilePublicationError(
        "CONFLICT",
        `Destination changed concurrently: ${context.displayPath}.`,
        { cause: error }
      );
    }
    if (isUnsupportedLink(error)) {
      throw new AbsentFilePublicationError(
        "PUBLICATION_UNSUPPORTED",
        `Atomic absent-only publication is unsupported: ${context.displayPath}.`,
        { cause: error }
      );
    }
    throw error;
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
    await createPublicationTemporary(context, state);
    const temporaryIdentity = state.temporaryIdentity;
    if (temporaryIdentity === undefined) {
      throw new AbsentFilePublicationError(
        "PUBLICATION_INCOMPLETE",
        `Publication temporary identity was not captured: ${context.displayPath}.`
      );
    }
    await context.faultInjector?.({ phase: "after-temporary-synced" });
    await verifyTemporaryForPublication(
      context.temporaryPath,
      context.postimage,
      temporaryIdentity,
      context.displayPath
    );
    state.concurrentSatisfied = await linkPublicationDestination(context);
    if (!state.concurrentSatisfied) {
      state.published = true;
      await context.faultInjector?.({ phase: "after-hard-link" });
      await verifyPublishedFile(
        context.destinationPath,
        context.postimage,
        temporaryIdentity,
        context.displayPath
      );
      await syncPublicationParent(context);
    }
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
        : await pathMatchesRegularFileIdentity(
            context.temporaryPath,
            state.temporaryIdentity
          );
    if (ownership === "match") {
      await context.operations.rm(context.temporaryPath);
      await syncPublicationParent(context);
    } else if (ownership === "different") {
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
      (await classifyExactFilePostimage(
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
  await verifyPublishedFile(
    context.destinationPath,
    context.postimage,
    state.temporaryIdentity,
    context.displayPath
  );
  return "published";
}

export async function publishAbsentFile(options: {
  readonly allowUnsupportedDirectoryDurability?: boolean;
  readonly destinationPath: string;
  readonly displayPath: string;
  readonly faultInjector?: AbsentFilePublicationFaultInjector;
  readonly operations?: Partial<AbsentFilePublicationOperations>;
  readonly postimage: ExactFilePostimage;
  readonly temporaryPath: string;
}): Promise<AbsentFilePublicationOutcome> {
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
    temporaryPath: options.temporaryPath
  };
  assertValidPublicationPaths(
    context.temporaryPath,
    context.destinationPath,
    context.displayPath
  );
  const initial = await classifyExactFilePostimage(
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
