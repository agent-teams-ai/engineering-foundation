import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runRepositoryOxlint } from "../tools/repository-oxlint.ts";
import { copyPinnedToolchain } from "./features/quality-coverage/copied-toolchain.mjs";

import { resolvePnpmInvocation } from "../tools/pnpm-command.mts";
import { TOOL_COMMANDS } from "../tools/repository-tool-catalog.ts";
import { validateInstalledDoctorReport } from "../scripts/packed-stack-toolchain-qualification.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const entry = resolve(repositoryRoot, "node_modules/oxlint/bin/oxlint");

test("pinned Oxlint retains source selection and real lint failures below an ignored projection parent", async (t) => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "foundation-profile-lint-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  assert.equal(spawnSync("git", ["init", "--quiet", sourceRoot]).status, 0);
  await writeFile(join(sourceRoot, ".gitignore"), ".worker-tmp/\ngit-ignored.ts\n");
  await writeFile(join(sourceRoot, ".eslintignore"), "eslint-ignored.ts\n");
  await writeFile(
    join(sourceRoot, ".oxlintrc.json"),
    JSON.stringify({
      rules: { "no-debugger": "error", "no-console": "warn" },
      ignorePatterns: ["config-ignored.ts", "**/dist/**", "**/node_modules/**"],
    }),
  );
  await writeFile(
    join(sourceRoot, ".oxlintrc.type-aware.json"),
    JSON.stringify({
      options: { typeAware: true },
      plugins: ["typescript"],
      rules: { "typescript/no-floating-promises": "error" },
      ignorePatterns: ["config-ignored.ts", "**/dist/**", "**/node_modules/**"],
    }),
  );
  await writeFile(
    join(sourceRoot, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", types: [] },
      include: ["*.ts"],
    }),
  );
  await writeFile(join(sourceRoot, "actual file.ts"), "export const value = 1;\n");
  await writeFile(join(sourceRoot, "-leading.ts"), "export const value = 2;\n");
  for (const name of ["git-ignored.ts", "eslint-ignored.ts", "config-ignored.ts"]) {
    await writeFile(join(sourceRoot, name), "debugger;\n");
  }
  for (const name of ["dist", "node_modules"]) {
    await mkdir(join(sourceRoot, name));
    await writeFile(join(sourceRoot, name, "ignored.ts"), "debugger;\n");
  }
  await copyPinnedToolchain(sourceRoot);
  const consumerRoot = join(sourceRoot, ".worker-tmp/projection");
  await mkdir(consumerRoot, { recursive: true });
  for (const name of [
    ".gitignore",
    ".eslintignore",
    ".oxlintrc.json",
    ".oxlintrc.type-aware.json",
    "tsconfig.json",
    "actual file.ts",
    "-leading.ts",
    "git-ignored.ts",
    "eslint-ignored.ts",
    "config-ignored.ts",
    "dist",
    "node_modules",
  ]) {
    await cp(join(sourceRoot, name), join(consumerRoot, name), { recursive: true });
  }
  const environment = {
    ...process.env,
    OXLINT_TSGOLINT_PATH: join(
      consumerRoot,
      "node_modules",
      "@oxlint-tsgolint",
      `${process.platform}-${process.arch}`,
      process.platform === "win32" ? "tsgolint.exe" : "tsgolint",
    ),
  };
  const input = {
    node: process.execPath,
    entry,
    sourceRoot,
    consumerRoot,
    environment,
    args: ["--config", ".oxlintrc.json", "--deny-warnings", "--disable-nested-config"],
  };
  const oldTraversal = spawnSync(
    process.execPath,
    [entry, ...input.args, "--debug", "files", "."],
    {
      cwd: consumerRoot,
      encoding: "utf8",
      env: environment,
    },
  );
  assert.equal(oldTraversal.status, 0, oldTraversal.stderr);
  assert.equal(
    oldTraversal.stdout,
    "",
    "the original cwd scan must reproduce the ignored-parent defect",
  );
  assert.equal(await runRepositoryOxlint({ ...input, targets: ["."] }), 0);
  assert.equal(
    await runRepositoryOxlint({ ...input, targets: ["actual file.ts", "-leading.ts"] }),
    0,
  );
  const dispatch = (id: string, files: readonly string[] = []) =>
    spawnSync(
      process.execPath,
      [
        join(repositoryRoot, "tools/repository-command.mts"),
        "tool",
        id,
        ...(files.length === 0 ? [] : ["--paths", ...files]),
      ],
      {
        cwd: sourceRoot,
        encoding: "utf8",
        env: {
          ...environment,
          AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: "bun",
          AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: process.execPath,
        },
      },
    );
  for (const [id, files] of [
    ["lint:fast", []],
    ["lint:fast:files", ["actual file.ts", "-leading.ts"]],
    ["lint:typed:files", ["actual file.ts"]],
  ] as const) {
    const result = dispatch(id, files);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  }
  for (const cwd of [sourceRoot, consumerRoot]) {
    await writeFile(join(cwd, "actual file.ts"), "debugger;\n");
  }
  assert.equal(await runRepositoryOxlint({ ...input, targets: ["."] }), 1);
  assert.equal(await runRepositoryOxlint({ ...input, targets: ["actual file.ts"] }), 1);
  for (const [id, files] of [
    ["lint:fast", []],
    ["lint:fast:files", ["actual file.ts"]],
  ] as const) {
    const result = dispatch(id, files);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /no-debugger/u);
  }
  for (const cwd of [sourceRoot, consumerRoot]) {
    await writeFile(join(cwd, "actual file.ts"), 'export {};\nPromise.resolve("unhandled");\n');
  }
  assert.equal(
    await runRepositoryOxlint({
      ...input,
      args: ["--config", ".oxlintrc.type-aware.json", "--deny-warnings", "--disable-nested-config"],
      targets: ["actual file.ts"],
    }),
    1,
  );
  const typed = spawnSync(
    process.execPath,
    [
      entry,
      "--config",
      ".oxlintrc.type-aware.json",
      "--deny-warnings",
      "--disable-nested-config",
      "--",
      "actual file.ts",
    ],
    {
      cwd: consumerRoot,
      encoding: "utf8",
      env: environment,
    },
  );
  assert.equal(typed.status, 1, `${typed.stdout}${typed.stderr}`);
  assert.match(typed.stdout, /no-floating-promises/u);
  assert.equal(typed.stderr, "");
  const typedDispatch = dispatch("lint:typed:files", ["actual file.ts"]);
  assert.equal(typedDispatch.status, 1, `${typedDispatch.stdout}${typedDispatch.stderr}`);
  assert.match(typedDispatch.stdout, /no-floating-promises/u);
  await assert.rejects(
    runRepositoryOxlint({ ...input, targets: ["config-ignored.ts"] }),
    /zero source files/u,
  );
  await assert.rejects(runRepositoryOxlint({ ...input, targets: [] }), /explicit source targets/u);
});

