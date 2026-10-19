import { open, opendir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse } from "jsonc-parser";
import { assertNotCancelled } from "../../../application/policies/public-api-evidence-errors.js";

const MAX_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 20_000;
async function boundedFile(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) { throw new Error("Public API compiler input exceeds its bounded regular-file admission."); }
    const chunks: Buffer[] = []; let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes - total + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) { break; }
      total += bytesRead;
      if (total > maxBytes) { throw new Error("Public API compiler input exceeds its per-file or aggregate byte budget."); }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || total !== after.size) { throw new Error("Public API compiler input changed during snapshot capture."); }
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}
interface Manifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

async function findPackage(directory: string, name: string): Promise<string | undefined> {
    let current = directory;
    for (;;) {
      const candidate = join(current, "node_modules", name);
      try { if ((await stat(join(candidate, "package.json"))).isFile()) { return await realpath(candidate); } }
      catch (error) { if (!(error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code)))) { throw error; } }
      const parent = dirname(current); if (parent === current) { return undefined; } current = parent;
    }
  }

function compilerPresets(files: ReadonlyMap<string, string>): { owner: string; name: string }[] {
  const result: { owner: string; name: string }[] = [];
  for (const [path, text] of files) {
    if (!/\.jsonc?$/u.test(path)) { continue; }
    const value: unknown = parse(text);
    if (typeof value !== "object" || value === null || !("extends" in value)) { continue; }
    const extended = typeof value.extends === "string" ? [value.extends] : Array.isArray(value.extends) ? value.extends : [];
    for (const target of extended) {
      if (typeof target !== "string" || target.startsWith(".") || target.startsWith("/") || target.includes("\\")) { continue; }
      const parts = target.split("/");
      const name = target.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
      if (name !== undefined && /^(?:@[a-zA-Z0-9_][a-zA-Z0-9_.-]*\/)?[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u.test(name)) { result.push({ owner: dirname(path), name }); }
    }
  }
  return result;
}

/** Capture the staged declaration/configuration namespace and its installed
 * dependency declarations before starting the native compiler. No SDK or package
 * code is executed. The compiler subsequently sees only these copied bytes. */
export async function captureNativePublicApiInputs(input: {
  readonly stagingRoot: string;
  readonly packageRoot: string;
  readonly signal?: AbortSignal;
}): Promise<ReadonlyMap<string, string>> {
  const files = new Map<string, string>();
  let total = 0;
  let entries = 0;
  const directoryEntries = async (path: string) => {
    const values = [];
    for await (const entry of await opendir(path)) {
      if (++entries > 50_000) { throw new Error("Public API compiler input exceeds its directory-entry budget."); }
      values.push(entry);
    }
    return values.toSorted((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  };
  const capture = async (physical: string, virtual: string): Promise<void> => {
    assertNotCancelled(input.signal);
    if (files.size >= MAX_FILES) { throw new Error("Public API compiler input snapshot exceeds its file inventory."); }
    const bytes = await boundedFile(physical, Math.min(32 * 1024 * 1024, MAX_BYTES - total));
    total += bytes.byteLength;
    if (total > MAX_BYTES || files.size >= MAX_FILES) { throw new Error("Public API compiler input snapshot exceeds its bounded file or byte inventory."); }
    files.set(resolve(virtual).replaceAll("\\", "/"), bytes.toString("utf8"));
  };
  const walk = async (physical: string, virtual: string, depth = 0): Promise<void> => {
    if (depth > 128) { throw new Error("Public API compiler input exceeds its directory-depth budget."); }
    for (const entry of await directoryEntries(physical)) {
      assertNotCancelled(input.signal);
      if (entry.name === "node_modules" || entry.name === ".git") { continue; }
      const source = join(physical, entry.name); const target = join(virtual, entry.name);
      if (entry.isDirectory()) { await walk(source, target, depth + 1); }
      else if (entry.isFile() && /(?:\.d\.[cm]?ts|\.jsonc?)$/u.test(entry.name)) { await capture(source, target); }
      else if (entry.isSymbolicLink()) { throw new Error("Public API compiler input snapshot contains a symbolic-link member."); }
    }
  };
  await walk(input.stagingRoot, input.stagingRoot);
  const installed = new Map<string, string>();
  const pending: { physical: string; virtual: string }[] = [];
  const admit = async (owner: string, virtualOwner: string, name: string): Promise<void> => {
    if (!/^(?:@[a-zA-Z0-9_][a-zA-Z0-9_.-]*\/)?[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u.test(name)) { throw new Error("Public API dependency name is not a bounded package identifier."); }
    const physical = await findPackage(owner, name);
    if (physical === undefined) { return; } // Missing imports remain native compiler diagnostics.
    const global = join(input.stagingRoot, "node_modules", name);
    let virtual = global;
    const prior = installed.get(global);
    if (prior !== undefined && prior !== physical) { virtual = join(virtualOwner, "node_modules", name); }
    const existing = installed.get(virtual);
    if (existing === physical) { return; }
    if (existing !== undefined) { throw new Error("Public API dependency snapshot has conflicting package resolution."); }
    installed.set(virtual, physical);
    pending.push({ physical, virtual });
  };
  const dependencies = async (physical: string, virtual: string): Promise<void> => {
    const bytes = files.get(resolve(virtual, "package.json").replaceAll("\\", "/"));
    if (bytes === undefined) { throw new Error("Public API dependency manifest was not captured."); }
    const manifest = JSON.parse(bytes) as Manifest;
    for (const name of [...new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})])].toSorted()) { await admit(physical, virtual, name); }
  };
  for (const preset of compilerPresets(files)) { await admit(preset.owner, input.stagingRoot, preset.name); }
  await dependencies(input.packageRoot, input.packageRoot);
  for (const owner of [input.packageRoot, input.stagingRoot]) {
    try {
      for (const entry of await directoryEntries(join(owner, "node_modules", "@types"))) { await admit(owner, input.stagingRoot, `@types/${entry.name}`); }
    } catch (error) { if (!(error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code)))) { throw error; } }
  }
  for (let index = 0; index < pending.length; index++) {
    if (pending.length > 1024) { throw new Error("Public API dependency snapshot exceeds its package budget."); }
    const pkg = pending[index]!;
    await walk(pkg.physical, pkg.virtual);
    await dependencies(pkg.physical, pkg.virtual);
  }
  return files;
}
