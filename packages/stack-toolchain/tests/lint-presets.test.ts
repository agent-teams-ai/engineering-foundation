import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

interface RuleMetadata {
  readonly scope: string;
  readonly value: string;
  readonly type_aware: boolean;
}
interface Preset {
  readonly extends: readonly string[];
  readonly options: Readonly<Record<string, boolean>>;
  readonly rules: Readonly<Record<string, string>>;
  readonly overrides: readonly {
    readonly files: readonly string[];
    readonly rules: Readonly<Record<string, string>>;
  }[];
}
interface Diagnostic {
  readonly filename: string;
  readonly code: string;
}

const require = createRequire(import.meta.url);
const cli = join(require.resolve("oxlint/package.json"), "..", "bin", "oxlint");
const presetPath = fileURLToPath(new URL("../presets/oxlint/type-aware.json", import.meta.url));
const preset = JSON.parse(readFileSync(presetPath, "utf8")) as Preset;

function oxlint(args: readonly string[]): ReturnType<typeof spawnSync> {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

void test("JS exception covers exactly the pinned typed rule universe", () => {
  const result = oxlint(["--rules", "--format=json"]);
  assert.equal(result.status, 0);
  const rules = JSON.parse(String(result.stdout)) as RuleMetadata[];
  const typed = rules
    .filter((rule) => rule.type_aware)
    .map((rule) => `${rule.scope}/${rule.value}`)
    .toSorted();
  assert.equal(typed.length, 59, "Review the exception when upgrading Oxlint");
  assert.equal(preset.overrides.length, 1);
  const exception = preset.overrides[0];
  assert.ok(exception);
  assert.deepEqual(exception.files, ["**/*.{js,jsx,mjs,cjs}"]);
  assert.deepEqual(Object.keys(exception.rules).toSorted(), typed);
  assert.ok(Object.values(exception.rules).every((level) => level === "off"));
  assert.deepEqual(preset.extends, ["./node.json"]);
  assert.deepEqual(preset.options, { typeAware: true, typeCheck: false });
});

void test("typed preset retains its existing global rule levels", () => {
  const errors = [
    "await-thenable",
    "no-array-delete",
    "no-base-to-string",
    "no-confusing-void-expression",
    "no-deprecated",
    "no-floating-promises",
    "no-for-in-array",
    "no-misused-promises",
    "no-misused-spread",
    "no-unnecessary-condition",
    "no-unnecessary-type-assertion",
    "no-unsafe-argument",
    "no-unsafe-assignment",
    "no-unsafe-call",
    "no-unsafe-declaration-merging",
    "no-unsafe-enum-comparison",
    "no-unsafe-function-type",
    "no-unsafe-member-access",
    "no-unsafe-return",
    "no-unsafe-unary-minus",
    "only-throw-error",
    "prefer-readonly",
    "require-array-sort-compare",
    "restrict-template-expressions",
    "strict-boolean-expressions",
    "switch-exhaustiveness-check",
    "unbound-method",
    "use-unknown-in-catch-callback-variable",
  ];
  const expected = Object.fromEntries(errors.map((rule) => [`typescript/${rule}`, "error"]));
  assert.deepEqual(preset.rules, {
    ...expected,
    "typescript/consistent-return": "off",
    "typescript/no-unsafe-type-assertion": "off",
  });
});

void test("all eight extensions retain syntax checks and only TS enables typed checks", () => {
  const directory = mkdtempSync(join(tmpdir(), "TEST-toolchain-lint-presets-"));
  try {
    const config = join(directory, "lint.json");
    writeFileSync(config, JSON.stringify({ extends: [presetPath] }));
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          allowJs: true,
          checkJs: true,
          noEmit: true,
          target: "ES2024",
        },
        include: ["*"],
      }),
    );
    const extensions = ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"];
    for (const extension of extensions) {
      writeFileSync(
        join(directory, `probe-${extension}.${extension}`),
        'Promise.resolve(1);\nif (Number.NaN === 1) { throw new Error("bad"); }\n',
      );
    }
    const result = oxlint(["-c", config, "--type-aware", "--format=json", directory]);
    assert.equal(result.status, 1, String(result.stderr));
    const { diagnostics } = JSON.parse(String(result.stdout)) as { diagnostics: Diagnostic[] };
    assert.ok(diagnostics.every((diagnostic) => typeof diagnostic.code === "string"));
    for (const extension of extensions) {
      const messages = diagnostics.filter((diagnostic) =>
        diagnostic.filename.endsWith(`probe-${extension}.${extension}`),
      );
      assert.ok(
        messages.some((diagnostic) => diagnostic.code.includes("use-isnan")),
        extension,
      );
      assert.equal(
        messages.some((diagnostic) => diagnostic.code.includes("no-floating-promises")),
        ["ts", "tsx", "mts", "cts"].includes(extension),
        extension,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
