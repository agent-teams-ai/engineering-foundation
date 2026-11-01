import assert from "node:assert/strict";
import fs from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { run } from "node:test";
type RunOptions = NonNullable<Parameters<typeof run>[0]>;
const unknownBinding: unknown = JSON.parse(fs.readFileSync(new URL("./source-binding.json", import.meta.url), "utf8"));
assert.ok(unknownBinding !== null && typeof unknownBinding === "object" && "state" in unknownBinding
  && unknownBinding.state === "committed" && "source" in unknownBinding
  && typeof unknownBinding.source === "string" && /^[a-f0-9]{40}$/u.test(unknownBinding.source)
  && unknownBinding.source !== "0".repeat(40), "SOURCE_HOLD");
assert.ok("repairPatchSHA256" in unknownBinding && unknownBinding.repairPatchSHA256 === "18b100b490e8ce87856c6fde0c5cd21a1b70a9aec8a481618e0f45f2eec76aed", "REPAIR_BINDING_DRIFT");
const expectedSource = unknownBinding.source;
const [sourceArg, evidenceArg] = process.argv.slice(2);
assert.ok(sourceArg && evidenceArg);
assert.equal(process.platform, "win32"); assert.equal(process.version, "v26.11.1");
const source = fs.realpathSync(resolve(sourceArg)), evidence = resolve(evidenceArg);
assert.equal(execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), expectedSource, "SOURCE_HEAD_DRIFT");
const literal = "packages/stack-toolchain/tests/format-files.test.ts";
const literalAbsolute = join(source, literal).replaceAll("\\", "/");
const witness = "tests/command-host-successor-cli.test.mts";
const contract = fs.readFileSync(join(source, "architecture/foundation/node-test-execution.json"));
const parents = new Map<string, string>(), cases: { name: string; outcome: string; kind: string }[] = [];
const preloadEntries = new Set<string>();
const preloadURL = new URL("./preload.ts", import.meta.url).href;
assert.ok(preloadURL.startsWith("file:"));
let markers = 0;
const runOptions: RunOptions = {
  execArgv: ["--import", preloadURL],
  setup(stream) {
    stream.on("test:complete", data => {
      const entry = "entryFile" in data && typeof data.entryFile === "string"
        ? data.entryFile.replaceAll("\\", "/") : undefined;
      if (entry === literal || entry === literalAbsolute) {
        const active = (v: unknown) => v === true || typeof v === "string";
        const outcome = active(data.skip) || active(data.todo) ? "not-executed" : data.details.passed ? "pass" : "fail";
        cases.push({ name: data.name, outcome, kind: data.details.type ?? "unknown" });
        if (data.name.startsWith("literal ")) parents.set(data.name, outcome);
      }
    });
    stream.on("test:stderr", data => {
      if (markers < 8 && typeof data.message === "string" && data.message.includes('"diagnostic":"focused-preload-start"')) {
        process.stderr.write(data.message.slice(0, 2048));
        for (const line of data.message.split("\n")) {
          try {
            const marker: unknown = JSON.parse(line);
            if (marker !== null && typeof marker === "object" && "diagnostic" in marker
              && marker.diagnostic === "focused-preload-start" && "entry" in marker && typeof marker.entry === "string") {
              markers++; preloadEntries.add(marker.entry);
            }
          } catch { /* Non-marker bytes cannot prove startup. */ }
        }
      }
    });
  },
};
const module = await import(pathToFileURL(join(source, "scripts/run-test-shard.mjs")).href) as {
  runTestShardTests(files: string[], options: { runOptions: RunOptions; timingDirectory: string }, root: string): Promise<number>;
};
assert.equal(typeof module.runTestShardTests, "function");
const exit = await module.runTestShardTests([literal, witness], { runOptions, timingDirectory: join(evidence, "timing") }, source);
assert.deepEqual(fs.readFileSync(join(source, "architecture/foundation/node-test-execution.json")), contract);
fs.writeFileSync(join(evidence, "canonical-result.json"), JSON.stringify({ source: expectedSource, exit,
  runner: "existing runTestShardTests -> maybeRunMandatoryNodeTests -> runNodeTestExecution -> node:test.run",
  files: [literal, witness], literalParents: [...parents], literalCases: cases,
  preloadURL, preloadEntries: [...preloadEntries], sourceWorkingDirectory: source, mandatoryContractUnchanged: true,
  controlledMetadataSubcasesNotNativeHighInodeEvidence: true,
}, null, 2) + "\n", { flag: "wx" });
assert.deepEqual([...preloadEntries].sort(), ["literal", "witness"], "BOTH_PRELOAD_STARTS_REQUIRED");
assert.equal(parents.size, 9, "NINE_LITERAL_PARENTS_REQUIRED");
assert.equal(cases.length, 12, "TWELVE_LITERAL_NODE_CASES_REQUIRED");
assert.equal(cases.every(item => item.outcome === "pass"), true, "NO_LITERAL_SKIP_OR_FAILURE");
assert.equal(exit, 0, "CANONICAL_RUNNER_MUST_PASS");
