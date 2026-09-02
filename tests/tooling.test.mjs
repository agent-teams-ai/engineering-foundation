import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createPnpmRunner,
  runCommand,
  runNpmCommand,
} from "../scripts/pack-test-support.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const requireFromRepository = createRequire(import.meta.url);
const oxlintEntrypoint = join(
  dirname(requireFromRepository.resolve("oxlint/package.json")),
  "bin",
  "oxlint",
);
const typeScriptEntrypoint = join(
  dirname(requireFromRepository.resolve("typescript/package.json")),
  "lib",
  "tsc.js",
);
const typeAwarePreset = join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "presets",
  "oxlint",
  "type-aware.json",
);
const maintainabilityPreset = join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "presets",
  "oxlint",
  "maintainability.json",
);
const maintainabilityTestsPreset = join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "presets",
  "oxlint",
  "maintainability-tests.json",
);
const processFixtureRoot = join(repositoryRoot, "tests", "fixtures");

function wait(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function readProcessRecord(path) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      await wait(20);
    }
  }
  throw new Error(`Process fixture did not write ${path}.`);
}

async function assertProcessExited(pid) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") {
        return;
      }
      throw error;
    }
    await wait(20);
  }
  throw new Error(`Process ${pid} survived the packaging command.`);
}

function killProcess(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
}

