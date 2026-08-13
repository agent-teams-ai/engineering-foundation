import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { TextDecoder } from "node:util";

import { FoundationError } from "../../../errors.js";
import { LOCAL_OPERATION_LOCK } from "../../../foundation-state-contract.js";
import { parseStrictJson } from "../../../strict-json.js";
import { readBoundedRegularFile } from "../../../repository-mutation/adapters/node/node-bounded-regular-file.js";
import type { PortablePathIdentity } from "../../../repository-mutation/application/model/path-identity.js";
import type {
  FoundationOperationLock,
  FoundationOperationReleaseOptions
} from "../../application/ports/foundation-operation-lock.js";
import {
  ensureFoundationStateDirectory,
  syncFoundationStateDirectory
} from "./node-foundation-state-directory.js";

const maximumLockBytes = 8 * 1024;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

interface ActiveOwner {
  readonly host: string;
  readonly kind: "active";
  readonly pid: number;
  readonly schemaVersion: 1;
  readonly token: string;
}

interface TransactionBarrier {
  readonly kind: "transaction-barrier";
  readonly schemaVersion: 1;
  readonly token: string;
}

type LockEvidence = ActiveOwner | TransactionBarrier;

interface OwnedLock {
  readonly evidence: ActiveOwner;
  readonly identity: PortablePathIdentity;
}

interface OperationLockOperations {
  readonly faultInjector?: (point: {
    readonly path: string;
    readonly phase: "after-release-retirement";
  }) => Promise<void> | void;
  readonly retirementToken?: () => string;
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function evidenceBytes(evidence: LockEvidence): Buffer {
  return Buffer.from(`${JSON.stringify(evidence)}\n`, "utf8");
}

function parseEvidence(value: unknown): LockEvidence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Foundation operation lock evidence is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  const tokenIsValid =
    typeof candidate["token"] === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      candidate["token"]
    );
  if (
    candidate["schemaVersion"] === 1 &&
    candidate["kind"] === "transaction-barrier" &&
    tokenIsValid &&
    Object.keys(candidate).toSorted().join(",") === "kind,schemaVersion,token"
  ) {
    return {
      kind: "transaction-barrier",
      schemaVersion: 1,
      token: candidate["token"] as string
    };
  }
  if (
    candidate["schemaVersion"] !== 1 ||
    candidate["kind"] !== "active" ||
    !tokenIsValid ||
    typeof candidate["host"] !== "string" ||
    candidate["host"].length === 0 ||
    !Number.isSafeInteger(candidate["pid"]) ||
    (candidate["pid"] as number) <= 0 ||
    Object.keys(candidate).toSorted().join(",") !==
      "host,kind,pid,schemaVersion,token"
  ) {
    throw new Error("Foundation operation lock evidence is invalid.");
  }
  return {
    host: candidate["host"],
    kind: "active",
    pid: candidate["pid"] as number,
    schemaVersion: 1,
    token: candidate["token"] as string
  };
}

async function readLock(path: string): Promise<{
  readonly evidence: LockEvidence;
  readonly identity: PortablePathIdentity;
}> {
  const record = await readBoundedRegularFile(path, maximumLockBytes);
  if (record.outcome !== "read") {
    throw new Error(
      "Foundation operation lock must be a stable bounded regular file."
    );
  }
  return {
    evidence: parseEvidence(parseStrictJson(strictUtf8.decode(record.bytes))),
    identity: record.identity
  };
}

function identitiesEqual(
  left: PortablePathIdentity,
  right: PortablePathIdentity
): boolean {
  return (
    left.birthtimeNs === right.birthtimeNs &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function evidenceEqual(left: LockEvidence, right: LockEvidence): boolean {
  if (left.kind !== right.kind || left.token !== right.token) {
    return false;
  }
  return left.kind === "transaction-barrier" ||
    right.kind === "transaction-barrier"
    ? left.kind === right.kind
    : left.host === right.host && left.pid === right.pid;
}

async function readHandleEvidence(
  handle: FileHandle,
  expectedIdentity: PortablePathIdentity
): Promise<LockEvidence> {
  const before = await handle.stat({ bigint: true });
  if (
    !before.isFile() ||
    before.size > BigInt(maximumLockBytes) ||
    !identitiesEqual(
      {
        birthtimeNs: before.birthtimeNs,
        dev: before.dev,
        ino: before.ino
      },
      expectedIdentity
    )
  ) {
    throw new Error("Foundation operation lock identity changed before rewrite.");
  }
  const bytes = Buffer.alloc(Number(before.size));
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesRead } = await handle.read(
      bytes,
      offset,
      bytes.byteLength - offset,
      offset
    );
    if (bytesRead === 0) {
      throw new Error("Foundation operation lock was truncated before rewrite.");
    }
    offset += bytesRead;
  }
  const after = await handle.stat({ bigint: true });
  if (
    before.birthtimeNs !== after.birthtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mtimeNs !== after.mtimeNs ||
    before.size !== after.size
  ) {
    throw new Error("Foundation operation lock changed during rewrite verification.");
  }
  return parseEvidence(parseStrictJson(strictUtf8.decode(bytes)));
}

