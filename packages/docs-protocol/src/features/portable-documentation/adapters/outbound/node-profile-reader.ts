import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isAlias, isMap, isNode, isPair, parseDocument, visit } from "yaml";

import type { DocsProfileReaderV2 } from "../../application/model-v2.js";
import { DocsProfileError, parseDocsProtocolProfile, validatePortableRepositoryPath, validatePortableRepositoryPathV2 } from "../../application/profile-policy.js";
import { assertDocsProtocolProfileSchema } from "./docs-profile-schema-validator.js";

const MAX_PROFILE_BYTES = 1_048_576;

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function assertInitialFile(state: Awaited<ReturnType<FileHandle["stat"]>>): void {
  if (!state.isFile() || state.isSymbolicLink()) {throw new DocsProfileError("Profile must be a regular file.");}
  if (state.nlink !== 1n) {throw new DocsProfileError("Profile must not have hard links.");}
  if (state.size > BigInt(MAX_PROFILE_BYTES)) {throw new DocsProfileError("Profile exceeds 1 MiB.");}
}

function sameIdentity(left: { readonly dev: bigint; readonly ino: bigint }, right: { readonly dev: bigint; readonly ino: bigint }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function pathIdentities(root: string, profilePath: string): Promise<readonly { readonly dev: bigint; readonly ino: bigint }[]> {
  let current = root;
  const rootState = await lstat(root, { bigint: true });
  if (rootState.isSymbolicLink() || !rootState.isDirectory()) {
    throw new DocsProfileError("Profile path must be a real contained file without symlinks.");
  }
  const identities = [{ dev: rootState.dev, ino: rootState.ino }];
  const segments = profilePath.split("/");
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    const state = await lstat(current, { bigint: true });
    if (state.isSymbolicLink() || (index < segments.length - 1 && !state.isDirectory())) {
      throw new DocsProfileError("Profile path must be a real contained file without symlinks.");
    }
    identities.push({ dev: state.dev, ino: state.ino });
  }
  return identities;
}

function assertSamePathIdentities(
  left: readonly { readonly dev: bigint; readonly ino: bigint }[],
  right: readonly { readonly dev: bigint; readonly ino: bigint }[]
): void {
  if (left.length !== right.length || !left.every((identity, index) => sameIdentity(identity, right[index]!))) {
    throw new DocsProfileError("Profile pathname changed during its bounded read.");
  }
}

async function readBounded(handle: FileHandle, signal: AbortSignal | undefined): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= MAX_PROFILE_BYTES) {
    signal?.throwIfAborted();
    const remaining = MAX_PROFILE_BYTES + 1 - total;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
    if (bytesRead === 0) {return Buffer.concat(chunks, total);}
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  throw new DocsProfileError("Profile exceeds 1 MiB.");
}

async function readProfileBytes(input: { readonly consumerRoot: string; readonly profilePath: string; readonly signal?: AbortSignal }): Promise<Buffer> {
  validatePortableRepositoryPath(input.profilePath, "Profile path");
  const root = await realpath(resolve(input.consumerRoot));
  input.signal?.throwIfAborted();
  const requested = resolve(root, input.profilePath);
  if (!contained(root, requested)) {throw new DocsProfileError("Profile path escapes the consumer root.");}
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const nonBlocking = process.platform === "win32" ? 0 : constants.O_NONBLOCK;
  const handle = await open(requested, constants.O_RDONLY | noFollow | nonBlocking).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new DocsProfileError("Profile path must be a real contained file without symlinks.");
    }
    throw error;
  });
  try {
    const opened = await handle.stat({ bigint: true });
    assertInitialFile(opened);
    const beforePathIdentities = await pathIdentities(root, input.profilePath);
    const physical = await realpath(requested);
    input.signal?.throwIfAborted();
    if (!contained(root, physical)) {throw new DocsProfileError("Profile path must be a real contained file without symlinks.");}
    const pathState = await lstat(physical, { bigint: true });
    if (!pathState.isFile() || pathState.isSymbolicLink() || pathState.nlink !== 1n || !sameIdentity(pathState, opened)) {throw new DocsProfileError("Profile identity changed before its bounded read or has hard links.");}
    const bytes = await readBounded(handle, input.signal);
    const after = await handle.stat({ bigint: true });
    if (after.nlink !== 1n || !sameIdentity(after, opened) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.size !== BigInt(bytes.byteLength)) {throw new DocsProfileError("Profile changed during its bounded read, has hard links, or exceeds 1 MiB.");}
    const afterPathIdentities = await pathIdentities(root, input.profilePath);
    assertSamePathIdentities(afterPathIdentities, beforePathIdentities);
    const finalPathState = await lstat(physical, { bigint: true });
    if (!finalPathState.isFile() || finalPathState.isSymbolicLink() || finalPathState.nlink !== 1n || !sameIdentity(finalPathState, after)) {throw new DocsProfileError("Profile pathname changed during its bounded read or has hard links.");}
    return bytes;
  } finally {
    await handle.close();
  }
}

function parseProfileSource(bytes: Buffer): unknown {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (source.includes("\0") || source.startsWith("\uFEFF")) {throw new DocsProfileError("Profile encoding is invalid.");}
  const document = parseDocument(source, { customTags: [], merge: false, schema: "core", uniqueKeys: true });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    const problem = [...document.errors, ...document.warnings].slice(0, 8).map(({ message }) => message).join("; ").slice(0, 1000);
    throw new DocsProfileError(`Profile YAML is invalid: ${problem}`);
  }
  let forbidden: string | undefined;
  visit(document, (_key, node) => {
    if (isAlias(node)) {forbidden = "YAML aliases are prohibited.";}
    else if (isNode(node) && (node.anchor !== undefined || node.tag !== undefined)) {forbidden = "YAML anchors and explicit tags are prohibited.";}
    else if (isPair(node) && isNode(node.key) && "value" in node.key && node.key.value === "<<") {forbidden = "YAML merge keys are prohibited.";}
    else if (isMap(node) && node.items.length > 10_000) {forbidden = "YAML mapping exceeds the limit.";}
    return forbidden === undefined ? undefined : visit.BREAK;
  });
  if (forbidden !== undefined) {throw new DocsProfileError(forbidden);}
  return document.toJS({ maxAliasCount: 0 }) as unknown;
}

export class NodeDocsProfileReader implements DocsProfileReaderV2 {
  async read(input: { readonly consumerRoot: string; readonly profilePath: string; readonly signal?: AbortSignal }) {
    const value = parseProfileSource(await readProfileBytes(input));
    await assertDocsProtocolProfileSchema(value);
    const profile = parseDocsProtocolProfile(value);
    if (profile.schemaVersion === 4) {validatePortableRepositoryPathV2(input.profilePath, "Profile path");}
    return profile;
  }
}
