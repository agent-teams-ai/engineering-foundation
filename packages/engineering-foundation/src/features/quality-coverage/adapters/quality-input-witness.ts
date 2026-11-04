import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  CapabilityInputError,
  assertNotCancelled,
  type QualityFileReader,
  type QualityObservationPorts,
} from "../api.js";

export const QUALITY_INPUT_LIMITS = Object.freeze({
  files: 100_000,
  uniqueBytes: 512 * 1024 * 1024,
  fileBytes: 16 * 1024 * 1024,
  readBytes: 2 * 1024 * 1024 * 1024,
  concurrency: 8,
});

type FileRequest = Parameters<QualityFileReader>[0];
interface Fingerprint {
  readonly request: FileRequest;
  readonly digest: string;
}
export interface QualityResolutionBinding {
  readonly issuer: string;
  readonly request: string;
  readonly target: string;
  readonly logicalTarget: string;
  readonly aliases: readonly { readonly path: string; readonly target: string | null }[];
}

interface QualityInputWitness {
  readonly read: QualityFileReader;
  readonly readToolFile: QualityFileReader;
  readonly retirementBudget: {
    beforeRead(requestedMaxBytes: number): number;
    afterRead(actualOrConservativeBytes: number): void;
    checkpoint(): void;
  };
  remainingMs(): number;
  setBudget(value: number): void;
  bindResolution(binding: QualityResolutionBinding): Promise<void>;
  capture(reader: QualityObservationPorts["census"]): Promise<void>;
  verify(signal?: AbortSignal): Promise<void>;
}

function reject(message: string): never {
  throw new CapabilityInputError({
    code: "QUALITY_INPUT_CHANGED",
    message,
    phase: "quality-inputs",
    retryable: false,
  });
}

export function qualityInputDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function createQualityReadBudget(
  readFile: QualityFileReader,
  signal: AbortSignal | undefined,
  nowMs: () => number,
) {
  const started = nowMs();
  let budgetMs = 1_800_000;
  let readBytes = 0;
  let reservedBytes = 0;
  let activeReads = 0;
  const waitingReads: (() => void)[] = [];
  const waitingReadBytes: (() => void)[] = [];
  const retirementGrants: number[] = [];
  const remainingMs = (): number => {
    assertNotCancelled(signal);
    const remaining = Math.floor(started + budgetMs - nowMs());
    if (remaining <= 0) {
      reject("The original quality invocation budget was exhausted.");
    }
    return remaining;
  };
  const chargeRead: QualityFileReader = async (request) => {
    remainingMs();
    if (activeReads >= QUALITY_INPUT_LIMITS.concurrency) {
      await new Promise<void>((_resolve) => {
        waitingReads.push(_resolve);
      });
    } else {
      activeReads += 1;
    }
    try {
      return await boundedRead(request);
    } finally {
      const resume = waitingReads.shift();
      if (resume === undefined) {
        activeReads -= 1;
      } else {
        resume();
      }
    }
  };
  const readReservationPending = (maximum: number): boolean =>
    reservedBytes > 0 && QUALITY_INPUT_LIMITS.readBytes - readBytes - reservedBytes < maximum;
  const boundedRead: QualityFileReader = async (request) => {
    remainingMs();
    while (readReservationPending(request.maxBytes)) {
      await new Promise<void>((_resolve) => {
        waitingReadBytes.push(_resolve);
      });
      remainingMs();
    }
    const remaining = QUALITY_INPUT_LIMITS.readBytes - readBytes - reservedBytes;
    if (remaining <= 0) {
      reject("Quality cumulative input read budget exceeded.");
    }
    const maxBytes = Math.min(request.maxBytes, remaining);
    reservedBytes += maxBytes;
    try {
      const bytes = await readFile({ ...request, maxBytes });
      if (bytes.byteLength > maxBytes) {
        reject("Quality input exceeded its bounded read request.");
      }
      readBytes += bytes.byteLength;
      if (readBytes > QUALITY_INPUT_LIMITS.readBytes) {
        reject("Quality cumulative input read budget exceeded.");
      }
      remainingMs();
      return bytes;
    } catch (error) {
      assertNotCancelled(signal);
      if (error instanceof CapabilityInputError) {
        throw error;
      }
      reject(
        "A quality input is missing, unreadable, oversized or no longer a contained regular file.",
      );
    } finally {
      reservedBytes -= maxBytes;
      for (const resume of waitingReadBytes.splice(0)) {
        resume();
      }
    }
  };
  const retirementBudget = {
    checkpoint: () => {
      remainingMs();
    },
    beforeRead(requestedMaxBytes: number): number {
      remainingMs();
      const grant = Math.min(
        requestedMaxBytes,
        QUALITY_INPUT_LIMITS.readBytes - readBytes - reservedBytes,
      );
      if (grant <= 0) {
        reject("Quality cumulative input read budget exceeded.");
      }
      reservedBytes += grant;
      retirementGrants.push(grant);
      return grant;
    },
    afterRead(actualOrConservativeBytes: number): void {
      const grant = retirementGrants.shift();
      if (
        grant === undefined ||
        actualOrConservativeBytes < 0 ||
        actualOrConservativeBytes > grant
      ) {
        reject("Retirement observation exceeded its quality read grant.");
      }
      reservedBytes -= grant;
      readBytes += actualOrConservativeBytes;
      for (const resume of waitingReadBytes.splice(0)) {
        resume();
      }
      remainingMs();
    },
  };
  return {
    read: chargeRead,
    retirementBudget,
    remainingMs,
    setBudget(value: number) {
      budgetMs = value;
      remainingMs();
    },
  };
}

