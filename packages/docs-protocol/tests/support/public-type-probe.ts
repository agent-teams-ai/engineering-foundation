import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const compiler = fileURLToPath(
  new URL("../../../../node_modules/typescript/bin/tsc", import.meta.url),
);
const compilerManifest: unknown = JSON.parse(
  await readFile(
    new URL("../../../../node_modules/typescript/package.json", import.meta.url),
    "utf8",
  ),
);
assert.ok(
  typeof compilerManifest === "object" &&
    compilerManifest !== null &&
    "version" in compilerManifest,
);
assert.equal(
  compilerManifest.version,
  "7.0.2",
  "Public type probes require the pinned TypeScript compiler.",
);

export function wireUnion(values: readonly unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join(" | ");
}