async function withTypeScriptProject(source, callback) {
  const projectRoot = await mkdtemp(join(tmpdir(), "foundation-oxlint-e2e-"));
  try {
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await writeFile(
      join(projectRoot, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
            strict: true,
            target: "ES2024",
          },
          include: ["src/**/*.ts"],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(join(projectRoot, "src", "index.ts"), source, "utf8");
    return callback(projectRoot);
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

function runTypeAwareLint(projectRoot) {
  return spawnSync(
    process.execPath,
    [
      oxlintEntrypoint,
      "--config",
      typeAwarePreset,
      "--deny-warnings",
      "--disable-nested-config",
      join(projectRoot, "src"),
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
}

function runMaintainabilityLint(projectRoot, preset = maintainabilityPreset) {
  return spawnSync(
    process.execPath,
    [
      oxlintEntrypoint,
      "--config",
      preset,
      "--deny-warnings",
      "--disable-nested-config",
      join(projectRoot, "src"),
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
}

test("type-aware Oxlint preset rejects unsafe promise handling", async () => {
  await withTypeScriptProject(
    `async function execute(): Promise<void> {}\nexecute();\n`,
    (projectRoot) => {
      const result = runTypeAwareLint(projectRoot);
      assert.notEqual(result.status, 0);
      assert.match(
        `${result.stdout}${result.stderr}`,
        /typescript\(no-floating-promises\)/u,
      );
    },
  );
});

test("type-aware Oxlint policy cannot be bypassed with ESLint directives", async () => {
  await withTypeScriptProject(
    `async function execute(): Promise<void> {}\n// eslint-disable-next-line typescript/no-floating-promises\nexecute();\n`,
    (projectRoot) => {
      const result = runTypeAwareLint(projectRoot);
      assert.notEqual(result.status, 0);
      assert.match(
        `${result.stdout}${result.stderr}`,
        /typescript\(no-floating-promises\)/u,
      );
    },
  );
});

test("Oxlint leaves compiler diagnostics to the pinned TypeScript gate", async () => {
  await withTypeScriptProject(
    `const value: string = 42;\nvoid value;\n`,
    (projectRoot) => {
      const result = runTypeAwareLint(projectRoot);
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    },
  );
});

test("production maintainability preset enforces all five budgets", async () => {
  const source = `export function overBudget(a, b, c, d, e, f) {
  let result = 0;
  if (a) {
    if (b) {
      if (c) {
        if (d) {
          if (e) {
            result = f;
          }
        }
      }
    }
  }
${Array.from({ length: 145 }, (_, index) => `  if (a === ${index}) result += ${index};`).join("\n")}
  return result;
}
${Array.from({ length: 345 }, (_, index) => `export const line${index} = ${index};`).join("\n")}
`;
  await withTypeScriptProject(source, (projectRoot) => {
    const result = runMaintainabilityLint(projectRoot);
    const output = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0);
    for (const rule of [
      "complexity",
      "max-depth",
      "max-lines",
      "max-lines-per-function",
      "max-params",
    ]) {
      assert.match(output, new RegExp(`eslint\\(${rule}\\)`, "u"));
    }
  });
});

test("test maintainability preset applies the documented relaxed budgets", async () => {
  const source = `export function testHelper(a, b, c, d, e, f) {
  let result = a + b + c + d + e + f;
${Array.from({ length: 180 }, () => "  result += 1;").join("\n")}
  return result;
}
`;
  await withTypeScriptProject(source, (projectRoot) => {
    const production = runMaintainabilityLint(projectRoot);
    assert.notEqual(production.status, 0);
    const tests = runMaintainabilityLint(projectRoot, maintainabilityTestsPreset);
    assert.equal(tests.status, 0, `${tests.stdout}${tests.stderr}`);
  });
});

test("packaging package-manager runners ignore executable environment overrides", async () => {
  const environment = {
    ...process.env,
    ComSpec: join(repositoryRoot, "attacker-cmd.exe"),
    npm_execpath: join(repositoryRoot, "attacker-pnpm.cjs"),
    PATH: join(repositoryRoot, "attacker-bin"),
  };
  const pnpm = await createPnpmRunner()(["--version"], repositoryRoot, { environment });
  const npm = await runNpmCommand(["--version"], repositoryRoot, { environment });
  assert.match(pnpm.stdout, /^11\.20\.0\s*$/u);
  assert.match(npm.stdout, /^11\./u);
});

test("packaging subprocesses have a bounded deadline", async () => {
  await assert.rejects(
    runCommand(
      process.execPath,
      ["--input-type=module", "--eval", "setInterval(() => {}, 1000);"],
      repositoryRoot,
      { timeoutMs: 200 },
    ),
    (error) =>
      error?.timedOut === true &&
      error?.killed === true &&
      error?.terminationConfirmed === true,
  );
});

test("packaging confirms containment after a normal nonzero exit", async () => {
  await assert.rejects(
    runCommand(
      process.execPath,
      ["--input-type=module", "--eval", "process.exit(7);"],
      repositoryRoot,
    ),
    (error) => error?.code === 7 && error?.terminationConfirmed === true,
  );
});

test("packaging rejects unsupported deadlines before process creation", async () => {
  await assert.rejects(
    runCommand(
      process.execPath,
      ["--eval", "throw new Error('must not execute')"],
      repositoryRoot,
      { timeoutMs: Number.MAX_SAFE_INTEGER },
    ),
    /no greater than 2147483647/u,
  );
});

test("packaging subprocess output is bounded by cumulative bytes", async () => {
  const source =
    "const chunk = 'x'.repeat(1024 * 1024); for (let i = 0; i < 17; i += 1) process.stdout.write(chunk);";
  await assert.rejects(
    runCommand(
      process.execPath,
      ["--input-type=module", "--eval", source],
      repositoryRoot,
      { timeoutMs: 5_000 },
    ),
    /stdout exceeded 16777216 bytes/u,
  );
});

test("packaging command timeouts terminate descendants", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "foundation-pack-timeout-"));
  const processRecordPath = join(fixtureRoot, "processes.json");
  let record;
  try {
    const command = runCommand(
      process.execPath,
      [join(processFixtureRoot, "never-exiting-process.mjs"), processRecordPath],
      repositoryRoot,
      { timeoutMs: 750 },
    );
    record = await readProcessRecord(processRecordPath);
    await assert.rejects(command, (error) => error?.timedOut === true);
    await assertProcessExited(record.child);
  } finally {
    if (record !== undefined) {
      killProcess(record.child);
    }
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("packaging command completion terminates a parent-exits-first descendant", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "foundation-pack-parent-exit-"));
  const processRecordPath = join(fixtureRoot, "processes.json");
  let record;
  try {
    await runCommand(
      process.execPath,
      [join(processFixtureRoot, "parent-exits-before-child.mjs"), processRecordPath],
      repositoryRoot,
      { timeoutMs: 2_000 },
    );
    record = await readProcessRecord(processRecordPath);
    await assertProcessExited(record.child);
  } finally {
    if (record !== undefined) {
      killProcess(record.child);
    }
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("clean removes incremental state and permits a full rebuild", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "foundation-clean-"));
  const packageRoot = join(fixtureRoot, "packages", "engineering-foundation");
  const sourceRoot = join(packageRoot, "src");
  const cleanScript = join(fixtureRoot, "scripts", "clean.mjs");
  const publishablePackagesScript = join(
    fixtureRoot,
    "scripts",
    "publishable-packages.mjs",
  );
  const tsconfigPath = join(packageRoot, "tsconfig.json");
  const outputPath = join(packageRoot, "dist", "index.js");
  const buildInfoPath = join(packageRoot, "tsconfig.tsbuildinfo");
  try {
    const packageConfig = JSON.parse(
      await readFile(
        join(repositoryRoot, "packages", "engineering-foundation", "tsconfig.json"),
        "utf8",
      ),
    );
    packageConfig.compilerOptions.types = [];
    packageConfig.references = [];

    const fixturePackages = [
      ["repository-mutation", "@agent-teams/repository-mutation", {}],
      ["engineering-foundation", "@agent-teams/engineering-foundation", {
        "@agent-teams/repository-mutation": "workspace:*",
      }],
      ["docs-protocol", "@agent-teams/docs-protocol", {
        "@agent-teams/engineering-foundation": "workspace:*",
      }],
      ["docs-protocol-mcp", "@agent-teams/docs-protocol-mcp", {
        "@agent-teams/docs-protocol": "workspace:*",
      }],
      ["docs-protocol-agent-teams", "@agent-teams/docs-protocol-agent-teams", {
        "@agent-teams/docs-protocol": "workspace:*",
        "@agent-teams/repository-mutation": "workspace:*",
      }],
    ];
    await Promise.all(fixturePackages.map(([slug]) =>
      mkdir(join(fixtureRoot, "packages", slug), { recursive: true })));
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(dirname(cleanScript), { recursive: true });
    await Promise.all([
      writeFile(join(sourceRoot, "index.ts"), "export const built = true;\n", "utf8"),
      writeFile(join(packageRoot, "LICENSE"), "generated", "utf8"),
      ...fixturePackages.map(([slug, name, dependencies]) => writeFile(
        join(fixtureRoot, "packages", slug, "package.json"),
        `${JSON.stringify({ dependencies, name, type: "module" })}\n`,
        "utf8",
      )),
      writeFile(tsconfigPath, `${JSON.stringify(packageConfig)}\n`, "utf8"),
      writeFile(
        cleanScript,
        await readFile(join(repositoryRoot, "scripts", "clean.mjs"), "utf8"),
        "utf8",
      ),
      writeFile(
        publishablePackagesScript,
        await readFile(
          join(repositoryRoot, "scripts", "publishable-packages.mjs"),
          "utf8",
        ),
        "utf8",
      ),
    ]);

    const build = () =>
      spawnSync(
        process.execPath,
        [typeScriptEntrypoint, "--build", tsconfigPath, "--pretty", "false"],
        {
          cwd: fixtureRoot,
          encoding: "utf8",
        },
      );
    const firstBuild = build();
    assert.equal(firstBuild.status, 0, `${firstBuild.stdout}${firstBuild.stderr}`);
    assert.match(await readFile(outputPath, "utf8"), /built/u);
    await readFile(buildInfoPath, "utf8");

    const clean = spawnSync(process.execPath, [cleanScript], {
      cwd: fixtureRoot,
      encoding: "utf8",
    });
    assert.equal(clean.status, 0, `${clean.stdout}${clean.stderr}`);
    for (const path of [
      outputPath,
      join(packageRoot, "LICENSE"),
      buildInfoPath,
    ]) {
      await assert.rejects(readFile(path), (error) => error?.code === "ENOENT");
    }

    const secondBuild = build();
    assert.equal(secondBuild.status, 0, `${secondBuild.stdout}${secondBuild.stderr}`);
    assert.match(await readFile(outputPath, "utf8"), /built/u);
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
