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

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function rows(value: unknown): readonly Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map(record);
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
    'import { get } from "effect/http/HttpClient";\nexport const request = get("https://example.invalid");\n';
  const adapter = await writeEffectProject(root, "backend-allowed", request, [
    "effect/http/HttpClient#get",
  ]);
  const sdk = await writeEffectProject(root, "sdk-denied", request);
  const frontend = await writeEffectProject(root, "frontend-denied", request, [], {
    module: "ESNext",
    moduleResolution: "Bundler",
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

async function qualifyMultilineDiagnostics(root: string): Promise<void> {
  const source =
    'const source = { response: { count: "wrong" } };\n' +
    "export const result: { response: { count: number } } = source;\n";
  const rejected = await writeEffectProject(root, "ordinary-chain", source);
  const accepted = await writeEffectProject(
    root,
    "after-chain",
    'export const ready: string = "checked";\n',
  );
  const before = await readFile(join(root, rejected));
  const details = assertReport(await api(root, [rejected, accepted]), "diagnostics", 1);
  assert.deepEqual(details["selected"], [rejected, accepted]);
  assert.deepEqual(details["unattempted"], []);
  const projects = rows(details["projects"]);
  assert.deepEqual(
    projects.map((project) => [project["project"], project["status"], project["diagnosticCodes"]]),
    [
      [rejected, "diagnostics", [2322]],
      [accepted, "passed", []],
    ],
  );
  const diagnostic = String(projects[0]?.["stdout"]);
  assert.match(diagnostic, /index\.ts\(2,14\): error TS2322:/u);
  assert.match(
    diagnostic,
    /\r?\n {2}The types of 'response\.count' are incompatible between these types\.\r?\n {4}Type 'string' is not assignable to type 'number'\./u,
  );
  assert.equal(projects[0]?.["stderr"], "");
  assert.equal(projects[1]?.["stdout"], "");
  assert.equal(projects[1]?.["stderr"], "");
  assert.equal(await readFile(join(root, "ordinary-chain/index.ts"), "utf8"), source);
  assert.deepEqual(await readFile(join(root, rejected)), before);
}

async function qualifyInputPolicy(root: string): Promise<void> {
  const safe = 'export const ready: string = "ready";\n';
  for (const [id, options] of [
    ["missing-policy", { plugins: [] }],
    ["unchecked", { noCheck: true }],
    ["skipped-libraries", { skipLibCheck: true }],
  ] as const) {
    const project = await writeEffectProject(root, id, safe, [], options);
    assertReport(await api(root, [project]), "invalid-input", 2);
  }
  const unstable = 'import { get } from "effect/http/HttpClient";\n';
  const use = 'export const request = get("https://example.invalid");\n';
  const suppressed = await writeEffectProject(
    root,
    "suppressed",
    unstable + "// @effect-diagnostics-next-line unstableApiUsage:off\n" + use,
  );
  assertReport(await api(root, [suppressed]), "invalid-input", 2);
  const imported = await writeEffectProject(
    root,
    "imported-suppression",
    'import "./suppressed.ts";\n' + safe,
  );
  await writeFile(
    join(root, "imported-suppression/suppressed.ts"),
    "// @effect-diagnostics-skip-file *:off\n" + unstable + use,
  );
  assertReport(await api(root, [imported]), "invalid-input", 2);
  const declarationProject = await writeEffectProject(
    root,
    "local-declaration",
    'import type { LocalPort } from "./local.js";\n' +
      'export const port: LocalPort = { value: "ready" };\n',
  );
  const declaration = "export interface LocalPort { readonly value: string; }\n";
  await writeFile(join(root, "local-declaration/local.d.ts"), declaration);
  const declarationFailure = assertReport(
    await api(root, [declarationProject]),
    "invalid-input",
    2,
  );
  assert.equal(declarationFailure["reason"], "EFFECT_DECLARATION_SOURCE_UNSUPPORTED");
  assert.equal(await readFile(join(root, "local-declaration/local.d.ts"), "utf8"), declaration);
  const composite = await writeEffectProject(root, "incremental", safe, [], {
    composite: true,
    incremental: true,
    tsBuildInfoFile: "unexpected.tsbuildinfo",
  });
  const config = await readFile(join(root, composite));
  const source = await readFile(join(root, "incremental/index.ts"));
  assertReport(await api(root, [composite]), "passed", 0);
  assert.deepEqual(await readFile(join(root, composite)), config);
  assert.deepEqual(await readFile(join(root, "incremental/index.ts")), source);
  await assert.rejects(readFile(join(root, "incremental/unexpected.tsbuildinfo")), {
    code: "ENOENT",
  });
  assertReport(await api(root, [composite], true), "cancelled", 130);
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
  assert.deepEqual(
    rows(JSON.parse(ordinary.stdout)).map((report) => [
      report["command"],
      report["status"],
      report["exitCode"],
    ]),
    [
      ["doctor", "passed", 0],
      ["typecheck", "passed", 0],
      ["lint", "passed", 0],
      ["format:check", "passed", 0],
    ],
  );
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
  const cliNegative = assertReport(
    await cli(root, cliEntry, ["corpus/actual-unstable/tsconfig.json"], 1),
    "diagnostics",
    1,
  );
  assert.deepEqual(rows(cliNegative["projects"])[0]?.["diagnosticCodes"], [377136]);
  await qualifyBoundaries(root);
  await qualifyMultilineDiagnostics(root);
  await qualifyInputPolicy(root);
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
