import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";

import type {
  ConsumerIntegrationFileObservation
} from "../domain/model.js";
import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";

export const MAXIMUM_PROFILE_BYTES = 256 * 1024;
export const MAXIMUM_MANIFEST_BYTES = 1024 * 1024;
export const MAXIMUM_MANAGED_ASSET_BYTES = 8 * 1024 * 1024;
export const MAXIMUM_LOCKFILE_BYTES = 32 * 1024 * 1024;
export const MAXIMUM_WORKSPACE_BYTES = 2 * 1024 * 1024;
export const INTEGRATION_PROFILE_PATH =
  "architecture/foundation/docs-consumer-integration.json";

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
      `Consumer integration path escapes the repository root: ${repositoryPath}.`
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
      { cause: error }
    );
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_ROOT_INVALID",
      "Consumer root must be one real directory."
    );
  }
  return realpath(requested);
}

export async function readStableConsumerFile(
  root: string,
  repositoryPath: string,
  maximumBytes: number,
  required: boolean
): Promise<ConsumerIntegrationFileObservation> {
  const path = contained(root, repositoryPath);
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)
    );
  } catch (error) {
    if (!required && errorCode(error) === "ENOENT") {return { state: "absent" };}
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_INPUT_MISSING",
      `Required consumer integration input is unavailable: ${repositoryPath}.`,
      { cause: error }
    );
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink > 1n || before.size > BigInt(maximumBytes)) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_INPUT_INVALID",
        `Consumer integration input must be one bounded, non-hardlinked regular file: ${repositoryPath}.`
      );
    }
    const bytes = await handle.readFile();
    const [after, pathState, canonical] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
      realpath(path)
    ]);
    if (pathState.isSymbolicLink() || canonical !== path ||
      before.dev !== after.dev || before.ino !== after.ino ||
      before.birthtimeNs !== after.birthtimeNs || before.ctimeNs !== after.ctimeNs ||
      before.mtimeNs !== after.mtimeNs || before.size !== after.size ||
      pathState.dev !== after.dev || pathState.ino !== after.ino ||
      bytes.byteLength !== Number(after.size)) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_INPUT_UNSTABLE",
        `Consumer integration input changed during observation: ${repositoryPath}.`
      );
    }
    return { state: "file", bytes, mode: Number(after.mode) & 0o777 };
  } finally {
    await handle.close();
  }
}

export function sameConsumerFileObservation(
  left: ConsumerIntegrationFileObservation,
  right: ConsumerIntegrationFileObservation
): boolean {
  return left.state === right.state && (left.state === "absent" ||
    (right.state === "file" && left.mode === right.mode &&
      Buffer.from(left.bytes).equals(Buffer.from(right.bytes))));
}
