import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

const required = ["architecture:check", "typecheck", "effect:check", "runtime:check"];
const manifest = record(JSON.parse(await readFile("package.json", "utf8")));
const scripts = record(manifest["scripts"]);
const routes = {
  check: "pnpm lint:typed && node scripts/check-full.ts",
  "check:fast": "pnpm quality:scope",
  "lint:typed": "agent-teams-foundation quality check --consumer . --format json",
  "quality:scope": "agent-teams-foundation quality check --consumer . --scope-only --format json",
  "architecture:check": "agent-teams-foundation check architecture.source-dependencies --consumer . --format json",
  typecheck: "stack-toolchain typecheck --json",
  "effect:check": "node scripts/check-effect.ts",
  "runtime:check": "node scripts/check-runtime.ts",
};
for (const [name, route] of Object.entries(routes)) {
  assert.equal(scripts[name], route, "Required consumer route changed: " + name);
}
const gate = record(JSON.parse(await readFile("architecture/gates.json", "utf8")));
assert.ok(Array.isArray(gate["profiles"]));
const profile = gate["profiles"].map(record).find((value) => value["id"] === "full");
assert.ok(profile);
assert.ok(Array.isArray(profile["tasks"]));
const tasks = profile["tasks"].map(record);
assert.deepEqual(tasks.map((task) => task["id"]).toSorted(), required.toSorted(), "Missing mandatory consumer gate");
assert.deepEqual(tasks.find((task) => task["id"] === "runtime:check")?.["needs"], ["architecture:check", "typecheck", "effect:check"], "Runtime must wait for every static gate");
const cli = join(dirname(fileURLToPath(import.meta.resolve("@agent-teams/engineering-foundation/package.json"))), "dist/cli.js");
// QGR owns descendant containment and SIGTERM cancellation. The outer installed
// qualification owns the bounded process tree for this entire route.
const result = spawnSync(process.execPath, [cli, "gate", "run", "full", "--consumer", ".", "--format", "json"], {
  encoding: "utf8", timeout: 300_000, killSignal: "SIGTERM", maxBuffer: 4 * 1024 * 1024,
});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.error !== undefined) throw result.error;
const report = record(JSON.parse(result.stdout));
assert.equal(report["reportSchemaVersion"], 1);
assert.ok(Array.isArray(report["tasks"]));
const observed = report["tasks"].map(record);
assert.deepEqual(observed.map((task) => task["id"]).toSorted(), required.toSorted());
if (result.status === 0) {
  assert.equal(report["outcome"], "passed");
  assert.ok(observed.every((task) => task["outcome"] === "passed"));
}
process.exitCode = result.status ?? 1;
