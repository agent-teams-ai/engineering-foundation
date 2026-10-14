/** Feature-private inventory and preimage capture; no package export or graph node. */
import { createHash } from "node:crypto";
import { readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

import type {
  KnownFileTransactionOperationInput
} from "@agent-teams/repository-mutation";

import {
  MAXIMUM_INVENTORY_BYTES,
  MAXIMUM_INVENTORY_FILE_BYTES,
  MAXIMUM_INVENTORY_FILES
} from "./node-consumer-upgrade-archive.js";
import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";
import {
  INTEGRATION_PROFILE_PATH,
  MAXIMUM_LOCKFILE_BYTES,
  MAXIMUM_MANAGED_ASSET_BYTES,
  MAXIMUM_MANIFEST_BYTES,
  MAXIMUM_PROFILE_BYTES,
  MAXIMUM_WORKSPACE_BYTES,
  readStableConsumerFile
} from "./node-consumer-repository-files.js";

export const WORKSPACE_PATH = "pnpm-workspace.yaml";

interface InventoryEntry {
  readonly digest: string;
  readonly kind: "file" | "symlink";
}

function ignoredInventoryPath(prefix: string, name: string): boolean {
  return name === "node_modules" ||
    (prefix === "" && (name === ".git" || name === ".agent-teams-local"));
}

export async function repositoryInventory(root: string): Promise<Map<string, InventoryEntry>> {
  const output = new Map<string, InventoryEntry>();
  let totalBytes = 0;
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.toSorted((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    )) {
      if (ignoredInventoryPath(prefix, entry.name)) {continue;}
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute, path);
        continue;
      }
      if (output.size >= MAXIMUM_INVENTORY_FILES) {
        throw new ConsumerIntegrationNodeError(
          "DOCS_CONSUMER_UPGRADE_REPOSITORY_TOO_LARGE",
          "Disposable consumer inventory exceeds the bounded file count."
        );
      }
      if (entry.isSymbolicLink()) {
        const target = await readlink(absolute);
        output.set(path, {
          kind: "symlink",
          digest: createHash("sha256").update(target).digest("hex")
        });
        continue;
      }
      if (!entry.isFile()) {
        throw new ConsumerIntegrationNodeError(
          "DOCS_CONSUMER_UPGRADE_INPUT_INVALID",
          `Disposable consumer contains unsupported filesystem evidence: ${path}.`
        );
      }
      const observation = await readStableConsumerFile(
        root,
        path,
        MAXIMUM_INVENTORY_FILE_BYTES,
        true
      );
      if (observation.state !== "file") {throw new Error("unreachable");}
      totalBytes += observation.bytes.byteLength;
      if (totalBytes > MAXIMUM_INVENTORY_BYTES) {
        throw new ConsumerIntegrationNodeError(
          "DOCS_CONSUMER_UPGRADE_REPOSITORY_TOO_LARGE",
          "Disposable consumer inventory exceeds the bounded byte count."
        );
      }
      output.set(path, {
        kind: "file",
        digest: createHash("sha256").update(observation.bytes).digest("hex")
      });
    }
  }
  await visit(root, "");
  return output;
}

export function changedInventoryPaths(
  before: ReadonlyMap<string, InventoryEntry>,
  after: ReadonlyMap<string, InventoryEntry>
): readonly string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => {
    const left = before.get(path);
    const right = after.get(path);
    return left?.kind !== right?.kind || left?.digest !== right?.digest;
  }).toSorted();
}

function maximumBytes(path: string): number {
  if (path === INTEGRATION_PROFILE_PATH) {return MAXIMUM_PROFILE_BYTES;}
  if (path === "package.json") {return MAXIMUM_MANIFEST_BYTES;}
  if (path === "pnpm-lock.yaml") {return MAXIMUM_LOCKFILE_BYTES;}
  if (path === WORKSPACE_PATH) {return MAXIMUM_WORKSPACE_BYTES;}
  return MAXIMUM_MANAGED_ASSET_BYTES;
}

export async function operationForChangedPath(input: {
  readonly sourceRoot: string;
  readonly path: string;
  readonly stagedRoot: string;
}): Promise<KnownFileTransactionOperationInput> {
  const [preimage, postimage] = await Promise.all([
    readStableConsumerFile(input.sourceRoot, input.path, maximumBytes(input.path), true),
    readStableConsumerFile(input.stagedRoot, input.path, maximumBytes(input.path), true)
  ]);
  if (preimage.state !== "file" || postimage.state !== "file") {throw new Error("unreachable");}
  return Object.freeze({
    path: input.path,
    precondition: {
      state: "known-file" as const,
      acceptedPreimages: [{ bytes: preimage.bytes, mode: preimage.mode }]
    },
    postimage: { bytes: postimage.bytes, mode: preimage.mode }
  });
}