test("normal lint gate stops on the installed doctor diagnostic before running syntax lint", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "TEST-foundation-doctor-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  assert.deepEqual(TOOL_COMMANDS["toolchain:doctor"], {
    entry: "node_modules/stack-toolchain/dist/cli.js",
    args: ["doctor", "--json"],
    role: "node-tool",
  });
  for (const id of ["check", "check:fast"]) {
    assert.ok(manifest.scripts[id].includes("script lint"));
  }
  assert.equal(manifest.scripts["lint:fast"].split("script toolchain:doctor").length, 2);
  const manager = await resolvePnpmInvocation(process.execPath, "11.20.0");
  const managerEntry = manager.kind === "javascript" ? manager.args[0] : manager.command;
  assert.ok(managerEntry);
  await cp(join(repositoryRoot, "tools"), join(root, "tools"), { recursive: true });
  await mkdir(join(root, "packages/engineering-foundation/src/process-execution"), {
    recursive: true,
  });
  await copyFile(
    join(
      repositoryRoot,
      "packages/engineering-foundation/src/process-execution/node-runtime-verifier.ts",
    ),
    join(root, "packages/engineering-foundation/src/process-execution/node-runtime-verifier.ts"),
  );
  await mkdir(join(root, "architecture/foundation"), { recursive: true });
  await copyFile(
    join(repositoryRoot, "architecture/foundation/repository-runtime.json"),
    join(root, "architecture/foundation/repository-runtime.json"),
  );
  await mkdir(join(root, "node_modules/stack-toolchain/dist"), { recursive: true });
  await mkdir(join(root, "node_modules/oxlint/bin"), { recursive: true });
  await writeFile(
    join(root, "node_modules/oxlint/bin/oxlint"),
    'require("node:fs").writeFileSync("syntax-ran", "unexpected");process.exit(99);',
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ private: true, packageManager: "pnpm@11.20.0", scripts: manifest.scripts }),
  );
  await writeFile(
    join(root, ".npmrc"),
    "ignore-workspace=true\nverify-deps-before-run=false\npm-on-fail=ignore\n",
  );
  await writeFile(
    join(root, "node_modules/stack-toolchain/dist/cli.js"),
    'if(process.argv[2]!=="doctor"||process.argv[3]!=="--json")process.exit(99);console.log("TOOLCHAIN_TOOL_PIN_MISMATCH");process.exit(2);',
  );
  const rejected = spawnSync(process.execPath, ["--run", "lint:fast"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: "node",
      AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: process.execPath,
      AGENT_TEAMS_FOUNDATION_PNPM_ENTRYPOINT: managerEntry,
      AGENT_TEAMS_FOUNDATION_SOURCE_ROOT: root,
      PATH: `${dirname(process.execPath)}${delimiter}${process.env["PATH"] ?? ""}`,
    },
  });
  assert.ifError(rejected.error);
  assert.equal(rejected.signal, null);
  assert.notEqual(rejected.status, 0, rejected.stderr);
  assert.match(rejected.stdout, /TOOLCHAIN_TOOL_PIN_MISMATCH/u);
  await assert.rejects(readFile(join(root, "syntax-ran")), /ENOENT/u);
});

