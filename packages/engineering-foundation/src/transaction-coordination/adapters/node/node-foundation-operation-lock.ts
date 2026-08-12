import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { TextDecoder } from "node:util";

import { FoundationError } from "../../../errors.js";
import { LOCAL_OPERATION_LOCK } from "../../../foundation-state-contract.js";
import { parseStrictJson } from "../../../strict-json.js";
import {
  readBoundedRegularFile,
  type PortableFileIdentity
} from "../../../scaffolding/adapters/node/filesystem-file-identity.js";
import type {
  FoundationOperationLock,
  FoundationOperationReleaseOptions
} from "../../application/ports/foundation-operation-lock.js";
import {
  ensureFoundationStateDirectory,
  pruneFoundationStateDirectory,
  syncFoundationStateDirectory
} from "./node-foundation-state-directory.js";

const maximumLockBytes = 8 * 1024;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

interface ActiveOwner {
  readonly host: string;
  readonly kind: "active";
  readonly pid: number;
  readonly schemaVersion: 2;
  readonly token: string;
}

interface TransactionBarrier {
  readonly kind: "transaction-barrier";
  readonly schemaVersion: 2;
  readonly token: string;
}

type LockEvidence = ActiveOwner | TransactionBarrier;

interface OwnedLock {
  readonly evidence: ActiveOwner;
  readonly identity: PortableFileIdentity;
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
    candidate["schemaVersion"] === 2 &&
    candidate["kind"] === "transaction-barrier" &&
    tokenIsValid &&
    Object.keys(candidate).toSorted().join(",") === "kind,schemaVersion,token"
  ) {
    return {
      kind: "transaction-barrier",
      schemaVersion: 2,
      token: candidate["token"] as string
    };
  }
  if (
    candidate["schemaVersion"] !== 2 ||
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
    schemaVersion: 2,
    token: candidate["token"] as string
  };
}

async function readLock(path: string): Promise<{
  readonly evidence: LockEvidence;
  readonly identity: PortableFileIdentity;
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
  left: PortableFileIdentity,
  right: PortableFileIdentity
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
  expectedIdentity: PortableFileIdentity
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
): Promise<PortableFileIdentity> {
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
    schemaVersion: 2,
    token: randomUUID()
  };
  const preparedPath = `${lockPath}.prepared.${evidence.token}`;
  const handle = await open(preparedPath, "wx", 0o600);
  try {
    await handle.writeFile(evidenceBytes(evidence));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(preparedPath, lockPath);
    await syncFoundationStateDirectory(directory);
  } finally {
    await unlink(preparedPath).catch((error: unknown) => {
      if (!isErrorCode(error, "ENOENT")) {
        throw error;
      }
    });
  }
  const observed = await readLock(lockPath);
  if (
    observed.evidence.kind !== "active" ||
    observed.evidence.token !== evidence.token
  ) {
    throw new Error("Foundation operation lock ownership was not published.");
  }
  return { evidence, identity: observed.identity };
}

async function removeDeadClaim(
  directory: string,
  claimPath: string
): Promise<boolean> {
  let observed;
  try {
    observed = await readLock(claimPath);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return true;
    }
    throw error;
  }
  if (
    observed.evidence.kind !== "active" ||
    activeOwnerIsAlive(observed.evidence) !== false
  ) {
    return false;
  }
  const quarantinePath = `${claimPath}.recovered.${observed.evidence.token}`;
  await rename(claimPath, quarantinePath);
  const quarantined = await readLock(quarantinePath);
  if (
    quarantined.evidence.token !== observed.evidence.token ||
    !identitiesEqual(quarantined.identity, observed.identity)
  ) {
    throw new Error("Foundation operation-lock claim changed during recovery.");
  }
  await unlink(quarantinePath);
  await syncFoundationStateDirectory(directory);
  return true;
}

async function takeoverLock(
  directory: string,
  lockPath: string
): Promise<OwnedLock> {
  const evidence: ActiveOwner = {
    host: hostname(),
    kind: "active",
    pid: process.pid,
    schemaVersion: 2,
    token: randomUUID()
  };
  const preparedPath = `${lockPath}.prepared.${evidence.token}`;
  const claimPath = `${lockPath}.claim`;
  const handle = await open(preparedPath, "wx", 0o600);
  try {
    await handle.writeFile(evidenceBytes(evidence));
    await handle.sync();
  } finally {
    await handle.close();
  }
  let claimHeld = false;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await link(preparedPath, claimPath);
        claimHeld = true;
        break;
      } catch (error) {
        if (!isErrorCode(error, "EEXIST") || !(await removeDeadClaim(directory, claimPath))) {
          throw error;
        }
      }
    }
    if (!claimHeld) {
      throw new Error("Foundation operation-lock takeover claim is unavailable.");
    }
    const observed = await readLock(lockPath);
    if (
      observed.evidence.kind === "active" &&
      activeOwnerIsAlive(observed.evidence) !== false
    ) {
      throw new Error(
        "Foundation operation lock owner is live or cannot be proven dead."
      );
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
    await unlink(claimPath);
    claimHeld = false;
    return { evidence, identity: current.identity };
  } finally {
    await unlink(preparedPath).catch((error: unknown) => {
      if (!isErrorCode(error, "ENOENT")) {
        throw error;
      }
    });
    if (claimHeld) {
      await unlink(claimPath).catch((error: unknown) => {
        if (!isErrorCode(error, "ENOENT")) {
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
  phase: "recovered" | "released"
): Promise<string> {
  const quarantinePath = `${lockPath}.${phase}.${observed.evidence.token}`;
  await rename(lockPath, quarantinePath);
  const quarantined = await readLock(quarantinePath);
  if (
    quarantined.evidence.token !== observed.evidence.token ||
    !identitiesEqual(quarantined.identity, observed.identity)
  ) {
    throw new Error("Foundation operation lock ownership changed during cleanup.");
  }
  await syncFoundationStateDirectory(directory);
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
    schemaVersion: 2,
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

  constructor(consumerRoot: string) {
    this.#consumerRoot = consumerRoot;
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
    return async (options = {}) => {
      if (state === "released") {
        return;
      }
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
          "released"
        );
        state = "released";
        await unlink(quarantinePath);
        await syncFoundationStateDirectory(directory);
        await pruneFoundationStateDirectory(this.#consumerRoot);
        await syncFoundationStateDirectory(this.#consumerRoot);
      } catch (error) {
        throw new FoundationError(
          "LOCAL_STATE_INVALID",
          "Foundation operation lock could not be released without violating ownership.",
          { cause: error }
        );
      }
    };
  }
}
