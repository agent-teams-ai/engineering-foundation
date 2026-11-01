import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { classifyFormatCoverage } from "../../../packages/engineering-foundation/dist/features/quality-coverage/application/format-coverage.js";
import { createSourceCensusReader } from "../../../packages/engineering-foundation/dist/capabilities/source-dependencies/module.js";
import { readContainedRegularFile } from "../../../packages/engineering-foundation/dist/source-inventory/node.js";
import { createSchemaCatalog } from "../../../packages/engineering-foundation/dist/features/configuration-input/module.js";
import { createQualityGateCommand } from "../../../packages/engineering-foundation/dist/capabilities/quality-gate-runner/application/use-cases/create-quality-gate-command.js";
import { runQualityGateProfile } from "../../../packages/engineering-foundation/dist/capabilities/quality-gate-runner/application/use-cases/run-quality-gate-profile.js";
import {
  PackageScriptCancellationError,
  PackageScriptTimeoutError,
} from "../../../packages/engineering-foundation/dist/capabilities/quality-gate-runner/application/ports/package-script-executor.js";
import type { NormalizedQualityGateProfile } from "../../../packages/engineering-foundation/dist/capabilities/quality-gate-runner/application/model/quality-gate.js";

const passed = { exitCode: 0, signal: null, stdout: "", stderr: "" } as const;
const profile: NormalizedQualityGateProfile = {
  id: "authorities",
  packageManager: "pnpm",
  concurrency: 1,
  tasks: [
    { id: "first", needs: [], after: [], timeoutMs: 90 },
    { id: "second", needs: ["first"], after: [], timeoutMs: 90 },
  ],
};

export function registerFormatCoverageSeams(): void {
  registerFormatInputCases();
  registerFormatGateCases();
}

function registerFormatInputCases(): void {
  void test("format census observes ignored metadata and generated directories without changing source defaults", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "format-observation-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const put = async (path: string, text = "{}") => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    };
    await put("package.json", '{"name":"fixture","private":true}');
    for (const path of [
      "src/a.ts",
      "dist/new.json",
      "coverage/new.yaml",
      "hidden/new.json",
      "root.json",
      "node_modules/ignored.json",
      ".git/ignored.json",
    ]) {
      await put(path);
    }
    await put(".gitignore", "hidden\ndist\ncoverage\n");
    const census = createSourceCensusReader({ read: readContainedRegularFile });
    const ordinary = await census.read({ consumerRoot: root, roots: ["."] });
    assert.equal(ordinary.filePaths.includes("dist/new.json"), false);
    assert.equal(ordinary.filePaths.includes("coverage/new.yaml"), false);
    const full = await census.read({
      consumerRoot: root,
      roots: ["."],
      generatedDirectories: "observe",
    });
    assert.deepEqual(full.filePaths, [
      ".gitignore",
      "coverage/new.yaml",
      "dist/new.json",
      "hidden/new.json",
      "package.json",
      "root.json",
      "src/a.ts",
    ]);
    await put("dist/later.unknown");
    const next = await census.read({
      consumerRoot: root,
      roots: ["."],
      generatedDirectories: "observe",
    });
    assert.equal(next.filePaths.includes("dist/later.unknown"), true);
    await symlink(join(root, "src/a.ts"), join(root, "dist/linked.ts"));
    await assert.rejects(
      census.read({ consumerRoot: root, roots: ["."], generatedDirectories: "observe" }),
      /symbolic link/u,
    );
  });

  void test("format closure retains unknown families, stale selectors and ambiguous authorities as failures", () => {
    const selection = {
      maintainedRoots: ["src"],
      routes: [
        { authority: "records", files: [], trees: [{ path: "records", suffixes: [".json"] }] },
      ],
    };
    const paths = [
      "root.json",
      "src/a.ts",
      "records/a.json",
      "records/new.unknown",
      "new/config.yaml",
    ];
    const result = classifyFormatCoverage(paths, selection);
    assert.deepEqual(result.formatFiles, ["root.json", "src/a.ts"]);
    assert.deepEqual([...result.authorityFiles], [["records", ["records/a.json"]]]);
    assert.deepEqual(result.problems, [
      "unclassified-family:new/config.yaml",
      "unclassified-family:records/new.unknown",
    ]);
    assert.deepEqual(
      classifyFormatCoverage(paths, { ...selection, maintainedRoots: [] }).problems,
      [
        "unclassified-family:new/config.yaml",
        "unclassified-family:records/new.unknown",
        "unclassified-family:src/a.ts",
      ],
    );
    const refused = classifyFormatCoverage(paths, {
      maintainedRoots: ["empty"],
      routes: [
        selection.routes[0]!,
        { authority: "other", files: ["records/a.json", "absent.json"], trees: [] },
      ],
    });
    assert.ok(refused.problems.includes("empty-root:empty"));
    assert.ok(refused.problems.includes("ambiguous-authority:records/a.json"));
    assert.ok(refused.problems.includes("stale-file:absent.json"));
    assert.deepEqual(classifyFormatCoverage([], { maintainedRoots: [], routes: [] }).problems, [
      "empty-inventory",
    ]);
  });

  void test("strict format schema rejects scope escape, unknown fields and unowned selectors", async () => {
    const catalog = createSchemaCatalog({
      schemaIds: ["format"],
      dependencies: {},
      readSchema: () =>
        readFile(
          new URL(
            "../../../packages/engineering-foundation/schemas/quality-format-coverage/v1.schema.json",
            import.meta.url,
          ),
          "utf8",
        ),
    });
    const valid = {
      schemaVersion: 1,
      owner: "tooling",
      budgetMs: 100,
      maintainedRoots: ["src"],
      rootFiles: "format-or-reject",
      scripts: { format: "format:check", required: ["check"] },
      authorities: [],
      routes: [],
    };
    await catalog.assertSchema("format", valid, "format");
    const invalid: readonly unknown[] = [
      { ...valid, schemaVersion: 2 },
      { ...valid, ignore: ["unknown"] },
      { ...valid, maintainedRoots: [] },
      { ...valid, budgetMs: 0 },
      ...[
        "../escape",
        "/absolute",
        "a/../b",
        "a\\b",
        "node_modules",
        "a/.git/hidden",
        "a\u0000b",
      ].map((path) => ({ ...valid, maintainedRoots: [path] })),
      { ...valid, scripts: { ...valid.scripts, noop: "true" } },
      {
        ...valid,
        authorities: [
          { id: "a", owner: "owner", script: "verify", execution: "read-only-source-validation" },
        ],
        routes: [{ authority: "a", kind: "retained", files: ["record.json"], trees: [] }],
      },
      { ...valid, authorities: [{ id: "a", owner: "o", script: "verify", execution: "build" }] },
      { ...valid, routes: [{ authority: "a", kind: "retained", files: [], trees: [] }] },
    ];
    for (const value of invalid) {
      await assert.rejects(catalog.assertSchema("format", value, "format"));
    }
  });
}