test("required format gate uses the installed Node tool, preserves files and propagates failure", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "TEST-foundation-format-gate-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest: unknown = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  assert.ok(manifest !== null && typeof manifest === "object" && "scripts" in manifest);
  const rawScripts = manifest.scripts;
  assert.ok(rawScripts !== null && typeof rawScripts === "object");
  const scripts: Partial<Record<string, string>> = {};
  for (const [id, value] of Object.entries(rawScripts)) {
    assert.equal(typeof value, "string");
    assert.ok(typeof value === "string");
    scripts[id] = value;
  }
  assert.deepEqual(TOOL_COMMANDS["format:check"], {
    entry: "node_modules/stack-toolchain/dist/cli.js",
    args: ["format:check"],
    role: "node-tool",
  });
  assert.equal(scripts["format:check"], "node tools/repository-command.mts tool format:check");
  for (const id of ["check", "check:fast"]) {
    const pipeline = scripts[id];
    assert.ok(pipeline !== undefined);
    const commands = pipeline.split(" && ");
    const gate = "node tools/repository-command.mts script format:check";
    assert.equal(commands.filter((command) => command === gate).length, 1);
    assert.ok(
      commands.indexOf(gate) < commands.findIndex((command) => /script lint/u.test(command)),
    );
  }
  await cp(join(repositoryRoot, "tools"), join(root, "tools"), { recursive: true });
  const verifier = "packages/engineering-foundation/src/process-execution/node-runtime-verifier.ts";
  await mkdir(dirname(join(root, verifier)), { recursive: true });
  await copyFile(join(repositoryRoot, verifier), join(root, verifier));
  const runtime = "architecture/foundation/repository-runtime.json";
  await mkdir(dirname(join(root, runtime)), { recursive: true });
  await copyFile(join(repositoryRoot, runtime), join(root, runtime));
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", scripts }));
  const source = "export const unformatted={value:1};\n";
  const config = '{"format":{"paths":["source.ts","!frozen.json"]}}\n';
  await writeFile(join(root, "source.ts"), source);
  await writeFile(join(root, "toolchain.config.json"), config);
  const installed = join(root, "node_modules/stack-toolchain/dist/cli.js");
  await mkdir(dirname(installed), { recursive: true });
  await writeFile(
    installed,
    [
      'if(process.argv.length!==3||process.argv[2]!=="format:check")process.exit(99);',
      "console.log(JSON.stringify({node:process.execPath,args:process.argv.slice(2)}));",
      'process.exitCode=Number(process.env["FORMAT_FIXTURE_EXIT"]??0);',
    ].join("\n"),
  );
  const fallback = join(root, "packages/stack-toolchain/dist/cli.js");
  await mkdir(dirname(fallback), { recursive: true });
  await writeFile(
    fallback,
    'require("node:fs").writeFileSync("fallback-ran","wrong");process.exit(0);',
  );
  const invoke = (profile: string, exitCode: number) =>
    spawnSync(
      process.execPath,
      [join(root, "tools/repository-command.mts"), "tool", "format:check"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: profile,
          AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: process.execPath,
          FORMAT_FIXTURE_EXIT: String(exitCode),
          PATH: `${dirname(process.execPath)}${delimiter}${process.env["PATH"] ?? ""}`,
        },
      },
    );
  for (const profile of ["node", "bun"]) {
    for (const exitCode of [0, 23]) {
      const result = invoke(profile, exitCode);
      assert.ifError(result.error);
      assert.equal(result.status, exitCode, result.stderr);
      assert.equal(
        result.stdout.trim(),
        JSON.stringify({ node: process.execPath, args: ["format:check"] }),
      );
      assert.equal(await readFile(join(root, "source.ts"), "utf8"), source);
      assert.equal(await readFile(join(root, "toolchain.config.json"), "utf8"), config);
    }
  }
  const scriptFailure = spawnSync(process.execPath, ["--run", "format:check"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: "node",
      AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: process.execPath,
      FORMAT_FIXTURE_EXIT: "23",
      PATH: `${dirname(process.execPath)}${delimiter}${process.env["PATH"] ?? ""}`,
    },
  });
  assert.ifError(scriptFailure.error);
  assert.notEqual(scriptFailure.status, 0, scriptFailure.stderr);
  assert.equal(
    scriptFailure.stdout.trim(),
    JSON.stringify({ node: process.execPath, args: ["format:check"] }),
  );
  await rm(installed);
  const absent = invoke("node", 0);
  assert.notEqual(absent.status, 0);
  assert.match(
    absent.stderr,
    /Tool entrypoint is unavailable: node_modules\/stack-toolchain\/dist\/cli.js/u,
  );
  await assert.rejects(readFile(join(root, "fallback-ran")), /ENOENT/u);
});

