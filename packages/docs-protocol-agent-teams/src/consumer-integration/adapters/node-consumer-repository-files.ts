import { readBoundedRegularFile } from "@agent-teams/repository-mutation/node";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";

import type { ConsumerIntegrationFileObservation } from "../application-api.js";
import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";

export const MAXIMUM_PROFILE_BYTES = 256 * 1024;
export const MAXIMUM_MANIFEST_BYTES = 1024 * 1024;
export const MAXIMUM_MANAGED_ASSET_BYTES = 8 * 1024 * 1024;
export const MAXIMUM_LOCKFILE_BYTES = 32 * 1024 * 1024;
export const MAXIMUM_WORKSPACE_BYTES = 2 * 1024 * 1024;
export const INTEGRATION_PROFILE_PATH = "architecture/foundation/docs-consumer-integration.json";

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function contained(root: string, repositoryPath: string): string {
  const absolute = resolvePath(root, repositoryPath);
  const relation = relative(root, absolute);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_PATH_ESCAPE",
      `Consumer integration path escapes the repository root: ${repositoryPath}.`,
    );
  }
  return absolute;
}

export async function canonicalConsumerRoot(consumerRoot: string): Promise<string> {
  const requested = resolvePath(consumerRoot);
  let metadata;
  try {
    metadata = await lstat(requested);
  } catch (error) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_ROOT_INVALID",
      "Consumer root is unavailable or is not a real directory.",
      { cause: error },
    );
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_ROOT_INVALID",
      "Consumer root must be one real directory.",
    );
  }
  return realpath(requested);
}

export async function readStableConsumerFile(
  root: string,
  repositoryPath: string,
  maximumBytes: number,
  required: boolean,
): Promise<ConsumerIntegrationFileObservation> {
  const path = contained(root, repositoryPath);
  let observed;
  try {
    observed = await readBoundedRegularFile(path, maximumBytes);
  } catch (error) {
    if (!required && errorCode(error) === "ENOENT") {
      return { state: "absent" };
    }
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_INPUT_MISSING",
      `Required consumer integration input is unavailable: ${repositoryPath}.`,
      { cause: error },
    );
  }
  if (
    observed.outcome === "invalid" ||
    (observed.outcome === "read" && observed.linkCount !== 1n)
  ) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_INPUT_INVALID",
      `Consumer integration input must be one bounded, non-hardlinked regular file: ${repositoryPath}.`,
    );
  }
  if (observed.outcome === "changed") {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_INPUT_UNSTABLE",
      `Consumer integration input changed during observation: ${repositoryPath}.`,
    );
  }
  try {
    const [pathState, canonical] = await Promise.all([
      lstat(path, { bigint: true }),
      realpath(path),
    ]);
    if (
      pathState.isSymbolicLink() ||
      !pathState.isFile() ||
      pathState.nlink !== 1n ||
      canonical !== path ||
      pathState.dev !== observed.identity.dev ||
      pathState.ino !== observed.identity.ino ||
      pathState.birthtimeNs !== observed.identity.birthtimeNs ||
      pathState.size !== BigInt(observed.bytes.byteLength) ||
      Number(pathState.mode) !== observed.mode
    ) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_INPUT_UNSTABLE",
        `Consumer integration input changed during observation: ${repositoryPath}.`,
      );
    }
    return { state: "file", bytes: observed.bytes, mode: observed.mode & 0o777 };
  } catch (error) {
    if (error instanceof ConsumerIntegrationNodeError) {
      throw error;
    }
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_INPUT_UNSTABLE",
      `Consumer integration input changed or became unavailable after observation: ${repositoryPath}.`,
      { cause: error },
    );
  }
}

export function sameConsumerFileObservation(
  left: ConsumerIntegrationFileObservation,
  right: ConsumerIntegrationFileObservation,
): boolean {
  return (
    left.state === right.state &&
    (left.state === "absent" ||
      (right.state === "file" &&
        left.mode === right.mode &&
        Buffer.from(left.bytes).equals(Buffer.from(right.bytes))))
  );
}