function registerFormatGateCases(): void {
  void test("one aggregate gate deadline reduces later task budgets and rejects late success", async () => {
    let now = 0;
    const budgets: (number | undefined)[] = [];
    const report = await runQualityGateProfile(
      { consumerRoot: "/fixture", profile, deadlineMs: 100 },
      {
        run: async (input) => {
          budgets.push(input.timeoutMs);
          now += 60;
          return passed;
        },
      },
      { nowMs: () => now },
    );
    assert.deepEqual(budgets, [90, 40]);
    assert.deepEqual(
      report.tasks.map(({ outcome }) => outcome),
      ["passed", "timed-out"],
    );
    assert.equal(report.outcome, "failed");
    const starts: string[] = [];
    const expired = await runQualityGateProfile(
      { consumerRoot: "/fixture", profile, deadlineMs: 100 },
      {
        run: async ({ scriptId }) => {
          starts.push(scriptId);
          return passed;
        },
      },
      { nowMs: () => 100 },
    );
    assert.deepEqual(starts, []);
    assert.equal(expired.outcome, "failed");
    const oldBudgets: (number | undefined)[] = [];
    const legacy = await runQualityGateProfile(
      { consumerRoot: "/fixture", profile },
      {
        run: async ({ timeoutMs }) => {
          oldBudgets.push(timeoutMs);
          return passed;
        },
      },
      { nowMs: () => (now += 100) },
    );
    assert.equal(legacy.outcome, "passed");
    assert.deepEqual(oldBudgets, [90, 90]);
  });

  void test("aggregate deadline preserves cancellation and genuine task failure precedence", async () => {
    for (const mode of ["pre-abort", "cancel", "failure", "timeout"]) {
      const abort = new AbortController();
      let now = mode === "pre-abort" ? 100 : 0;
      let starts = 0;
      if (mode === "pre-abort") {
        abort.abort();
      }
      const report = await runQualityGateProfile(
        { consumerRoot: "/fixture", profile, signal: abort.signal, deadlineMs: 100 },
        {
          run: async () => {
            starts += 1;
            now = 100;
            abort.abort();
            if (mode === "failure") {
              throw new Error("containment failure");
            }
            if (mode === "timeout") {
              throw new PackageScriptTimeoutError(90);
            }
            throw new PackageScriptCancellationError();
          },
        },
        { nowMs: () => now },
      );
      assert.equal(starts, mode === "pre-abort" ? 0 : 1);
      assert.equal(
        report.outcome,
        mode === "failure" || mode === "timeout" ? "failed" : "cancelled",
      );
      assert.deepEqual(
        report.tasks.map(({ outcome }) => outcome),
        [
          mode === "failure" ? "failed" : mode === "timeout" ? "timed-out" : "cancelled",
          "cancelled",
        ],
      );
    }
  });

  void test("gate budget includes policy and catalog reads, keeps cancellation and nested-runner refusal", async () => {
    let now = 0;
    let starts = 0;
    const deps = {
      clock: { nowMs: () => now },
      policyLoader: async () => {
        now += 40;
        return { profiles: [profile] };
      },
      catalogReader: {
        read: async () => {
          now += 40;
          return { scripts: { first: "node first.js", second: "node second.js" } };
        },
      },
      executor: {
        run: async () => {
          starts += 1;
          return passed;
        },
      },
    };
    const input = {
      consumerRoot: "/fixture",
      configPath: "gates.yaml",
      profileId: "authorities",
      budgetMs: 70,
    };
    await assert.rejects(createQualityGateCommand(deps)(input), /budget was exhausted/u);
    assert.equal(starts, 0);
    await assert.rejects(
      createQualityGateCommand({ ...deps, qualityGateActive: true })(input),
      /cannot start another/u,
    );
    for (const budgetMs of [0, -1, NaN, Infinity, 1.5, 2_147_483_648]) {
      await assert.rejects(
        createQualityGateCommand(deps)({ ...input, budgetMs }),
        /positive bounded integer/u,
      );
    }
    const abort = new AbortController();
    abort.abort();
    const report = await runQualityGateProfile(
      { consumerRoot: "/fixture", profile, signal: abort.signal, deadlineMs: 1000 },
      deps.executor,
      deps.clock,
    );
    assert.equal(report.outcome, "cancelled");
    assert.equal(starts, 0);
  });
}
