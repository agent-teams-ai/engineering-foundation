import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

// Private compiler shim materialization. Stable reads and physical containment
// retain the existing stage custody authority; this helper never reinstalls dependencies.
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shellLiteral(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

export async function materializeStagedCompiler(
  stagedPackageRoot: string,
  readManifest: (path: string, label: string) => Promise<unknown>,
  readExecutable: (path: string) => Promise<Buffer>,
  containsPath: (parent: string, candidate: string) => boolean,
): Promise<void> {
  const manifest = await readManifest(join(stagedPackageRoot, "package.json"), "Staged build manifest");
  if (!isRecord(manifest)) { throw new Error("Staged build manifest must be an object."); }
  if (!isRecord(manifest.devDependencies) || typeof manifest.devDependencies.typescript !== "string") { return; }
  const physicalStage = await realpath(stagedPackageRoot);
  const compilerRoot = await realpath(join(physicalStage, "node_modules", "typescript"));
  if (!containsPath(physicalStage, compilerRoot)) {
    throw new Error("Staged compiler resolves outside its build stage.");
  }
  const compilerManifest = await readManifest(join(compilerRoot, "package.json"), "Staged compiler manifest");
  if (!isRecord(compilerManifest)) { throw new Error("Staged compiler manifest must be an object."); }
  const entry = isRecord(compilerManifest.bin) ? compilerManifest.bin.tsc : undefined;
  if (compilerManifest.name !== "typescript" || typeof entry !== "string") {
    throw new Error("Staged TypeScript compiler has no declared tsc entrypoint.");
  }
  const parts = entry.replace(/^\.\//u, "").split("/");
  if (parts.some(part => part === "" || part === "." || part === "..") ||
      isAbsolute(entry) || entry.includes("\\") || entry.includes(":") ||
      Array.from(entry).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error("Staged compiler entrypoint escapes its package.");
  }
  const target = join(compilerRoot, ...parts);
  if (await realpath(target) !== target || !(await lstat(target)).isFile()) {
    throw new Error("Staged compiler entrypoint is not an independent regular file.");
  }
  const bytes = await readExecutable(target);
  if (!bytes.toString("utf8").startsWith("#!/usr/bin/env node")) {
    throw new Error("Staged compiler entrypoint is not a supported Node executable.");
  }
  const binRoot = join(physicalStage, "node_modules", ".bin");
  await mkdir(binRoot, { recursive: true });
  if (await realpath(binRoot) !== binRoot) {
    throw new Error("Staged compiler shim directory is not physically contained.");
  }
  if (process.platform === "win32") {
    if (/[\r\n%!"]/u.test(process.execPath + target)) {
      throw new Error("Staged compiler path cannot be represented safely in a cmd shim.");
    }
    await writeFile(join(binRoot, "tsc.cmd"),
      `@echo off\r\n"${process.execPath}" "${target}" %*\r\n`, { flag: "wx" });
  } else {
    await writeFile(join(binRoot, "tsc"),
      `#!/bin/sh\nexec ${shellLiteral(process.execPath)} ${shellLiteral(target)} "$@"\n`, { flag: "wx", mode: 0o755 });
  }
}