test("packed doctor report binds the installed version, exported pins and stable findings", async () => {
  const manifest: Record<string, unknown> = JSON.parse(
    await readFile(
      join(repositoryRoot, "packages/stack-toolchain/toolchain-manifest.json"),
      "utf8",
    ),
  );
  const sourcePackage = JSON.parse(
    await readFile(join(repositoryRoot, "packages/stack-toolchain/package.json"), "utf8"),
  );
  const resolvePins = (entries: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(entries).map(([tool, version]) => [tool, manifest[tool] ?? version]),
    );
  const packageJson = {
    ...sourcePackage,
    dependencies: resolvePins(sourcePackage.dependencies),
    optionalDependencies: resolvePins(sourcePackage.optionalDependencies),
  };
  const observations = Object.fromEntries(
    Object.entries(manifest)
      .filter(([tool]) => tool !== "schemaVersion")
      .map(([tool, pin]) => [
        tool,
        {
          required: Object.hasOwn(packageJson.dependencies, tool),
          expectedVersion: pin,
          installedVersion: pin,
          resolvedVersion: pin,
          available: true,
          versionSource: "binary-output",
        },
      ]),
  );
  const report = {
    schemaVersion: 1,
    command: "doctor",
    status: "passed",
    exitCode: 0,
    durationMs: 1,
    versions: manifest,
    details: {
      schemaVersion: 1,
      packageVersion: packageJson.version,
      findings: [],
      ...observations,
    },
  };
  validateInstalledDoctorReport(report, packageJson, manifest);
  assert.throws(() =>
    validateInstalledDoctorReport(
      report,
      { ...packageJson, version: `${packageJson.version}-foreign` },
      manifest,
    ),
  );
  assert.throws(() =>
    validateInstalledDoctorReport({ ...report, schemaVersion: 2 }, packageJson, manifest),
  );
  assert.throws(() =>
    validateInstalledDoctorReport({ ...report, versions: {} }, packageJson, manifest),
  );
  assert.throws(() =>
    validateInstalledDoctorReport(
      {
        ...report,
        details: {
          ...report.details,
          typescript: { ...observations["typescript"], resolvedVersion: "foreign" },
        },
      },
      packageJson,
      manifest,
    ),
  );
  const optional = {
    ...report,
    details: {
      ...report.details,
      findings: [{ tool: "tsrs", code: "TOOLCHAIN_OPTIONAL_TOOL_UNAVAILABLE", severity: "info" }],
      tsrs: {
        required: false,
        expectedVersion: manifest["tsrs"],
        installedVersion: null,
        resolvedVersion: null,
        available: false,
        versionSource: null,
      },
    },
  };
  validateInstalledDoctorReport(optional, packageJson, manifest);
  const falselyOptional = {
    ...optional,
    details: {
      ...optional.details,
      findings: [
        { tool: "typescript", code: "TOOLCHAIN_OPTIONAL_TOOL_UNAVAILABLE", severity: "info" },
      ],
      tsrs: observations["tsrs"],
      typescript: {
        required: false,
        expectedVersion: manifest["typescript"],
        installedVersion: null,
        resolvedVersion: null,
        available: false,
        versionSource: null,
      },
    },
  };
  assert.throws(() => validateInstalledDoctorReport(falselyOptional, packageJson, manifest));

  for (const code of [
    "TOOLCHAIN_TOOL_PIN_MISMATCH",
    "TOOLCHAIN_TOOL_UNAVAILABLE",
    "TOOLCHAIN_TOOL_PROBE_FAILED",
    "invented",
  ]) {
    const invalid = {
      ...optional,
      details: { ...optional.details, findings: [{ tool: "tsrs", code, severity: "error" }] },
    };
    assert.throws(() => validateInstalledDoctorReport(invalid, packageJson, manifest));
  }
});
