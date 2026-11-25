import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { runCommand } from "./pack-test-support.mjs";
import {
  assertInstalledEffectFixtureDependencies,
  type EffectFixtureDependencies,
} from "./effect-fixture-dependencies.ts";
import { measureInstalledEffectGrowth } from "./packed-effect-diagnostics-growth.ts";
import {
  qualifyEffectFixturePolicies,
  record,
  rows,
  writeEffectBoundaryProjects,
  writeEffectProject,
} from "./packed-effect-diagnostics-fixtures.ts";

export interface InstalledEffectQualificationOptions {
  readonly effectDependencies?: EffectFixtureDependencies;
  readonly measureGrowth?: boolean;
}

interface ExpectedDiagnostic {
  readonly line: number;
  readonly code: number;
}

interface CorpusCase {
  readonly id: string;
  readonly source: string;
  readonly sourceGitBlob: string;
  readonly expected: readonly ExpectedDiagnostic[];
  readonly allowedUnstableApis: readonly string[];
}

function assertReport(value: unknown, outcome: string, exitCode: number) {
  const report = record(value);
  assert.equal(report["schemaVersion"], 1);
  assert.equal(report["command"], "effect:check");
  assert.equal(report["status"], exitCode === 0 ? "passed" : "failed");
  assert.equal(report["exitCode"], exitCode);
  const details = record(report["details"]);
  assert.equal(details["outcome"], outcome);
  return details;
}

async function api(root: string, projects: readonly string[], cancelled = false) {
  const script = `const { effectDiagnosticsContractVersion, checkEffectProjects } = await import("stack-toolchain/effect");
    if (effectDiagnosticsContractVersion !== 1) throw new Error("Missing Effect capability marker");
    const input = JSON.parse(process.argv[1]);
    const report = await checkEffectProjects({ cwd: process.cwd(), projects: input.projects,
      signal: input.cancelled ? AbortSignal.abort() : new AbortController().signal, budgetMs: 60000 });
    process.stdout.write(JSON.stringify(report));`;
  const result = await runCommand(
    process.execPath,
    ["--input-type=module", "--eval", script, JSON.stringify({ projects, cancelled })],
    root,
  );
  assert.equal(result.stderr, "");
  return record(JSON.parse(result.stdout));
}

async function cli(root: string, entry: string, projects: readonly string[], exitCode: number) {
  const args = [
    entry,
    "effect:check",
    "--json",
    ...projects.flatMap((path) => ["--project", path]),
  ];
  let result: { stdout: string; stderr: string };
  if (exitCode === 0) {
    result = await runCommand(process.execPath, args, root);
  } else {
    let error: unknown;
    try {
      await runCommand(process.execPath, args, root);
    } catch (caught) {
      error = caught;
    }
    const rejected = record(error);
    assert.equal(rejected["code"], exitCode);
    assert.equal(rejected["terminationConfirmed"], true);
    assert.equal(rejected["timedOut"], false);
    assert.equal(rejected["signal"], null);
    result = { stdout: String(rejected["stdout"]), stderr: String(rejected["stderr"]) };
  }
  assert.equal(result.stderr, "");
  return record(JSON.parse(result.stdout));
}

