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
