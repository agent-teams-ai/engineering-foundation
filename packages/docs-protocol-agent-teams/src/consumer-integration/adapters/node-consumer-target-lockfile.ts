import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { ConsumerTargetLockfileInput, ConsumerTargetLockfileReader } from "../application/ports/consumer-upgrade.js";
import { externalRestorationPath } from "./node-consumer-restoration-evidence.js";
import type { ConsumerIntegrationDesiredStateV1, ConsumerIntegrationDesiredStateV3 } from "../domain/model.js";
import { assertQualifiedPnpmLockfileV2 } from "./pnpm-lockfile-validator-v2.js";
import { assertRestorationLockScope } from "./node-consumer-restoration-lock.js";
import { MAXIMUM_LOCKFILE_BYTES, readStableConsumerFile } from "./node-consumer-repository-files.js";

// A fixed feature helper: the caller retains this observation, never the pathname.
export async function readConsumerTargetLockfile(
  input: ConsumerTargetLockfileInput, consumerRoot: string
): Promise<Uint8Array> {
  const { path: requestedPath, sha256 } = input;
  if (!/^sha256:[a-f0-9]{64}$/.test(sha256)) {
    throw new TypeError("Target lock SHA256 must be sha256: followed by 64 lowercase hex digits.");
  }
  const path = await externalRestorationPath(requestedPath, await realpath(consumerRoot));
  const initial = await lstat(path, { bigint: true });
  if (!initial.isFile() || initial.isSymbolicLink()) {
    throw new TypeError("Target lock must be a regular file without symlinks.");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK |
    (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n ||
      before.size > BigInt(MAXIMUM_LOCKFILE_BYTES) ||
      initial.dev !== before.dev || initial.ino !== before.ino) {
      throw new TypeError("Target lock must be one bounded, non-hardlinked regular file.");
    }
    // Read at most the observed size plus one, even if a concurrent writer grows it.
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) {break;}
      length += bytesRead;
    }
    const [after, selected, canonical] = await Promise.all([
      handle.stat({ bigint: true }), lstat(path, { bigint: true }), realpath(path)
    ]);
    if (!stableTargetLock(before, after, selected) || canonical !== path || length !== Number(before.size)) {
      throw new TypeError("Target lock changed during observation.");
    }
    const bytes = buffer.subarray(0, length);
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== sha256) {
      throw new TypeError("Target lock SHA256 differs from the selected bytes.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function stableTargetLock(before: BigIntStats, after: BigIntStats, selected: BigIntStats): boolean {
  return !selected.isSymbolicLink() && selected.dev === before.dev && selected.ino === before.ino &&
    before.size === after.size && before.ctimeNs === after.ctimeNs &&
    before.mtimeNs === after.mtimeNs && before.nlink === after.nlink;
}

interface ValidatedTargetLock {
  readonly bytes: Uint8Array;
  readonly desired: ConsumerIntegrationDesiredStateV3;
}

export async function validateConsumerTargetLockfile(
  bytes: Uint8Array | undefined, profile: Uint8Array,
  source: ConsumerIntegrationDesiredStateV1 | ConsumerIntegrationDesiredStateV3, beforeRoot: string
): Promise<ValidatedTargetLock | undefined> {
  if (bytes === undefined) {return undefined;}
  // The normal projector has already schema-validated these exact profile bytes.
  const desired = JSON.parse(Buffer.from(profile).toString("utf8")) as ConsumerIntegrationDesiredStateV1 | ConsumerIntegrationDesiredStateV3;
  if (source.schemaVersion !== 1 || desired.schemaVersion !== 3) {
    throw new TypeError("Target lock requires a 1->2 migration.");
  }
  assertQualifiedPnpmLockfileV2(bytes, desired);
  const original = await readStableConsumerFile(beforeRoot, "pnpm-lock.yaml", MAXIMUM_LOCKFILE_BYTES, true);
  if (original.state !== "file") {throw new Error("unreachable");}
  assertRestorationLockScope(original.bytes, bytes, source, desired);
  return { bytes, desired };
}

export async function verifyConsumerTargetLockfile(
  selected: ValidatedTargetLock | undefined, stagedRoot: string
): Promise<void> {
  if (selected === undefined) {return;}
  const installed = await readStableConsumerFile(stagedRoot, "pnpm-lock.yaml", MAXIMUM_LOCKFILE_BYTES, true);
  if (installed.state !== "file" || !Buffer.from(selected.bytes).equals(Buffer.from(installed.bytes))) {
    throw new TypeError("Selected target lock bytes changed during installation or target apply.");
  }
  assertQualifiedPnpmLockfileV2(installed.bytes, selected.desired);
}

export const nodeConsumerTargetLockfileReader: ConsumerTargetLockfileReader =
  Object.freeze({ read: readConsumerTargetLockfile });
