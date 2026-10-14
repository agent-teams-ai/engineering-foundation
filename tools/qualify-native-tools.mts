import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();

function observed(command: string, args: readonly string[]): string {
  const result = spawnSync(command, [...args], { cwd: root, encoding: "utf8", timeout: 30_000 });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`Native tool qualification failed for ${command}: ${result.stderr}`);
  }
  return `${result.stdout}${result.stderr}`.trim();
}

const expected = [
  { name: "oxlint", command: resolve(root, "node_modules/.bin/oxlint"), args: ["--version"], contains: "1.83.0" },
  { name: "typescript", command: resolve(root, "node_modules/.bin/tsc"), args: ["--version"], contains: "7.0.2" },
  { name: "nx", command: resolve(root, "node_modules/.bin/nx"), args: ["--version"], contains: "23.1.1" },
  { name: "esbuild", command: resolve(root, "node_modules/.bin/esbuild"), args: ["--version"], contains: "0.28.2" }
] as const;

for (const tool of expected) {
  const output = observed(tool.command, tool.args);
  if (!output.includes(tool.contains)) {
    throw new Error(`${tool.name} version mismatch: ${output}`);
  }
}

const oxcManifest = JSON.parse(await readFile(resolve(root, "node_modules/oxc-parser/package.json"), "utf8")) as { readonly version?: string };
if (oxcManifest.version !== "0.142.0") {
  throw new Error(`Oxc parser version mismatch: ${oxcManifest.version ?? "missing"}`);
}
observed(process.execPath, ["-e", "require('oxc-parser').parseSync('qualification.ts','export const value: number = 1;')"]);

process.stdout.write("Pinned Oxlint, TypeScript 7, Oxc, Nx and esbuild tools qualified.\n");
