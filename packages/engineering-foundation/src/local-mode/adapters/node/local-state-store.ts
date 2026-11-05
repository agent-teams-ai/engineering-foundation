import { constants, type BigIntStats } from "node:fs";
import { randomUUID } from "node:crypto";
import { link, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { FoundationLinkState } from "../../application/model.js";
import { LOCAL_STATE_DIRECTORY, LOCAL_STATE_FILE } from "../../application/model.js";
import { localCustodyFailure } from "../../application/inspection-failures.js";
import { parseLinkState } from "./mode-inspection.js";
import {
  assertLocalEntry,
  observeLocalEntry,
  observeLocalParents,
  sameLocalEntry,
  type LocalEntryObservation,
} from "./local-entry-observation.js";

const MAXIMUM_MARKER_BYTES = 64 * 1024;

function markerBytes(state: FoundationLinkState): Buffer {
  return Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function readMarker(observation: LocalEntryObservation): Promise<Buffer> {
  const metadata = observation.metadata;
  if (
    metadata === undefined ||
    !metadata.isFile() ||
    metadata.nlink !== 1n ||
    metadata.size > BigInt(MAXIMUM_MARKER_BYTES)
  ) {
    throw localCustodyFailure("Local marker is not a bounded, singly linked regular file.");
  }
  const flags =
    constants.O_RDONLY |
    (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const handle = await open(observation.path, flags);
  let bytes: Buffer | undefined;
  const failures: unknown[] = [];
  try {
    if (!sameLocalEntry(metadata, await handle.stat({ bigint: true }))) {
      throw localCustodyFailure("Local marker changed before reading.");
    }
    const bounded = Buffer.alloc(MAXIMUM_MARKER_BYTES + 1);
    let length = 0;
    while (length < bounded.length) {
      const read = await handle.read(bounded, length, bounded.length - length, length);
      if (read.bytesRead === 0) {
        break;
      }
      length += read.bytesRead;
    }
    if (length > MAXIMUM_MARKER_BYTES || BigInt(length) !== metadata.size) {
      throw localCustodyFailure("Local marker changed or exceeded its read bound.");
    }
    bytes = bounded.subarray(0, length);
    await assertLocalEntry(observation);
  } catch (error) {
    failures.push(error);
  }
  try {
    await handle.close();
  } catch (error) {
    failures.push(error);
  }
  throwMarkerFailures(failures);
  if (bytes === undefined) {
    throw localCustodyFailure("Local marker observation did not complete.");
  }
  return bytes;
}

function throwMarkerFailures(failures: readonly unknown[]): void {
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw localCustodyFailureWithCause(failures);
  }
}

function localCustodyFailureWithCause(failures: readonly unknown[]) {
  const failure = localCustodyFailure(
    "Local marker operation and finalization failed; reconcile retained evidence.",
  );
  failure.cause = new AggregateError(failures, "Local marker failures in observation order.");
  return failure;
}

function admitsPredecessor(bytes: Buffer, next: FoundationLinkState): boolean {
  let predecessor: FoundationLinkState | undefined;
  try {
    predecessor = parseLinkState(JSON.parse(bytes.toString("utf8")) as unknown);
  } catch {
    return false;
  }
  const phases: readonly FoundationLinkState["phase"][] =
    next.phase === "LOCAL"
      ? ["ATTACHING"]
      : next.phase === "DETACHING"
        ? ["ATTACHING", "LOCAL", "DETACHING"]
        : [];
  return (
    predecessor !== undefined &&
    phases.includes(predecessor.phase) &&
    Object.entries(predecessor).every(
      ([key, value]) => key === "phase" || Reflect.get(next, key) === value,
    )
  );
}

export interface LocalStateDirectory {
  ensure(consumerRoot: string): Promise<unknown>;
  prune(consumerRoot: string): Promise<void>;
  sync(directory: string): Promise<void>;
}

interface MarkerPublication {
  readonly root: string;
  readonly marker: LocalEntryObservation;
  readonly parents: Awaited<ReturnType<typeof observeLocalParents>>;
}

async function prepareMarkerWrite(
  consumerRoot: string,
  state: FoundationLinkState,
  retained: MarkerPublication | undefined,
  durability: LocalStateDirectory,
) {
  if (state.consumerRoot !== consumerRoot) {
    throw localCustodyFailure("Local marker belongs to another consumer.");
  }
  const bytes = markerBytes(state);
  if (bytes.length > MAXIMUM_MARKER_BYTES) {
    throw localCustodyFailure("Local marker exceeds its write bound.");
  }
  if (retained !== undefined && retained.root !== consumerRoot) {
    throw localCustodyFailure("Local marker operation belongs to another consumer.");
  }
  const root = await observeLocalParents(consumerRoot, consumerRoot);
  if (retained !== undefined) {
    await retained.parents.assertCurrent();
    await assertLocalEntry(retained.marker);
  }
  const directory = join(consumerRoot, LOCAL_STATE_DIRECTORY);
  const destination = join(directory, LOCAL_STATE_FILE);
  const existingDirectory = await observeLocalEntry(directory);
  const beforeParents =
    existingDirectory.metadata === undefined
      ? root
      : await observeLocalParents(consumerRoot, directory);
  const predecessor = await observeLocalEntry(destination);
  await durability.ensure(consumerRoot);
  await beforeParents.assertCurrent();
  await assertLocalEntry(predecessor);
  const parents = await observeLocalParents(consumerRoot, directory);
  if (predecessor.metadata === undefined) {
    if (state.phase !== "ATTACHING") {
      throw localCustodyFailure("Local phase replacement requires its predecessor marker.");
    }
  } else if (!admitsPredecessor(await readMarker(predecessor), state)) {
    throw localCustodyFailure("Local marker predecessor does not match this lifecycle transition.");
  }
  // Old interrupted temporaries remain manual evidence, never reusable workspace.
  if (
    (await readdir(directory)).some(
      (name) => name.startsWith(`${LOCAL_STATE_FILE}.`) && name.endsWith(".tmp"),
    )
  ) {
    throw localCustodyFailure("Unproven local marker temporary requires manual recovery.");
  }
  const temporary = join(directory, `${LOCAL_STATE_FILE}.${randomUUID()}.tmp`);
  await parents.assertCurrent();
  await assertLocalEntry(predecessor);
  return { bytes, directory, destination, predecessor, parents, temporary };
}

async function retirePublishedTemporary(
  temporary: string,
  destination: string,
  initial: BigIntStats,
  parents: MarkerPublication["parents"],
): Promise<void> {
  const linkedTemporary = await observeLocalEntry(temporary);
  const linkedMarker = await observeLocalEntry(destination);
  if (
    linkedTemporary.metadata === undefined ||
    !sameLocalEntry(initial, linkedTemporary.metadata) ||
    linkedMarker.metadata === undefined ||
    !sameLocalEntry(initial, linkedMarker.metadata)
  ) {
    throw localCustodyFailure("Published marker temporary ownership changed.");
  }
  await parents.assertCurrent();
  await assertLocalEntry(linkedTemporary);
  await assertLocalEntry(linkedMarker);
  await rm(temporary);
}

/** One store belongs to one held local operation; its observations cannot survive release. */
export function createNodeLocalLinkStateStore(durability: LocalStateDirectory) {
  let retained: MarkerPublication | undefined;
  return {
    async write(consumerRoot: string, state: FoundationLinkState): Promise<void> {
      const { bytes, directory, destination, predecessor, parents, temporary } =
        await prepareMarkerWrite(consumerRoot, state, retained, durability);
      const handle = await open(temporary, "wx", 0o600);
      let initial: BigIntStats | undefined;
      let owned: LocalEntryObservation | undefined;
      let published = false;
      const failures: unknown[] = [];
      try {
        initial = await handle.stat({ bigint: true });
        await handle.writeFile(bytes);
        await handle.sync();
      } catch (error) {
        failures.push(error);
      }
      try {
        await handle.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        owned = await observeLocalEntry(temporary);
        if (
          initial === undefined ||
          owned.metadata === undefined ||
          !sameLocalEntry(initial, owned.metadata) ||
          !owned.metadata.isFile() ||
          owned.metadata.nlink !== 1n
        ) {
          owned = undefined;
          throw localCustodyFailure(
            "Local marker temporary was replaced; foreign evidence was preserved.",
          );
        }
        if (failures.length === 0) {
          if (!(await readMarker(owned)).equals(bytes)) {
            throw localCustodyFailure("Local marker temporary bytes changed before publication.");
          }
          await parents.assertCurrent();
          await assertLocalEntry(predecessor);
          await assertLocalEntry(owned);
          if (predecessor.metadata === undefined) {
            // Initial publication must never replace a competing destination.
            await link(temporary, destination);
            published = true;
            await retirePublishedTemporary(temporary, destination, initial, parents);
          } else {
            await rename(temporary, destination);
            published = true;
          }
          // Rename can update ctime. Retain its post-publication observation only
          // after proving the inode is still the one opened by this operation.
          const observed = await observeLocalEntry(destination);
          if (observed.metadata === undefined || !sameLocalEntry(initial, observed.metadata)) {
            throw localCustodyFailure("Published local marker ownership changed.");
          }
          const publication = { root: consumerRoot, marker: observed, parents };
          retained = publication;
          await parents.assertCurrent();
          await assertLocalEntry(publication.marker);
          await durability.sync(directory);
          await parents.assertCurrent();
          await assertLocalEntry(publication.marker);
        }
      } catch (error) {
        failures.push(error);
      }
      if (!published && owned !== undefined) {
        try {
          await parents.assertCurrent();
          await assertLocalEntry(owned);
          await rm(temporary);
          await durability.sync(directory);
          await parents.assertCurrent();
          await assertLocalEntry({ path: temporary, metadata: undefined });
        } catch (error) {
          failures.push(error);
        }
      }
      throwMarkerFailures(failures);
    },
    async remove(consumerRoot: string): Promise<void> {
      if (retained !== undefined) {
        if (retained.root !== consumerRoot) {
          throw localCustodyFailure("Local marker operation belongs to another consumer.");
        }
        await retained.parents.assertCurrent();
      }
      const directory = join(consumerRoot, LOCAL_STATE_DIRECTORY);
      const root = await observeLocalParents(consumerRoot, consumerRoot);
      const directoryEntry = await observeLocalEntry(directory);
      if (directoryEntry.metadata === undefined) {
        await root.assertCurrent();
        await assertLocalEntry(directoryEntry);
        return;
      }
      const parents = await observeLocalParents(consumerRoot, directory);
      const marker = await observeLocalEntry(join(directory, LOCAL_STATE_FILE));
      if (marker.metadata !== undefined) {
        if (retained === undefined || retained.root !== consumerRoot) {
          throw localCustodyFailure(
            "Existing local marker has no removal authority in this operation.",
          );
        }
        await retained.parents.assertCurrent();
        await assertLocalEntry(retained.marker);
        await parents.assertCurrent();
        await rm(marker.path);
        retained = {
          root: consumerRoot,
          marker: { path: marker.path, metadata: undefined },
          parents,
        };
      }
      await parents.assertCurrent();
      await durability.sync(directory);
      await parents.assertCurrent();
      await assertLocalEntry({ path: marker.path, metadata: undefined });
      await durability.prune(consumerRoot);
      retained = undefined;
    },
  };
}