function createQualityFingerprints(root: string, chargeRead: QualityFileReader) {
  let uniqueBytes = 0;
  let reservedUniqueBytes = 0;
  const pendingPaths = new Set<string>();
  const waitingUniqueReads: (() => void)[] = [];
  const fingerprints = new Map<string, Fingerprint>();
  const uniqueReservationPending = (isNew: boolean, maximum: number): boolean =>
    isNew &&
    reservedUniqueBytes > 0 &&
    QUALITY_INPUT_LIMITS.uniqueBytes - uniqueBytes - reservedUniqueBytes < maximum;
  const read: QualityFileReader = async (request) => {
    const candidate = resolve(request.candidate);
    const suffix = relative(root, candidate);
    if (
      suffix === ".." ||
      suffix.startsWith("../") ||
      suffix.startsWith("..\\") ||
      isAbsolute(suffix)
    ) {
      reject("Quality inputs must remain inside the consumer.");
    }
    const isNew = !fingerprints.has(candidate) && !pendingPaths.has(candidate);
    if (isNew && fingerprints.size + pendingPaths.size >= QUALITY_INPUT_LIMITS.files) {
      reject("Quality unique input file budget exceeded.");
    }
    // A provisional maximum is not an observed byte count. Wait for outstanding
    // reads before shrinking a valid final file to a temporarily unavailable budget.
    while (uniqueReservationPending(isNew, request.maxBytes)) {
      await new Promise<void>((_resolve) => {
        waitingUniqueReads.push(_resolve);
      });
    }
    const available = QUALITY_INPUT_LIMITS.uniqueBytes - uniqueBytes - reservedUniqueBytes;
    if (isNew && available <= 0) {
      reject("Quality unique input byte budget exceeded.");
    }
    const allowance = isNew ? Math.min(request.maxBytes, available) : request.maxBytes;
    if (isNew) {
      pendingPaths.add(candidate);
      reservedUniqueBytes += allowance;
    }
    try {
      const bytes = await chargeRead({ ...request, maxBytes: allowance });
      const digest = qualityInputDigest(bytes);
      const previous = fingerprints.get(candidate);
      if (previous !== undefined) {
        if (previous.digest !== digest) {
          reject("A consumer input changed during quality observation or execution.");
        }
      } else {
        uniqueBytes += bytes.byteLength;
        if (uniqueBytes > QUALITY_INPUT_LIMITS.uniqueBytes) {
          reject("Quality unique input byte budget exceeded.");
        }
        fingerprints.set(candidate, { request: { ...request }, digest });
      }
      return bytes;
    } finally {
      if (isNew) {
        pendingPaths.delete(candidate);
        reservedUniqueBytes -= allowance;
        for (const resume of waitingUniqueReads.splice(0)) {
          resume();
        }
      }
    }
  };

  return { read, fingerprints };
}

interface QualityAlias {
  readonly path: string;
  readonly target: string | null;
}

async function observeQualityAliases(
  root: string,
  binding: QualityResolutionBinding,
): Promise<readonly QualityAlias[]> {
  const paths = [...binding.aliases.map(({ path }) => path), binding.logicalTarget];
  const aliases: QualityAlias[] = [];
  for (const path of paths) {
    const suffix = relative(root, path);
    if (
      suffix === ".." ||
      suffix.startsWith("../") ||
      suffix.startsWith("..\\") ||
      isAbsolute(suffix)
    ) {
      continue;
    }
    try {
      aliases.push({ path, target: await realpath(path) });
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        aliases.push({ path, target: null });
      } else {
        reject("A protected lint resolution alias cannot be observed.");
      }
    }
  }
  return aliases;
}

