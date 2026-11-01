// Reuse the existing private shard/mandatory runner; no contract or runner clone.
import assert from "node:assert/strict";
import fs from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "node:test";
type RunOptions = NonNullable<Parameters<typeof run>[0]>;
const [sourceArg, evidenceArg, phase] = process.argv.slice(2);
assert.ok(sourceArg && evidenceArg && (phase === "baseline" || phase === "candidate"));
const source = fs.realpathSync(resolve(sourceArg)), evidence = resolve(evidenceArg);
assert.equal(process.platform, "win32");
assert.equal(process.version, "v26.11.1");
const literal = "packages/stack-toolchain/tests/format-files.test.ts";
const witness = "tests/command-host-successor-cli.test.mts";
const contract = fs.readFileSync(join(source, "architecture/foundation/node-test-execution.json"));
const completed = new Map<string, string>();
let diagnostics = 0;
const preloadEntries = new Set<string>();
const preloadURL = new URL("./fs-errors.ts", import.meta.url).href;
assert.ok(preloadURL.startsWith("file:"));
const runOptions: RunOptions = {
  execArgv: ["--import", preloadURL],
  setup(stream) {
    stream.on("test:complete", (data) => {
      if (typeof data.name === "string" && data.name.startsWith("literal ") && "entryFile" in data && typeof data.entryFile === "string") {
        const active = (v: unknown) => v === true || typeof v === "string";
        completed.set(data.name, active(data.skip) || active(data.todo) ? "not-executed" : data.details.passed ? "pass" : "fail");
      }
    });
    stream.on("test:stderr", (data) => {
      if (diagnostics++ < 48 && typeof data.message === "string" && data.message.includes('"diagnostic":')) {
        process.stderr.write(data.message.slice(0, 4096));
        for (const line of data.message.split("\n")) {
          try {
            const marker: unknown = JSON.parse(line);
            if (marker !== null && typeof marker === "object" && "diagnostic" in marker
              && marker.diagnostic === "fd-preload-start" && "entry" in marker && typeof marker.entry === "string") {
              preloadEntries.add(marker.entry);
            }
          } catch { /* A non-marker diagnostic cannot prove preload startup. */ }
        }
      }
    });
  },
};
const module = await import(pathToFileURL(join(source, "scripts/run-test-shard.mjs")).href) as {
  runTestShardTests(files: string[], options: { runOptions: RunOptions; timingDirectory: string }, root: string): Promise<number>;
};
assert.equal(typeof module.runTestShardTests, "function");
const exit = await module.runTestShardTests([literal, witness], {
  runOptions, timingDirectory: join(evidence, phase + "-timing"),
}, source);
assert.deepEqual(fs.readFileSync(join(source, "architecture/foundation/node-test-execution.json")), contract);
fs.writeFileSync(join(evidence, phase + "-canonical.json"), JSON.stringify({
  source: "def877a5fa2c9402c7bd5f7bb96f7d85dd9ea09a", phase, exit,
  runner: "existing runTestShardTests -> maybeRunMandatoryNodeTests -> runNodeTestExecution -> node:test.run",
  files: [literal, witness], literalCompleted: [...completed], mandatoryContractUnchanged: true,
  preloadURL, preloadEntries: [...preloadEntries], sourceWorkingDirectory: source,
}, null, 2) + "\n", { flag: "wx" });
assert.equal(preloadEntries.has("literal"), true, "LITERAL_PRELOAD_START_REQUIRED");
assert.equal(completed.size, 8, "ALL_EIGHT_LITERAL_IDENTITIES_MUST_COMPLETE");
assert.equal([...completed.values()].includes("not-executed"), false);
process.exitCode = exit;
