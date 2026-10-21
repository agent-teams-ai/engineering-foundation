import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createCheckerRunner } from "../src/features/toolchain-execution/adapters/process.ts";
import { resolveExecutables } from "../src/features/toolchain-execution/adapters/executables.ts";
import { typecheck } from "../src/features/toolchain-execution/application/typecheck.ts";

const child = fileURLToPath(new URL("./checker-child.ts", import.meta.url));
const now = () => performance.now();
const executable = (mode: string) => ({ command: process.execPath, prefix: [child, mode] });

for (const mode of ["pass", "diagnostics", "unknown", "diagnostics-timeout"]) {
  test(`real child: ${mode}, with no unwanted fallback`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "TEST-stack-checker-"));
    try {
      const run = createCheckerRunner({ cwd, now, executables: {
        tsrs: executable(mode), bun: executable("pass"), typescript: executable("pass")
      } });
      const result = await typecheck({ projects: ["tsconfig.json"],
        signal: new AbortController().signal, attemptBudgetMs: 500, budgetMs: 3_000 }, { now, run });
      assert.equal(result.status, mode === "pass" ? "passed" : "failed");
      if (mode.startsWith("diagnostics")) {
        assert.equal(result.status === "failed" && result.code, "TOOLCHAIN_DIAGNOSTICS");
      }
      assert.equal((await readFile(join(cwd, "invocations.txt"), "utf8")).trim().split("\n").length, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test("real fallback runs Bun only when primary binary is unavailable", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "TEST-stack-fallback-"));
  try {
    const run = createCheckerRunner({ cwd, now, executables: {
      tsrs: null, bun: executable("pass"), typescript: executable("unknown")
    } });
    const result = await typecheck({ projects: ["one.json", "two.json"],
      signal: new AbortController().signal }, { now, run });
    assert.equal(result.status, "passed-with-fallback");
    assert.equal(result.engine, "bun");
    const trace = await readFile(join(cwd, "invocations.txt"), "utf8");
    assert.equal(trace.trim().split("\n").length, 2);
    assert.match(trace, /check --no-pretty .* -p one.json/u);
    assert.match(trace, /check --no-pretty .* -p two.json/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Bun fallback never dispatches consumer scripts.check", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "TEST-stack-bun-script-"));
  try {
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { check: "touch injected-marker" } }));
    await writeFile(join(cwd, "index.ts"), "const value: string = 12;");
    await writeFile(join(cwd, "tsconfig.json"), JSON.stringify({ files: ["index.ts"] }));
    const engines = resolveExecutables();
    assert.notEqual(engines.bun, null);
    const run = createCheckerRunner({ cwd, now, executables: { ...engines, tsrs: null } });
    const result = await typecheck({ projects: [join(cwd, "tsconfig.json")], signal: new AbortController().signal }, { now, run });
    assert.equal(result.status, "failed");
    assert.equal(result.status === "failed" && result.code, "TOOLCHAIN_DIAGNOSTICS");
    await assert.rejects(readFile(join(cwd, "injected-marker")), /ENOENT/u);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('all installed checkers retain composite diagnostics without metadata writes', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'TEST-stack-composite-'));
  try {
    await writeFile(join(cwd, 'package.json'), '{}');
    await writeFile(join(cwd, 'index.ts'), 'export const value = 1;');
    await writeFile(join(cwd, 'tsconfig.json'), JSON.stringify({ files: ['index.ts'], compilerOptions: { composite: true, skipLibCheck: true } }));
    const engines = resolveExecutables();
    for (const engine of ['tsrs', 'bun', 'typescript'] as const) {
      if (engine === "tsrs" && engines.tsrs === null) {continue;}
      assert.notEqual(engines[engine], null, `Native qualification requires ${engine}`);
      const run = createCheckerRunner({ cwd, now, executables: engines });
      const input = { engine, projects: [join(cwd, 'tsconfig.json')], signal: new AbortController().signal, deadline: now() + 30_000 };
      assert.equal((await run(input)).outcome.kind, 'passed');
      await assert.rejects(readFile(join(cwd, 'tsconfig.tsbuildinfo')), /ENOENT/u);
      await writeFile(join(cwd, 'extra.ts'), 'export const other = 1;');
      await writeFile(join(cwd, 'index.ts'), 'import { other } from "./extra"; export const value = other;');
      const result = await run({ ...input, deadline: now() + 30_000 });
      assert.equal(result.outcome.kind, 'diagnostics');
      assert.match(result.diagnostics.join('\n'), /TS6307/u);
      await assert.rejects(readFile(join(cwd, 'tsconfig.tsbuildinfo')), /ENOENT/u);
      await writeFile(join(cwd, 'index.ts'), 'export const value = 1;');
      await rm(join(cwd, 'extra.ts'));
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
