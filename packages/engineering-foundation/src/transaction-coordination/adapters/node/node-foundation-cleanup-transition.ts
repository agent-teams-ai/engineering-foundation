import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  rename,
  rm,
  rmdir,
  type FileHandle
} from "node:fs/promises";
import { join } from "node:path";

import { FOUNDATION_TRANSACTION_CLEANUP_RESIDUE_PREFIX } from "../../../foundation-state-contract.js";
import type {
  OwnedTemporaryCleanupTransition,
  OwnedTemporaryCleanupTransitionPort
} from "../../../repository-mutation/application/ports/owned-temporary-cleanup-transition.js";
import type { PortablePathIdentity } from "../../../repository-mutation/application/model/path-identity.js";
import {
  captureFileHandleIdentity,
  readBoundedRegularFile
} from "../../../repository-mutation/adapters/node/node-bounded-regular-file.js";
import {
  ensureFoundationStateDirectory,
  syncFoundationStateDirectory
} from "./node-foundation-state-directory.js";

interface CleanupTransitionOperations {
  readonly ensureStateDirectory: typeof ensureFoundationStateDirectory;
  readonly mkdir: typeof mkdir;
  readonly open: (path: string, flags: "wx", mode: number) => Promise<FileHandle>;
  readonly randomToken: () => string;
  readonly readBoundedRegularFile: typeof readBoundedRegularFile;
  readonly rename: typeof rename;
  readonly rm: (path: string) => Promise<void>;
  readonly rmdir: typeof rmdir;
  readonly syncStateDirectory: typeof syncFoundationStateDirectory;
}

const nodeOperations: CleanupTransitionOperations = {
  ensureStateDirectory: ensureFoundationStateDirectory,
  mkdir,
  open,
  randomToken: randomUUID,
  readBoundedRegularFile,
  rename,
  rm: async (path) => rm(path),
  rmdir,
  syncStateDirectory: syncFoundationStateDirectory
};

const markerBytes = Buffer.from("foundation cleanup transition\n", "utf8");

async function createMarker(
  path: string,
  stateDirectory: string,
  operations: CleanupTransitionOperations
): Promise<PortablePathIdentity> {
  const handle = await operations.open(path, "wx", 0o600);
  try {
    await handle.writeFile(markerBytes);
    await handle.sync();
    const identity = await captureFileHandleIdentity(handle);
    await operations.syncStateDirectory(stateDirectory);
    return identity;
  } finally {
    await handle.close();
  }
}

async function assertMarkerAuthority(
  path: string,
  identity: PortablePathIdentity,
  operations: CleanupTransitionOperations
): Promise<void> {
  const observed = await operations.readBoundedRegularFile(
    path,
    markerBytes.byteLength
  );
  if (
    observed.outcome !== "read" ||
    !observed.bytes.equals(markerBytes) ||
    observed.identity.dev !== identity.dev ||
    observed.identity.ino !== identity.ino ||
    observed.identity.birthtimeNs !== identity.birthtimeNs
  ) {
    throw new Error("Foundation cleanup transition marker authority changed.");
  }
}

export function createNodeFoundationCleanupTransition(
  consumerRoot: string,
  token: string,
  operationOverrides?: Partial<CleanupTransitionOperations>
): OwnedTemporaryCleanupTransitionPort {
  if (!/^[a-f0-9]{64}$/u.test(token)) {
    throw new TypeError("Cleanup transition token must be a SHA-256 hex digest.");
  }
  const operations = { ...nodeOperations, ...operationOverrides };
  return {
    async begin(): Promise<OwnedTemporaryCleanupTransition> {
      const stateDirectory = await operations.ensureStateDirectory(consumerRoot);
      const marker = join(
        stateDirectory,
        `${FOUNDATION_TRANSACTION_CLEANUP_RESIDUE_PREFIX}${token}`
      );
      const identity = await createMarker(marker, stateDirectory, operations);
      return {
        async complete(): Promise<void> {
          await assertMarkerAuthority(marker, identity, operations);
          const retirementDirectory = join(
            stateDirectory,
            `${FOUNDATION_TRANSACTION_CLEANUP_RESIDUE_PREFIX}${token}.retired.${operations.randomToken()}`
          );
          await operations.mkdir(retirementDirectory, { mode: 0o700 });
          await operations.syncStateDirectory(stateDirectory);
          await assertMarkerAuthority(marker, identity, operations);
          const retiredMarker = join(retirementDirectory, "marker");
          await operations.rename(marker, retiredMarker);
          await operations.syncStateDirectory(retirementDirectory);
          await operations.syncStateDirectory(stateDirectory);
          await assertMarkerAuthority(retiredMarker, identity, operations);
          await operations.rm(retiredMarker);
          await operations.syncStateDirectory(retirementDirectory);
          await operations.rmdir(retirementDirectory);
          try {
            await operations.syncStateDirectory(stateDirectory);
          } catch (error) {
            // The retirement-directory unlink is not trusted until its parent
            // sync succeeds. Recreate canonical evidence before surfacing the
            // failure so a live coordinator cannot observe a false idle state.
            await createMarker(marker, stateDirectory, operations).catch(() => {});
            throw error;
          }
        }
      };
    }
  };
}
