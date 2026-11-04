import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FixturePut } from "./packed-quality-layout.ts";
import type { QualityFixtureInvoke } from "./packed-quality-lint-protections.ts";
import { runQualityCommand } from "./packed-quality-command.ts";
import { qualityFixtureRecord, qualityFixtureReport } from "./quality-command-report.ts";

/** Real installed CLI/tools, with one test-owned config mutation at the first Oxlint spawn.
 * The preloader is outside the consumer census and is not inherited by tool children.
 * POSIX only: Windows' native process host does not expose tool spawn in the CLI process.
 */
export async function qualifyInstalledInputDrift(input: {
  readonly root: string;
  readonly cli: string;
  readonly main: string;
  readonly put: FixturePut;
  readonly invoke: QualityFixtureInvoke;
}): Promise<"passed" | "unsupported-platform"> {
  if (process.platform === "win32") {
    return "unsupported-platform";
  }
  const { root, cli, main, put, invoke } = input;
  const temporary = await mkdtemp(join(tmpdir(), "quality-input-drift-"));
  const configPath = join(root, "lint.json");
  const original = await readFile(configPath, "utf8");
  const mainBytes = await readFile(join(root, main), "utf8");
  const lint = qualityFixtureRecord(JSON.parse(original));
  const weakened = `${JSON.stringify({ ...lint, rules: { "typescript/no-floating-promises": "off" } }, null, 2)}\n`;
  const toolchain = await realpath(join(root, "node_modules/stack-toolchain/package.json"));
  const oxlintManifest = createRequire(toolchain).resolve("oxlint/package.json");
  const oxlint = await realpath(join(dirname(oxlintManifest), "bin/oxlint"));
  const log = join(temporary, "spawn-events.jsonl");
  const preloader = join(temporary, "quality-input-drift-preloader.ts");
  try {
    await put(main, "export const value = 1;\nPromise.resolve(2);\n");
    const faulty = await invoke(["quality", "check"], 1);
    assert.ok(
      faulty.capabilities[0].diagnostics.some(({ evidence }) =>
        evidence.some(({ value }) => value === "typescript(no-floating-promises)"),
      ),
    );
    await writeFile(
      preloader,
      await readFile(new URL("./fixtures/quality-input-drift-preloader.ts", import.meta.url)),
    );
    await writeFile(
      join(temporary, "quality-input-drift-preloader.json"),
      JSON.stringify({
        config: configPath,
        expected: original,
        replacement: weakened,
        oxlint,
        log,
      }),
    );
    const result = await runQualityCommand(
      [
        "--import",
        pathToFileURL(preloader).href,
        cli,
        "quality",
        "check",
        "--consumer",
        root,
        "--format",
        "json",
      ],
      root,
    );
    assert.ok(result.code === 2 || result.code === 3, result.stdout || result.stderr);
    const report = qualityFixtureReport(result.stdout);
    assert.ok(report.outcome === "invalid-input" || report.outcome === "failed");
    assert.match(report.capabilities[0].problem?.message ?? "", /input changed|inventory changed/u);
    const events = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => qualityFixtureRecord(JSON.parse(line)));
    assert.equal(events.filter((event) => event["event"] === "mutated").length, 1);
    assert.ok(
      events.some(
        (event) =>
          event["event"] === "tool-closed" && event["code"] === 0 && event["signal"] === null,
      ),
      "Real pinned Oxlint must execute after the mutation",
    );
    assert.equal(await readFile(configPath, "utf8"), weakened);
    const weak = await invoke(["quality", "check"], 1);
    assert.ok(
      weak.capabilities[0].diagnostics.some(
        ({ ruleId }) => ruleId === "quality.source-coverage.protected-setting",
      ),
    );
    await writeFile(configPath, original);
    await put(main, "export const value = 1;\nvoid Promise.resolve(2);\n");
    assert.equal((await invoke(["quality", "check"])).outcome, "passed");
    return "passed";
  } finally {
    await writeFile(configPath, original);
    await put(main, mainBytes);
    await rm(temporary, { recursive: true, force: true });
  }
}
