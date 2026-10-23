import { lstat } from "node:fs/promises";
import { deserializeKnownFileIdentity } from "../../application/model/known-file-transaction-journal.js";
import { KnownFileTransactionError } from "../../application/model/known-file-transaction-error.js";
import { knownFileErrorCode } from "./node-known-file-transaction-filesystem.js";
import type {
  CapturedPreimageOptions,
  RecoveryPaths,
} from "./node-known-file-recovery-preimage-captured.js";
export async function assertCaptureDirectory(
  options: CapturedPreimageOptions,
  paths: RecoveryPaths,
): Promise<void> {
  const expectedDirectory = deserializeKnownFileIdentity(
    options.journalOperation.captureDirectoryIdentity,
  );
  const directory = await lstat(paths.directory, { bigint: true }).catch((error: unknown) => {
    if (knownFileErrorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (
    directory === null ||
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.birthtimeNs !== expectedDirectory.birthtimeNs ||
    directory.dev !== expectedDirectory.dev ||
    directory.ino !== expectedDirectory.ino
  ) {
    throw new KnownFileTransactionError(
      "KNOWN_FILE_RECOVERY_CONFLICT",
      `Replacement capture directory changed: ${options.operation.path}.`,
    );
  }
}