/** Private invocation resource; ownership ends when its check returns. */
export function createQualityInputWitness(
  root: string,
  readFile: QualityFileReader,
  signal?: AbortSignal,
  nowMs: () => number = () => performance.now(),
): QualityInputWitness {
  const budget = createQualityReadBudget(readFile, signal, nowMs);
  const { remainingMs } = budget;
  const files = createQualityFingerprints(root, budget.read);
  const { read } = files;
  const bindings: QualityResolutionBinding[] = [];
  let observedPaths: readonly string[] | undefined;
  let census: QualityObservationPorts["census"] | undefined;
  let snapshots = 0;
  const readAll = async (requests: readonly FileRequest[]): Promise<void> => {
    for (let index = 0; index < requests.length; index += QUALITY_INPUT_LIMITS.concurrency) {
      remainingMs();
      await Promise.all(requests.slice(index, index + QUALITY_INPUT_LIMITS.concurrency).map(read));
    }
  };
  const snapshot = async (
    reader: QualityObservationPorts["census"],
  ): Promise<readonly string[]> => {
    remainingMs();
    if (++snapshots > 3) {
      reject("Quality invocation exceeded its three-snapshot contract.");
    }
    const current = await reader.read({
      consumerRoot: root,
      roots: ["."],
      generatedDirectories: "observe",
      maxFiles: QUALITY_INPUT_LIMITS.files,
      ...(signal === undefined ? {} : { signal }),
    });
    if (current.filePaths.length > QUALITY_INPUT_LIMITS.files) {
      reject("Quality census file budget exceeded.");
    }
    const paths = [...current.filePaths].toSorted();
    if (new Set(paths).size !== paths.length) {
      reject("Quality census contains duplicate paths.");
    }
    if (
      observedPaths !== undefined &&
      (paths.length !== observedPaths.length ||
        paths.some((path, index) => path !== observedPaths?.[index]))
    ) {
      reject("The consumer input inventory changed during the quality invocation.");
    }
    await readAll(
      paths.map((path) => ({
        root,
        candidate: join(root, path),
        maxBytes: QUALITY_INPUT_LIMITS.fileBytes,
      })),
    );
    remainingMs();
    return paths;
  };

  return {
    read,
    readToolFile: budget.read,
    retirementBudget: budget.retirementBudget,
    remainingMs,
    setBudget: (value) => {
      budget.setBudget(value);
    },
    async bindResolution(binding: QualityResolutionBinding) {
      remainingMs();
      const aliases = await observeQualityAliases(root, binding);
      const expected = [
        ...binding.aliases,
        { path: binding.logicalTarget, target: binding.target },
      ];
      if (JSON.stringify(aliases) !== JSON.stringify(expected)) {
        reject("Installed lint configuration aliases changed during initial observation.");
      }
      bindings.push(
        Object.freeze({
          ...binding,
          aliases: Object.freeze(binding.aliases.map((alias) => Object.freeze({ ...alias }))),
        }),
      );
      remainingMs();
    },
    async capture(reader: QualityObservationPorts["census"]) {
      if (census !== undefined) {
        reject("Quality inputs were captured more than once.");
      }
      census = reader;
      observedPaths = await snapshot(reader);
    },
    async verify(verificationSignal?: AbortSignal) {
      assertNotCancelled(verificationSignal);
      if (census === undefined) {
        reject("Quality input verification requires an initial capture.");
      }
      const paths = await snapshot(census);
      const ordinary = new Set(paths.map((path) => join(root, path)));
      const extra = [...files.fingerprints]
        .filter(([path]) => !ordinary.has(path))
        .map(([, value]) => value.request);
      await readAll(extra);
      for (const binding of bindings) {
        remainingMs();
        try {
          const observed = await observeQualityAliases(root, binding);
          const expected = [
            ...binding.aliases,
            { path: binding.logicalTarget, target: binding.target },
          ];
          if (JSON.stringify(observed) !== JSON.stringify(expected)) {
            reject("Installed lint configuration aliases changed during the invocation.");
          }
          const current = await realpath(binding.logicalTarget);
          if (current !== binding.target) {
            reject("Installed lint configuration resolution changed during the invocation.");
          }
        } catch (error) {
          if (error instanceof CapabilityInputError) {
            throw error;
          }
          reject("Installed lint configuration resolution is no longer available.");
        }
      }
      assertNotCancelled(verificationSignal);
      remainingMs();
    },
  };
}
