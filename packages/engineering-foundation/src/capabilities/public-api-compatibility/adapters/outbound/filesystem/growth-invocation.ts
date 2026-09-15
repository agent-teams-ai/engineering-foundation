import { configurationInputError } from "../../../application/configuration-input.js";
import type { GrowthWorkspaceReader } from "../../../application/ports/growth-workspace.js";
import { createHash } from "node:crypto";
import { readFile, readdir, lstat, realpath } from "node:fs/promises";
import { resolve, join, normalize } from "node:path";
import { Extractor } from "@microsoft/api-extractor";
import { assertNotCancelled, publicApiInputError, publicApiFileFailure } from "../../../application/policies/public-api-evidence-errors.js";
import type { PublicApiFileReader } from "../../../application/ports/public-api-evidence.js";
import type { GrowthDigest, GrowthInvocation } from "../../../application/model/growth-observation.js";
import { growthCanonicalJson, normalizeGrowthInvocation } from "../../../application/policies/normalize-growth-observation.js";

const digest = (bytes: string | Uint8Array): GrowthDigest => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function canonicalFilesystemPath(value: string): string {
  let normalized = normalize(value).replace(/^\\\\\?\\/u, "");
  // macOS temp paths can resolve through the /private alias; Windows can
  // return extended-length paths. Both spellings identify the same inode.
  if (process.platform === "darwin" && normalized.startsWith("/private/")) {
    normalized = normalized.slice("/private".length);
  }
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function sameFilesystemPath(left: string, right: string): boolean {
  // Windows native realpath may add an extended-length prefix and preserves
  // filesystem case differently from resolve(). Compare identities using the
  // platform's actual path semantics while retaining lstat symlink checks.
  return canonicalFilesystemPath(left) === canonicalFilesystemPath(right);
}

function unavailable(reason: string): never {
  publicApiInputError("SDK_GROWTH_EVIDENCE_INCOMPLETE", reason, "sdk-growth-evidence");
}

/** Command-boundary identity of the actual source checkpoint and selected build
 * inputs. These byte identities carry no archive qualification or CI authority. */
export async function readGrowthInvocation(consumerRoot: string, inventory: Awaited<ReturnType<GrowthWorkspaceReader["read"]>>, dependencies: {
  readonly files: PublicApiFileReader;
  readonly runGit: (args: readonly string[], signal?: AbortSignal) => Promise<{ readonly exitCode: number; readonly stdout: string }>;
}, signal?: AbortSignal): Promise<GrowthInvocation> {
  assertNotCancelled(signal);
  const git = async (args: readonly string[]) => {
    try {
      const result = await dependencies.runGit(["-C", consumerRoot, ...args], signal);
      if (result.exitCode !== 0) { unavailable("Source Git checkpoint is unavailable or changed."); }
      return result.stdout.trim();
    }
    catch (error) {
      assertNotCancelled(signal);
      if (error !== null && typeof error === "object" && "code" in error && (typeof error.code === "number" || error.code === "ENOENT")) {
        unavailable("Source Git checkpoint is unavailable or changed; observe a committed source with its built inputs.");
      }
      throw error;
    }
  };
  // The workspace metadata manifest has no package directory. Keep it in the
  // topology digest; a root export requires a separately bounded source scope.
  const packageDirectories = inventory.packages.filter((pkg) => pkg.rootPath !== ".");
  if (inventory.packages.some((pkg) => pkg.rootPath === "." && pkg.exportSurface.explicit)) {
    unavailable("Root-package exports require an explicit bounded source/report separation.");
  }
  const sourceCommit = await git(["rev-parse", "--verify", "HEAD"]);
  const sourceTree = await git(["rev-parse", "--verify", "HEAD^{tree}"]);
  await git(["diff", "--quiet", "HEAD", "--"]);
  if (packageDirectories.length > 0 && await git(["ls-files", "--others", "--exclude-standard", "--", ...packageDirectories.map((pkg) => pkg.rootPath)])) {
    unavailable("Uncommitted package inputs cannot bind a Git source tree.");
  }
  let total = 0;
  const input = async (path: string) => {
    try {
      const bytes = await dependencies.files.read({ root: consumerRoot, candidate: resolve(consumerRoot, path), maxBytes: 32 * 1024 * 1024 });
      total += bytes.byteLength;
      if (total > 32 * 1024 * 1024) { unavailable("SDK invocation input byte budget exhausted."); }
      return { path, digest: digest(bytes) };
    } catch (error) {
      const failure = publicApiFileFailure(error);
      if (failure !== undefined) { unavailable(`SDK invocation input ${path} is ${failure}.`); }
      throw error;
    }
  };
  const workspace = await input("pnpm-workspace.yaml");
  const manifests = await Promise.all(inventory.packages.map((pkg) => input(pkg.manifestPath)));
  const buildPaths: string[] = [];
  async function buildFiles(path: string): Promise<void> {
    for (const entry of await readdir(resolve(consumerRoot, path), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") { continue; }
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) { await buildFiles(child); }
      else { buildPaths.push(child); }
      if (buildPaths.length > 4096) { unavailable("SDK invocation input file budget exhausted."); }
    }
  }
  for (const pkg of packageDirectories) { await buildFiles(pkg.rootPath); }
  const build = await Promise.all(buildPaths.toSorted().map(input));
  const lock = await input("pnpm-lock.yaml");
  const manifestBytes = await readFile(new URL("../../../../../../package.json", import.meta.url));
  const toolManifest = JSON.parse(manifestBytes.toString("utf8")) as { version: string };
  const toolArtifactDigest = await distributionDigest(await realpath(new URL("../../../../../../", import.meta.url)), dependencies.files, signal);
  assertNotCancelled(signal);
  if (await git(["rev-parse", "--verify", "HEAD"]) !== sourceCommit) { unavailable("Source checkpoint changed during observation."); }
  await git(["diff", "--quiet", "HEAD", "--"]);
  return normalizeGrowthInvocation({ repository: await git(["rev-parse", "--show-toplevel"]), sourceCommit, sourceTree,
    topologyDigest: digest(growthCanonicalJson({ workspace, manifests: manifests.toSorted((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) })),
    lockDigest: lock.digest, toolchainDigest: digest(growthCanonicalJson({ node: process.version, extractor: Extractor.version, lock: lock.digest })),
    artifactDigests: [digest(growthCanonicalJson(build))],
    tool: { version: toolManifest.version, artifactDigest: toolArtifactDigest, extractorVersion: Extractor.version } });
}

async function distributionDigest(root: string, reader: PublicApiFileReader, signal?: AbortSignal): Promise<GrowthDigest> {
  const files: { path: string; digest: GrowthDigest }[] = [];
  let total = 0;
  async function capture(path: string): Promise<void> {
    assertNotCancelled(signal);
    const bytes = await reader.read({ root, candidate: join(root, path), maxBytes: 32 * 1024 * 1024 });
    total += bytes.byteLength;
    if (total > 32 * 1024 * 1024 || files.length >= 4096) { unavailable("SDK checker distribution identity budget exhausted."); }
    files.push({ path, digest: digest(bytes) });
  }
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) { await visit(child); }
      else { await capture(child); }
    }
  }
  await capture("package.json");
  await visit("dist"); await visit("schemas");
  return digest(growthCanonicalJson(files.toSorted((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
}

/** Early destination validation; publication revalidates under its own fence. */
export async function assertGrowthDestination(root: string, path: string): Promise<void> {
  const segments = path.split("/");
  let current = resolve(root);
  const directories = [current];
  for (const segment of segments.slice(0, -1)) { current = join(current, segment); directories.push(current); }
  for (const directory of directories) {
    let entry;
    try { entry = await lstat(directory); }
    catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        configurationInputError("SDK report parents must exist as real directories.");
      }
      throw error;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink() || !sameFilesystemPath(await realpath(directory), directory)) {
      configurationInputError("SDK report parents must be real contained directories.");
    }
  }
  try {
    const entry = await lstat(join(root, path));
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) { configurationInputError("SDK report destination must be a distinct regular file."); }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") { return; }
    throw error;
  }
}