async function rewriteOwnedLockEvidence(
  lockPath: string,
  expected: Awaited<ReturnType<typeof readLock>>,
  replacement: LockEvidence
): Promise<PortablePathIdentity> {
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const handle = await open(lockPath, constants.O_RDWR | noFollow);
  try {
    const current = await readHandleEvidence(handle, expected.identity);
    if (!evidenceEqual(current, expected.evidence)) {
      throw new Error("Foundation operation lock ownership changed before rewrite.");
    }
    const bytes = evidenceBytes(replacement);
    await handle.truncate(0);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset
      );
      if (bytesWritten === 0) {
        throw new Error("Foundation operation lock rewrite made no progress.");
      }
      offset += bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  const observed = await readLock(lockPath);
  if (
    !evidenceEqual(observed.evidence, replacement) ||
    !identitiesEqual(observed.identity, expected.identity)
  ) {
    throw new Error("Foundation operation lock rewrite was not published.");
  }
  return observed.identity;
}

function activeOwnerIsAlive(owner: ActiveOwner): boolean | undefined {
  if (owner.host !== hostname()) {
    return undefined;
  }
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return isErrorCode(error, "ESRCH") ? false : undefined;
  }
}

async function createOwnedLock(
  directory: string,
  lockPath: string
): Promise<OwnedLock> {
  const evidence: ActiveOwner = {
    host: hostname(),
    kind: "active",
    pid: process.pid,
    schemaVersion: 1,
    token: randomUUID()
  };
  const handle = await open(lockPath, "wx", 0o600);
  try {
    await handle.writeFile(evidenceBytes(evidence));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncFoundationStateDirectory(directory);
  const observed = await readLock(lockPath);
  if (
    observed.evidence.kind !== "active" ||
    observed.evidence.token !== evidence.token
  ) {
    throw new Error("Foundation operation lock ownership was not published.");
  }
  return { evidence, identity: observed.identity };
}

async function takeoverLock(
  directory: string,
  lockPath: string
): Promise<OwnedLock> {
  const expected = await readLock(lockPath);
  if (
    expected.evidence.kind === "active" &&
    activeOwnerIsAlive(expected.evidence) !== false
  ) {
    throw new Error(
      "Foundation operation lock owner is live or cannot be proven dead."
    );
  }
  const evidence: ActiveOwner = {
    host: hostname(),
    kind: "active",
    pid: process.pid,
    schemaVersion: 1,
    token: randomUUID()
  };
  const claimPath = `${lockPath}.claim.${expected.evidence.token}`;
  let claimHeld = false;
  let ownershipPublished = false;
  try {
    try {
      const claimHandle = await open(claimPath, "wx", 0o600);
      try {
        await claimHandle.writeFile(evidenceBytes(evidence));
        await claimHandle.sync();
      } finally {
        await claimHandle.close();
      }
      await syncFoundationStateDirectory(directory);
      claimHeld = true;
    } catch (error) {
      if (isErrorCode(error, "EEXIST")) {
        throw new Error(
          "Foundation operation-lock takeover claim requires manual recovery.",
          { cause: error }
        );
      }
      throw error;
    }
    const observed = await readLock(lockPath);
    if (
      !evidenceEqual(observed.evidence, expected.evidence) ||
      !identitiesEqual(observed.identity, expected.identity)
    ) {
      throw new Error("Foundation operation lock changed during takeover.");
    }
    const rewrittenIdentity = await rewriteOwnedLockEvidence(
      lockPath,
      observed,
      evidence
    );
    await syncFoundationStateDirectory(directory);
    const current = await readLock(lockPath);
    if (
      current.evidence.kind !== "active" ||
      current.evidence.token !== evidence.token ||
      !identitiesEqual(current.identity, rewrittenIdentity)
    ) {
      throw new Error("Foundation operation-lock takeover was not published.");
    }
    ownershipPublished = true;
    return { evidence, identity: current.identity };
  } finally {
    if (claimHeld) {
      await unlink(claimPath).catch((error: unknown) => {
        if (!ownershipPublished && !isErrorCode(error, "ENOENT")) {
          throw error;
        }
      });
    }
  }
}

async function quarantineObservedLock(
  directory: string,
  lockPath: string,
  observed: Awaited<ReturnType<typeof readLock>>,
  phase: "recovered" | "released",
  operations: OperationLockOperations = {}
): Promise<string> {
  const retirementToken = operations.retirementToken?.() ?? randomUUID();
  const quarantineDirectory =
    `${lockPath}.${phase}.${observed.evidence.token}.${retirementToken}`;
  try {
    await mkdir(quarantineDirectory, { mode: 0o700 });
  } catch (error) {
    throw new Error(
      "Foundation operation lock retirement destination is occupied; all evidence was preserved.",
      { cause: error }
    );
  }
  await syncFoundationStateDirectory(directory);
  const quarantinePath = join(quarantineDirectory, "evidence");
  await rename(lockPath, quarantinePath);
  await syncFoundationStateDirectory(quarantineDirectory);
  await syncFoundationStateDirectory(directory);
  if (phase === "released") {
    await operations.faultInjector?.({
      path: quarantinePath,
      phase: "after-release-retirement"
    });
  }
  const quarantined = await readLock(quarantinePath);
  if (
    quarantined.evidence.token !== observed.evidence.token ||
    !identitiesEqual(quarantined.identity, observed.identity)
  ) {
    throw new Error("Foundation operation lock ownership changed during cleanup.");
  }
  return quarantinePath;
}

async function retainTransactionBarrier(
  directory: string,
  lockPath: string,
  owned: OwnedLock
): Promise<void> {
  const current = await readLock(lockPath);
  if (
    current.evidence.kind !== "active" ||
    current.evidence.token !== owned.evidence.token ||
    !identitiesEqual(current.identity, owned.identity)
  ) {
    throw new Error("Foundation operation lock ownership changed before retention.");
  }
  const barrier: TransactionBarrier = {
    kind: "transaction-barrier",
    schemaVersion: 1,
    token: owned.evidence.token
  };
  const beforePublish = await readLock(lockPath);
  if (
    beforePublish.evidence.kind !== "active" ||
    beforePublish.evidence.token !== owned.evidence.token ||
    !identitiesEqual(beforePublish.identity, owned.identity)
  ) {
    throw new Error("Foundation operation lock ownership changed during retention.");
  }
  await rewriteOwnedLockEvidence(lockPath, beforePublish, barrier);
  await syncFoundationStateDirectory(directory);
}

export class NodeFoundationOperationLock implements FoundationOperationLock {
  readonly #consumerRoot: string;
  readonly #operations: OperationLockOperations;

  constructor(consumerRoot: string, operations: OperationLockOperations = {}) {
    this.#consumerRoot = consumerRoot;
    this.#operations = operations;
  }

  async acquire(): Promise<
    (options?: FoundationOperationReleaseOptions) => Promise<void>
  > {
    const directory = await ensureFoundationStateDirectory(this.#consumerRoot);
    const lockPath = join(directory, LOCAL_OPERATION_LOCK);
    let owned: OwnedLock;
    try {
      try {
        owned = await createOwnedLock(directory, lockPath);
      } catch (error) {
        if (!isErrorCode(error, "EEXIST")) {
          throw error;
        }
        owned = await takeoverLock(directory, lockPath);
      }
    } catch (error) {
      throw new FoundationError(
        "LOCAL_STATE_INVALID",
        "Another foundation operation is active or its lock is not safely recoverable.",
        { cause: error }
      );
    }

    let state: "held" | "released" = "held";
    let releaseInProgress: Promise<void> | undefined;
    return async (options = {}) => {
      if (state === "released") {
        return;
      }
      releaseInProgress ??= (async () => {
        try {
          if (options.retainTransactionBarrier === true) {
            await retainTransactionBarrier(directory, lockPath, owned);
            state = "released";
            await syncFoundationStateDirectory(directory);
            return;
          }
          const current = await readLock(lockPath);
          if (
            current.evidence.kind !== "active" ||
            current.evidence.token !== owned.evidence.token ||
            !identitiesEqual(current.identity, owned.identity)
          ) {
            throw new Error("Foundation operation lock ownership was lost before release.");
          }
          const quarantinePath = await quarantineObservedLock(
            directory,
            lockPath,
            current,
            "released",
            this.#operations
          );
          state = "released";
          // The verified evidence is logically retired inside a fresh 0700
          // directory. Node has no unlink-by-handle primitive, so retaining it
          // avoids a pathname proof-to-delete race with foreign substitution.
          void quarantinePath;
        } catch (error) {
          throw new FoundationError(
            "LOCAL_STATE_INVALID",
            "Foundation operation lock could not be released without violating ownership.",
            { cause: error }
          );
        }
      })();
      try {
        await releaseInProgress;
      } catch (error) {
        releaseInProgress = undefined;
        throw error;
      }
    };
  }
}
