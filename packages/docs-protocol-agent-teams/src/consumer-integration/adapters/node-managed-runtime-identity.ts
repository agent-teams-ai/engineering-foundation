import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseStrictJson } from "@agent-teams/repository-mutation/serialization";
import type { RuntimeFileIdentity, RuntimeTuple } from "../application/ports/managed-runtime.js";

export interface TrustedRuntimeSelection {
  readonly selectedNode: { readonly path: string; readonly expectedSha256: string };
  readonly pnpmPackage: {
    readonly root: string;
    readonly expectedManifestSha256: string;
    readonly expectedEntrySha256: string;
    readonly expectedTreeDigest: string;
    readonly entryRelativePath: "bin/pnpm.mjs";
  };
  readonly expected: RuntimeTuple;
  readonly launcher: "direct-node";
}
export interface RuntimeImage {
  readonly nodePath: string;
  readonly rootPath: string;
  readonly node: RuntimeFileIdentity;
  readonly manifest: RuntimeFileIdentity;
  readonly entry: RuntimeFileIdentity;
  readonly treeDigest: string;
  readonly treeWitness: string;
}
const digest = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) && !/^0+$/.test(value);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Reflect.ownKeys(value).length === keys.length && keys.every((key) =>
    Object.hasOwn(value, key) && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"));
const validPath = (path: unknown): path is string =>
  typeof path === "string" && isAbsolute(path) && !path.includes("\0") && resolve(path) === path;
const version = (value: unknown): value is string => typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);

