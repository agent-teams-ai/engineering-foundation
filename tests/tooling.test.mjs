import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const requireFromRepository = createRequire(import.meta.url);
const oxlintEntrypoint = join(
  dirname(requireFromRepository.resolve("oxlint/package.json")),
  "bin",
  "oxlint",
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