async function corpus(): Promise<readonly CorpusCase[]> {
  const value = record(
    JSON.parse(
      await readFile(
        new URL("../tests/fixtures/effect-diagnostics/corpus.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  assert.equal(value["schemaVersion"], 1);
  assert.equal(value["commit"], "c99f19835ca3e80c5a7268f8bf42f089418e1cf0");
  return rows(value["cases"]).map((entry) => {
    assert.equal(typeof entry["id"], "string");
    assert.equal(typeof entry["source"], "string");
    const source = String(entry["source"]);
    assert.equal(
      createHash("sha1")
        .update(`blob ${Buffer.byteLength(source)}\0`)
        .update(source)
        .digest("hex"),
      entry["sourceGitBlob"],
    );
    const expected = rows(entry["expected"]).map((diagnostic) => {
      assert.equal(typeof diagnostic["line"], "number");
      assert.equal(typeof diagnostic["code"], "number");
      assert.equal(diagnostic["category"], "error");
      return { line: Number(diagnostic["line"]), code: Number(diagnostic["code"]) };
    });
    assert.ok(Array.isArray(entry["allowedUnstableApis"]));
    const allowedUnstableApis = entry["allowedUnstableApis"].map((item: unknown) => {
      assert.equal(typeof item, "string");
      return String(item);
    });
    return {
      id: String(entry["id"]),
      source,
      sourceGitBlob: String(entry["sourceGitBlob"]),
      expected,
      allowedUnstableApis,
    };
  });
}

function assertDiagnostics(details: Record<string, unknown>, cases: readonly CorpusCase[]) {
  const projects = rows(details["projects"]);
  assert.equal(projects.length, cases.length);
  assert.deepEqual(details["unattempted"], []);
  for (const [index, expected] of cases.entries()) {
    const observed = projects[index];
    assert.ok(observed);
    assert.equal(observed["project"], `corpus/${expected.id}/tsconfig.json`);
    assert.equal(observed["status"], expected.expected.length === 0 ? "passed" : "diagnostics");
    assert.deepEqual(
      observed["diagnosticCodes"],
      [...new Set(expected.expected.map((item) => item.code))].toSorted(),
    );
    assert.deepEqual(observed["sourceFiles"], [`corpus/${expected.id}/index.ts`]);
    assert.equal(observed["stderr"], "");
    const diagnostics = [
      ...String(observed["stdout"]).matchAll(/\((\d+),\d+\): error TS(\d+):/gu),
    ].map((match) => ({ line: Number(match[1]), code: Number(match[2]) }));
    assert.deepEqual(
      diagnostics,
      expected.expected.map(({ line, code }) => ({ line, code })),
    );
  }
}

async function assertSingleDependencyGraph(consumerRoot: string): Promise<void> {
  const installed = createRequire(join(consumerRoot, "package.json"));
  for (const owner of ["@get-modular/assembly", "@get-modular/effect"]) {
    const fromOwner = createRequire(installed.resolve(owner));
    for (const dependency of owner === "@get-modular/assembly"
      ? ["@get-modular/core"]
      : ["@get-modular/core", "@get-modular/assembly", "effect"]) {
      assert.equal(
        await realpath(fromOwner.resolve(dependency)),
        await realpath(installed.resolve(dependency)),
      );
    }
  }
}

async function publicTypes(root: string, cliEntry: string): Promise<void> {
  const positive = `import { checkEffectProjects, effectDiagnosticsContractVersion } from "stack-toolchain/effect";
    const marker: 1 = effectDiagnosticsContractVersion;
    const check = () => checkEffectProjects({ cwd: ".", projects: ["tsconfig.json"], signal: new AbortController().signal });
    void marker; void check;`;
  const project = await writeEffectProject(root, "public-types", positive);
  const compile = () =>
    runCommand(process.execPath, [cliEntry, "compile", "--json", "--project", project], root);
  await compile();
  await writeFile(
    join(root, "public-types/index.ts"),
    `${positive}\nconst wrong: 2 = effectDiagnosticsContractVersion;\n`,
  );
  let rejection: unknown;
  try {
    await compile();
  } catch (error) {
    rejection = error;
  }
  const failure = record(rejection);
  assert.equal(failure["code"], 1);
  assert.equal(failure["terminationConfirmed"], true);
  const report = record(JSON.parse(String(failure["stdout"])));
  assert.equal(report["exitCode"], 1);
  assert.match(String(record(report["details"])["stdout"]), /error TS2322:/u);
  await writeFile(join(root, "public-types/index.ts"), positive);
}

async function qualifyBoundaries(root: string): Promise<void> {
  const projects = await writeEffectBoundaryProjects(root);
  const report = await api(root, projects);
  const details = assertReport(report, "passed", 0);
  assert.deepEqual(details["selected"], projects);
  assert.deepEqual(details["unattempted"], []);
  assert.equal(rows(details["projects"]).length, 3);
  assert.deepEqual(rows(details["projects"])[1]?.["sourceFiles"], [
    "backend/index.ts",
    "sdk/index.ts",
  ]);
  const runtime = await runCommand(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const { adapter } = await import("./backend/index.ts");
     const { renderLabel } = await import("./frontend/index.ts");
     process.stdout.write(JSON.stringify(await renderLabel(adapter)));`,
    ],
    root,
  );
  assert.equal(runtime.stdout, '"Status: foundation-ready"');
  assert.equal(runtime.stderr, "");
  const request =
    'import { get } from "effect/http/HttpClient";\n' +
    'export const ready: boolean = Boolean(get("https://example.invalid"));\n';
  const adapter = await writeEffectProject(root, "backend-allowed", request, [
    "effect/http/HttpClient#get",
  ]);
  const sdk = await writeEffectProject(root, "sdk-denied", request);
  const frontend = await writeEffectProject(root, "frontend-denied", request, [], {
    compilerOptions: { module: "ESNext", moduleResolution: "Bundler" },
  });
  const boundaries = assertReport(await api(root, [adapter, sdk, frontend]), "diagnostics", 1);
  assert.deepEqual(
    rows(boundaries["projects"]).map((item) => [item["status"], item["diagnosticCodes"]]),
    [
      ["passed", []],
      ["diagnostics", [377136]],
      ["diagnostics", [377136]],
    ],
  );
  assert.deepEqual(boundaries["unattempted"], []);
}

/** Reuse an independent ordinary Stack installation; no fixture installer here. */
export async function qualifyInstalledEffectOptionality(consumerRoot: string): Promise<void> {
  const installed = createRequire(join(consumerRoot, "package.json"));
  for (const name of ["effect", "@effect/tsgo-linux-x64/package.json"]) {
    assert.throws(() => installed.resolve(name), { code: "MODULE_NOT_FOUND" });
  }
  await writeFile(join(consumerRoot, "ordinary.ts"), 'export const ready: string = "ready";\n');
  await writeFile(
    join(consumerRoot, "tsconfig.json"),
    JSON.stringify({
      files: ["ordinary.ts"],
      compilerOptions: {
        strict: true,
        skipLibCheck: false,
        noEmit: true,
        target: "ES2024",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        types: [],
      },
    }),
  );
  await writeFile(join(consumerRoot, ".oxlintrc.json"), "{}");
  await writeFile(
    join(consumerRoot, "toolchain.config.json"),
    JSON.stringify({
      schemaVersion: 1,
      profile: "typescript-node",
      typecheck: { projects: ["tsconfig.json"] },
      lint: { config: ".oxlintrc.json", paths: ["ordinary.ts"] },
      format: { paths: ["ordinary.ts"] },
    }),
  );
  const ordinary = await runCommand(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import { registerHooks } from "node:module";
    const forbidden = (name) => name === "effect" || name.startsWith("effect/") || name.startsWith("@effect/")
      || name.includes("/node_modules/effect/") || name.includes("/node_modules/@effect/");
    registerHooks({ resolve(name, context, next) {
      if (forbidden(name)) throw new Error("Ordinary Stack resolved Effect");
      const resolved = next(name, context);
      if (forbidden(resolved.url)) throw new Error("Ordinary Stack resolved Effect");
      return resolved;
    } });
    const { runCommand } = await import("stack-toolchain");
    const reports = [];
    for (const command of ["doctor", "typecheck", "lint", "format:check"]) {
      const report = await runCommand({ command, cwd: process.cwd(), signal: new AbortController().signal });
      reports.push(report);
    }
    process.stdout.write(JSON.stringify(reports));`,
    ],
    consumerRoot,
  );
  assert.equal(ordinary.stderr, "");
  const reports = rows(JSON.parse(ordinary.stdout));
  assert.deepEqual(
    reports.map((report) => [report["command"], report["exitCode"]]),
    [
      ["doctor", 0],
      ["typecheck", 0],
      ["lint", 0],
      ["format:check", 0],
    ],
  );
  for (const report of reports) {
    // Ordinary typecheck retains its existing, separately qualified fallback.
    // The optional Effect route must never substitute a stock compiler.
    assert.ok(
      report["status"] === "passed" ||
        (report["command"] === "typecheck" && report["status"] === "passed-with-fallback"),
      JSON.stringify(report),
    );
  }
  const project = await writeEffectProject(
    consumerRoot,
    "effect-absent",
    'export const ready = "ready";\n',
  );
  assertReport(await api(consumerRoot, [project]), "tool-unavailable", 2);
}

/** Called by existing pack/registry owners after installation and before cleanup. */
export async function qualifyInstalledEffectDiagnostics(
  consumerRoot: string,
  root: string,
  options: InstalledEffectQualificationOptions = {},
): Promise<void> {
  const installed = createRequire(join(consumerRoot, "package.json"));
  const cliEntry = join(consumerRoot, "node_modules/stack-toolchain/dist/cli.js");
  await publicTypes(root, cliEntry);
  const control = await writeEffectProject(root, "control", 'export const ready = "ready";\n');
  if (process.platform !== "linux" || process.arch !== "x64") {
    assert.equal(options.effectDependencies, undefined);
    assert.notEqual(options.measureGrowth, true);
    assertReport(await api(root, [control]), "tool-unavailable", 2);
    assertReport(await cli(root, cliEntry, [control], 2), "tool-unavailable", 2);
    return;
  }
  assert.ok(
    options.effectDependencies,
    "Linux installed Effect qualification needs prepared public evidence",
  );
  await assertInstalledEffectFixtureDependencies(consumerRoot, options.effectDependencies);
  await assertSingleDependencyGraph(consumerRoot);
  assert.ok(installed.resolve("stack-toolchain/effect").includes("node_modules"));
  const cases = await corpus();
  const projects: string[] = [];
  for (const entry of cases) {
    projects.push(
      await writeEffectProject(root, `corpus/${entry.id}`, entry.source, entry.allowedUnstableApis),
    );
  }
  const report = await api(root, projects);
  // Retain all eight observations before strict comparison: the retained pilot
  // used separate rule profiles, while this installed profile enforces both.
  process.stdout.write(`Installed Effect corpus observation: ${JSON.stringify(report)}\n`);
  const details = assertReport(report, "diagnostics", 1);
  assert.deepEqual(details["selected"], projects);
  assertDiagnostics(details, cases);
  assert.partialDeepStrictEqual(report["versions"], {
    package: "@effect/tsgo-linux-x64",
    version: "0.73.4",
    typescript: "7.0.2",
    binarySha256: "18b0b3fdac7d76b8c9b97e64c185ce8d92f2e13ab2307ae18a27fb11a62c045c",
    libraryCount: 108,
  });
  assertReport(await cli(root, cliEntry, [control], 0), "passed", 0);
  const usage = await writeEffectProject(
    root,
    "cli-unstable-usage",
    'import { get } from "effect/http/HttpClient";\n' +
      'export const ready: boolean = Boolean(get("https://example.invalid"));\n',
  );
  const cliNegative = assertReport(await cli(root, cliEntry, [usage], 1), "diagnostics", 1);
  assert.deepEqual(rows(cliNegative["projects"])[0]?.["diagnosticCodes"], [377136]);
  await qualifyBoundaries(root);
  await qualifyEffectFixturePolicies(
    root,
    consumerRoot,
    async (selectedProjects, outcome, exitCode, cancelled) =>
      assertReport(await api(root, selectedProjects, cancelled), outcome, exitCode),
  );
  const growth =
    options.measureGrowth === true ? await measureInstalledEffectGrowth(consumerRoot, root) : null;
  const receipt = {
    schemaVersion: 1,
    cohort: options.effectDependencies.pins,
    native: report["versions"],
    corpus: cases.map(({ id, expected }) => ({ id, expected })),
    runtime: "Node in-memory GM+Effect composition returned Status: foundation-ready",
    frontend: "portable type contracts; no browser execution",
    growth,
  };
  await writeFile(join(root, "effect-qualification.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`Installed Effect qualification: ${JSON.stringify(receipt)}\n`);
}
