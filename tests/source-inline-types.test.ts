import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { observeSourceGraph } from "../packages/engineering-foundation/dist/source-graph.js";

const forms = [
  ["inline-import", 'import { type Shape } from "./target.ts";', "static", "runtime"],
  ["inline-export", 'export { type Shape } from "./target.ts";', "export", "runtime"],
  ["type-import", 'import type { Shape } from "./target.ts";', "static-type", "type-only"],
  ["type-export", 'export type { Shape } from "./target.ts";', "export-type", "type-only"],
] as const;

void test("inline type specifiers retain the module load that declaration type syntax erases", async (t) => {
  const consumerRoot = await mkdtemp(join(tmpdir(), "source-inline-types-"));
  t.after(() => rm(consumerRoot, { recursive: true, force: true }));
  await mkdir(join(consumerRoot, "src"));
  await writeFile(join(consumerRoot, "package.json"), '{"type":"module"}\n');
  await writeFile(join(consumerRoot, "src/target.ts"), 'console.log("TYPE_TARGET_LOADED");\nexport interface Shape {}\n');
  for (const [name, statement] of forms) {
    await writeFile(join(consumerRoot, "src", `${name}.ts`), `${statement}\nexport const ready = true;\n`);
  }
  const graph = await observeSourceGraph({ consumerRoot, roots: ["src"] });
  assert.deepEqual(graph.parseFailures, []);
  assert.deepEqual(graph.unresolved, []);
  assert.deepEqual(graph.edges, forms.map(([name, , kind, mode]) => ({
    from: `src/${name}.ts`, to: "src/target.ts", kind, mode, line: 1,
  })).toSorted((left, right) => left.from < right.from ? -1 : left.from > right.from ? 1 : 0));

  // Node type stripping demonstrates the module request independently of either
  // parser's classification; matching parser answers alone would miss this bug.
  for (const [name, , , mode] of forms) {
    const result = spawnSync(process.execPath, [join(consumerRoot, "src", `${name}.ts`)], {
      cwd: consumerRoot, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), mode === "runtime" ? "TYPE_TARGET_LOADED" : "", name);
  }
});
