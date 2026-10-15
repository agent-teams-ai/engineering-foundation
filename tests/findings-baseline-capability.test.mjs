import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { copyPinnedToolchain } from "./features/quality-coverage/copied-toolchain.mjs";

const cli = join(dirname(dirname(fileURLToPath(import.meta.url))), "packages/engineering-foundation/dist/cli.js");
const baselinePath = "architecture/findings-baseline.jsonl";
const lines = (count) => `${Array.from({ length: count }, (_, index) => `export const value${index} = ${index};`).join("\n")}\n`;
const methodStyle = "export interface Shape {\n  area(): number;\n}\n";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ef-findings-baseline-TEST-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path, value) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  const pins = await copyPinnedToolchain(root);
  await put("package.json", { name: "findings-baseline-test", private: true, type: "module", devDependencies: pins });
  await put("pnpm-workspace.yaml", "packages: []\n");
  await put("lint.json", { rules: { "max-lines": ["error", { max: 3 }], "typescript/method-signature-style": "error" } });
  await put("findings.yaml", { schemaVersion: 1, baselinePath, oxlint: { configPath: "lint.json", roots: ["src"], measuredRules: ["eslint/max-lines"] } });
  await put("foundation.config.yaml", { schemaVersion: 2, project: { id: "findings-baseline-test" },
    capabilities: { "quality.findings-baseline": { configPath: "findings.yaml" } } });
  await put("src/big.ts", lines(6));
  await put("src/shape.ts", methodStyle);
  await put("src/small.ts", lines(2));
  const run = async (...args) => {
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [cli, ...args, "--consumer", root, "--format", "json"], { cwd: root });
      return { code: 0, output: JSON.parse(stdout) };
    } catch (error) { return { code: error.code, output: JSON.parse(error.stdout) }; }
  };
  const diagnostics = async () => {
    const { code, output } = await run("check", "quality.findings-baseline");
    return { code, outcome: output.outcome, rules: output.capabilities[0].diagnostics.map(({ ruleId, location }) => `${ruleId.split(".").pop()} ${location.path}`).toSorted() };
  };
  return { root, put, run, diagnostics, baseline: () => readFile(join(root, baselinePath), "utf8") };
}

test("the findings baseline shrinks: init, check, new, worse, stale, prune and a refused second init", async (t) => {
  const { put, run, diagnostics, baseline } = await fixture(t);
  assert.equal((await diagnostics()).outcome, "invalid-input", "a missing baseline is an input error, not a pass");
  const created = await run("baseline", "init");
  assert.equal(created.code, 0, JSON.stringify(created));
  assert.equal(created.output.baseline.entries, 2);
  assert.equal(await baseline(), [
    '{"findingsBaseline":1}',
    '{"path":"src/big.ts","rule":"oxlint/eslint/max-lines","count":1,"max":6}',
    '{"path":"src/shape.ts","rule":"oxlint/typescript/method-signature-style","count":1}', ""
  ].join("\n"));
  assert.deepEqual(await diagnostics(), { code: 0, outcome: "passed", rules: [] });
  const refused = await run("baseline", "init");
  assert.notEqual(refused.code, 0);
  assert.match(JSON.stringify(refused.output), /FINDINGS_BASELINE_EXISTS/u);

  await put("src/big.ts", lines(7));
  assert.deepEqual((await diagnostics()).rules, ["worse-finding src/big.ts"]);
  await put("src/new.ts", lines(5));
  assert.deepEqual((await diagnostics()).rules, ["new-finding src/new.ts", "worse-finding src/big.ts"]);
  const pruneNew = await run("baseline", "prune");
  assert.equal(pruneNew.code, 1, "prune cannot accept new or worse findings");
  assert.deepEqual(pruneNew.output.baseline.remaining.map(({ kind }) => kind), ["worse", "new"]);

  await put("src/new.ts", lines(1));
  await put("src/big.ts", lines(4));
  assert.deepEqual((await diagnostics()).rules, ["stale-entry src/big.ts"]);
  const pruned = await run("baseline", "prune");
  assert.equal(pruned.code, 0, JSON.stringify(pruned));
  assert.equal(pruned.output.baseline.lowered, 1);
  assert.match(await baseline(), /"max":4/u);
  assert.deepEqual(await diagnostics(), { code: 0, outcome: "passed", rules: [] });

  await put("src/shape.ts", "export interface Shape {\n  area: () => number;\n}\n");
  assert.deepEqual((await diagnostics()).rules, ["stale-entry src/shape.ts"]);
  assert.equal((await run("baseline", "prune")).output.baseline.removed, 1);
  assert.doesNotMatch(await baseline(), /shape/u);
  assert.deepEqual(await diagnostics(), { code: 0, outcome: "passed", rules: [] });
});

test("a hand-edited baseline that is not canonical is rejected", async (t) => {
  const { put, run, diagnostics } = await fixture(t);
  assert.equal((await run("baseline", "init")).code, 0);
  await put(baselinePath, '{"findingsBaseline":1}\n{"path":"src/big.ts","rule":"oxlint/eslint/max-lines","count":1,"max":600,"expires":"2027-01-01"}\n');
  assert.equal((await diagnostics()).outcome, "invalid-input");
});
