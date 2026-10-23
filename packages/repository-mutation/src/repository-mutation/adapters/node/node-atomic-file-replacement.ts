import { randomUUID } from "node:crypto";
import { lstat, open, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import type { PortablePathIdentity } from "../../../path-identity.js";
import type { KnownFileCoordination } from "./known-file-coordination.js";
import { cleanupIdentityMatchingOwnedTemporary } from "./node-cleanup-owned-temporary.js";
import { syncDirectoryDurably } from "./node-directory-durability.js";
import { isLexicallyContainedPath } from "./node-repository-path.js";

type ReplacementCoordination = Pick<
  KnownFileCoordination,
  | "captureFileHandleIdentity"
  | "pathMatchesRegularFileIdentity"
  | "assertTerminalEvidenceDirectory"
  | "ensureTerminalEvidenceDirectory"
>;

export class NodeAtomicFileReplacementError extends Error {
  constructor(
    readonly failure: "directory-changed" | "unsafe-directory" | "temporary-changed",
    options?: ErrorOptions,
  ) {
    super(`Atomic file replacement observation failed: ${failure}.`, options);
    this.name = "NodeAtomicFileReplacementError";
  }
}

/** Physical resource ownership only; the caller owns lease and preimage policy. */
export interface NodeAtomicFileReplacement {
  assertCurrent(): Promise<void>;
  bindParent(): Promise<void>;
  prepare(bytes: Uint8Array, openTemporary?: (path: string) => Promise<FileHandle>): Promise<void>;
  replace(renameTemporary?: (source: string, target: string) => Promise<void>): Promise<void>;
  cleanup(): Promise<void>;
}

interface ReplacementState {
  readonly root: string;
  readonly candidate: string;
  readonly parent: string;
  readonly rootIdentity: PortablePathIdentity;
  preparationStarted: boolean;
  parentIdentity?: PortablePathIdentity;
  temporary?: { readonly path: string; readonly identity: PortablePathIdentity };
}

async function directoryIdentity(path: string): Promise<PortablePathIdentity> {
  const entry = await lstat(path, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new NodeAtomicFileReplacementError("unsafe-directory");
  }
  return { birthtimeNs: entry.birthtimeNs, dev: entry.dev, ino: entry.ino };
}

async function assertDirectory(path: string, expected: PortablePathIdentity): Promise<void> {
  let observed: PortablePathIdentity;
  try {
    observed = await directoryIdentity(path);
  } catch (error) {
    throw new NodeAtomicFileReplacementError("directory-changed", { cause: error });
  }
  if (
    observed.birthtimeNs !== expected.birthtimeNs ||
    observed.dev !== expected.dev ||
    observed.ino !== expected.ino
  ) {
    throw new NodeAtomicFileReplacementError("directory-changed");
  }
}

async function assertCurrent(state: ReplacementState): Promise<void> {
  await assertDirectory(state.root, state.rootIdentity);
  if (state.parentIdentity !== undefined) {
    await assertDirectory(state.parent, state.parentIdentity);
  }
}

async function prepare(
  coordination: ReplacementCoordination,
  state: ReplacementState,
  bytes: Uint8Array,
  openTemporary: (path: string) => Promise<FileHandle>,
): Promise<void> {
  await assertCurrent(state);
  if (state.parentIdentity === undefined || state.preparationStarted) {
    throw new Error(
      "Atomic replacement requires a bound parent and permits one temporary preparation.",
    );
  }
  state.preparationStarted = true;
  const path = join(state.parent, `.foundation-atomic-replacement-${randomUUID()}.tmp`);
  const handle = await openTemporary(path);
  const failures: unknown[] = [];
  try {
    state.temporary = { path, identity: await coordination.captureFileHandleIdentity(handle) };
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
  if (state.temporary === undefined) {
    failures.push(
      new Error(
        `Atomic replacement temporary identity is unavailable; evidence remains at ${path}.`,
      ),
    );
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "Atomic replacement temporary preparation and finalization failed.",
      { cause: failures[0] },
    );
  }
}

async function replace(
  coordination: ReplacementCoordination,
  state: ReplacementState,
  renameTemporary: (source: string, target: string) => Promise<void>,
): Promise<void> {
  await assertCurrent(state);
  const temporary = state.temporary;
  if (
    temporary === undefined ||
    (await coordination.pathMatchesRegularFileIdentity(temporary.path, temporary.identity)) !==
      "match"
  ) {
    throw new NodeAtomicFileReplacementError("temporary-changed");
  }
  await renameTemporary(temporary.path, state.candidate);
  delete state.temporary;
}

async function cleanup(
  coordination: ReplacementCoordination,
  state: ReplacementState,
): Promise<void> {
  const temporary = state.temporary;
  if (temporary === undefined) {
    return;
  }
  await assertCurrent(state);
  const outcome = await cleanupIdentityMatchingOwnedTemporary(coordination, {
    allowUnsupportedDirectoryDurability: true,
    displayPath: temporary.path,
    expectedIdentity: temporary.identity,
    parent: state.parent,
    rm: (path) => rm(path),
    syncDirectory: syncDirectoryDurably,
    temporaryPath: temporary.path,
  });
  if (outcome === "different") {
    throw new NodeAtomicFileReplacementError("temporary-changed");
  }
  delete state.temporary;
}

/** Does not acquire a lease, inspect a preimage, rename, or claim durability. */
export async function observeAtomicFileReplacement(
  coordination: ReplacementCoordination,
  input: { readonly root: string; readonly candidate: string },
): Promise<NodeAtomicFileReplacement> {
  const parent = dirname(input.candidate);
  if (
    !isAbsolute(input.root) ||
    !isAbsolute(input.candidate) ||
    !isLexicallyContainedPath(input.root, parent)
  ) {
    throw new NodeAtomicFileReplacementError("unsafe-directory");
  }
  const state: ReplacementState = {
    ...input,
    parent,
    rootIdentity: await directoryIdentity(input.root),
    preparationStarted: false,
  };
  return {
    assertCurrent: () => assertCurrent(state),
    async bindParent() {
      await assertCurrent(state);
      state.parentIdentity ??= await directoryIdentity(parent);
    },
    prepare: (bytes, openTemporary = (path) => open(path, "wx", 0o644)) =>
      prepare(coordination, state, bytes, openTemporary),
    replace: (renameTemporary = rename) => replace(coordination, state, renameTemporary),
    cleanup: () => cleanup(coordination, state),
  };
}