/** Snapshot caller input before any await; never derive a trusted hash from discovered bytes. */
function parseSelection(value: unknown): TrustedRuntimeSelection | null {
  if (!exact(value, ["selectedNode", "pnpmPackage", "expected", "launcher"])) {return null;}
  const node = value.selectedNode, pnpm = value.pnpmPackage, tuple = value.expected;
  if (!exact(node, ["path", "expectedSha256"]) ||
      !exact(pnpm, ["root", "expectedManifestSha256", "expectedEntrySha256", "expectedTreeDigest", "entryRelativePath"]) ||
      !exact(tuple, ["nodeVersion", "pnpmVersion", "platform", "architecture"]) ||
      !validPath(node.path) || !validPath(pnpm.root) || !hex(node.expectedSha256) ||
      !hex(pnpm.expectedManifestSha256) || !hex(pnpm.expectedEntrySha256) ||
      !hex(pnpm.expectedTreeDigest) || pnpm.entryRelativePath !== "bin/pnpm.mjs" ||
      !version(tuple.nodeVersion) || tuple.pnpmVersion !== "11.20.0" ||
      !["24.21.0", "26.10.0"].includes(tuple.nodeVersion) ||
      !["linux", "macos", "windows"].includes(String(tuple.platform)) ||
      !["x64", "arm64"].includes(String(tuple.architecture)) || value.launcher !== "direct-node") {return null;}
  return {
    selectedNode: { path: node.path, expectedSha256: node.expectedSha256 },
    pnpmPackage: { root: pnpm.root, expectedManifestSha256: pnpm.expectedManifestSha256,
      expectedEntrySha256: pnpm.expectedEntrySha256, expectedTreeDigest: pnpm.expectedTreeDigest,
      entryRelativePath: "bin/pnpm.mjs" },
    expected: { nodeVersion: tuple.nodeVersion, pnpmVersion: tuple.pnpmVersion,
      platform: tuple.platform as RuntimeTuple["platform"],
      architecture: tuple.architecture as RuntimeTuple["architecture"] }, launcher: "direct-node"
  };
}
export function validateSelection(value: unknown): TrustedRuntimeSelection | null {
  try { return parseSelection(value); } catch { return null; }
}
const time = (value: bigint): string => value.toString();
function metadata(stat: import("node:fs").BigIntStats): Omit<RuntimeFileIdentity, "realpath" | "sha256"> {
  return { byteLength: Number(stat.size), mode: Number(stat.mode), device: time(stat.dev),
    inode: time(stat.ino), birthtimeNs: time(stat.birthtimeNs), ctimeNs: time(stat.ctimeNs),
    mtimeNs: time(stat.mtimeNs) };
}
function sameMetadata(a: import("node:fs").BigIntStats, b: import("node:fs").BigIntStats): boolean {
  return JSON.stringify(metadata(a)) === JSON.stringify(metadata(b));
}
export async function hashRuntimeFile(path: string, maxBytes: number, executable: boolean): Promise<RuntimeFileIdentity> {
  const beforePath = await lstat(path, { bigint: true });
  if (!beforePath.isFile() || beforePath.nlink !== 1n || beforePath.size > BigInt(maxBytes) ||
      (executable && (beforePath.mode & 0o111n) === 0n)) {throw new Error("unsafe-runtime-file");}
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameMetadata(before, beforePath)) {throw new Error("runtime-file-changed");}
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < Number(before.size)) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset);
      if (bytesRead === 0) {throw new Error("runtime-file-short-read");}
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
    if (!sameMetadata(before, after) || !sameMetadata(before, afterPath)) {throw new Error("runtime-file-changed");}
    return { realpath: path, sha256: hash.digest("hex"), ...metadata(before) };
  } finally { await handle.close(); }
}
async function pnpmTree(root: string): Promise<{ digest: string; witness: string;
  manifest: RuntimeFileIdentity; entry: RuntimeFileIdentity }> {
  const records: [string, number, number, string][] = [];
  const witnesses: [string, RuntimeFileIdentity][] = [];
  let total = 0;
  let totalBytes = 0;
  let manifest: RuntimeFileIdentity | undefined, entry: RuntimeFileIdentity | undefined;
  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > 32) {throw new Error("runtime-tree-depth");}
    for (const name of (await readdir(dir)).toSorted()) {
      const path = join(dir, name);
      const rel = relative(root, path).split(sep).join("/");
      if (!rel || rel.startsWith("../") || rel.includes("\0")) {throw new Error("runtime-tree-path");}
      const stat = await lstat(path, { bigint: true });
      if (stat.isDirectory()) { await visit(path, depth + 1); continue; }
      if (!stat.isFile() || stat.nlink !== 1n || ++total > 10_000) {throw new Error("unsafe-runtime-tree");}
      const file = await hashRuntimeFile(path, 128 * 1024 * 1024, false);
      totalBytes += file.byteLength;
      if (totalBytes > 128 * 1024 * 1024) {throw new Error("runtime-tree-too-large");}
      records.push([rel, file.mode, file.byteLength, file.sha256]);
      witnesses.push([rel, file]);
      if (rel === "package.json") {manifest = file;}
      if (rel === "bin/pnpm.mjs") {entry = file;}
    }
  }
  await visit(root, 0);
  if (!manifest || !entry) {throw new Error("runtime-package-incomplete");}
  records.sort((a, b) => a[0].localeCompare(b[0], "en"));
  witnesses.sort((a, b) => a[0].localeCompare(b[0], "en"));
  return { digest: digest(`agent-teams.managed-pnpm-tree/v1\n${JSON.stringify(records)}`),
    witness: digest(JSON.stringify(witnesses)), manifest, entry };
}
async function verifyPackageManifest(selection: TrustedRuntimeSelection, rootPath: string,
  manifest: RuntimeFileIdentity): Promise<void> {
  if (manifest.byteLength > 1024 * 1024) {throw new Error("runtime-manifest-too-large");}
  const manifestHandle = await open(join(rootPath, "package.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  let manifestBytes: Buffer;
  try { manifestBytes = await manifestHandle.readFile(); } finally { await manifestHandle.close(); }
  if (manifestBytes.length > 1024 * 1024) {throw new Error("runtime-manifest-too-large");}
  if (digest(manifestBytes) !== manifest.sha256) {throw new Error("runtime-manifest-changed");}
  const parsed: unknown = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {throw new Error("runtime-manifest-invalid");}
  const packageJson = parsed as Record<string, unknown>;
  if (packageJson.name !== "pnpm" || packageJson.version !== selection.expected.pnpmVersion ||
      packageJson.bin === null || typeof packageJson.bin !== "object" ||
      (packageJson.bin as Record<string, unknown>).pnpm !== "bin/pnpm.mjs") {throw new Error("runtime-package-mismatch");}
}
export async function observeRuntimeImage(selection: TrustedRuntimeSelection, binding?: RuntimeImage): Promise<RuntimeImage> {
  const nodePath = await realpath(selection.selectedNode.path);
  const rootPath = await realpath(selection.pnpmPackage.root);
  if (nodePath !== selection.selectedNode.path || rootPath !== selection.pnpmPackage.root)
    {throw new Error("runtime-alias-refused");}
  if (binding && (binding.nodePath !== nodePath || binding.rootPath !== rootPath)) {throw new Error("runtime-path-retargeted");}
  const rootStat = await lstat(rootPath);
  if (!rootStat.isDirectory()) {throw new Error("runtime-package-root");}
  const node = await hashRuntimeFile(nodePath, 256 * 1024 * 1024, true);
  const { digest: treeDigest, witness: treeWitness, manifest, entry } = await pnpmTree(rootPath);
  if (node.sha256 !== selection.selectedNode.expectedSha256 ||
      manifest.sha256 !== selection.pnpmPackage.expectedManifestSha256 ||
      entry.sha256 !== selection.pnpmPackage.expectedEntrySha256 ||
      treeDigest !== selection.pnpmPackage.expectedTreeDigest) {throw new Error("runtime-identity-mismatch");}
  await verifyPackageManifest(selection, rootPath, manifest);
  const image = { nodePath, rootPath, node, manifest, entry, treeDigest, treeWitness };
  if (binding && JSON.stringify(image) !== JSON.stringify(binding)) {throw new Error("runtime-identity-changed");}
  return image;
}
