import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyEffectOutput,
  effectInputs,
  validateEffectConfiguration,
  validateEffectPolicy,
  type EffectCheckInput,
} from "../dist/features/toolchain-execution/application/effect-policy.js";

const plugin = () => ({
  name: "@effect/language-service",
  diagnostics: true,
  diagnosticSeverity: { unstableApiUsage: "error", apiStabilityLeak: "error" },
  allowedUnstableApis: ["effect/http/HttpClient#get"],
  ignoreEffectWarningsInTscExitCode: false,
  ignoreEffectErrorsInTscExitCode: false,
  includeSuggestionsInTsc: false,
});
const policy = (value: unknown) => ({ compilerOptions: { plugins: [value] } });

test("Effect policy admits only explicitly enabled exact-export exceptions", () => {
  validateEffectPolicy(policy(plugin()));
  validateEffectPolicy(policy({ ...plugin(), allowedUnstableApis: [] }));
  for (const change of [
    { diagnostics: false },
    { diagnostics: "true" },
    { name: "another-plugin" },
    { ignoreEffectErrorsInTscExitCode: true },
    { ignoreEffectWarningsInTscExitCode: true },
    { includeSuggestionsInTsc: true },
    { diagnosticSeverity: { unstableApiUsage: "warning", apiStabilityLeak: "error" } },
    { diagnosticSeverity: { unstableApiUsage: "error", apiStabilityLeak: "off" } },
    { diagnosticSeverity: { unstableApiUsage: "error", apiStabilityLeak: "error", extra: "off" } },
    { overrides: [] },
    { disableDiagnostics: true },
    { allowedUnstableApis: ["effect/http/HttpClient#*"] },
    { allowedUnstableApis: ["effect/http/HttpClient"] },
    { allowedUnstableApis: ["effect/http/HttpClient#get", "effect/http/HttpClient#get"] },
    { allowedUnstableApis: ["effect/../HttpClient#get"] },
    { allowedUnstableApis: Array.from({ length: 257 }, (_, index) => `effect/Foo#member${index}`) },
  ]) {
    assert.throws(() => validateEffectPolicy(policy({ ...plugin(), ...change })), /EFFECT_POLICY/u);
  }
  for (const value of [
    null,
    {},
    { compilerOptions: {} },
    { compilerOptions: { plugins: [] } },
    { compilerOptions: { plugins: [plugin(), plugin()] } },
    { ...policy(plugin()), references: [] },
  ]) {
    assert.throws(() => validateEffectPolicy(value), /EFFECT_/u);
  }
  const { includeSuggestionsInTsc: _omitted, ...incomplete } = plugin();
  assert.throws(() => validateEffectPolicy(policy(incomplete)), /EFFECT_POLICY_FIELDS/u);
});

test("effective strict options and complete roots are independent of leaf plugin admission", () => {
  const config = { compilerOptions: { strict: true, noEmit: true }, files: ["./main.ts"] };
  assert.deepEqual(validateEffectConfiguration(config), ["./main.ts"]);
  for (const option of [
    "strict",
    "noEmit",
    "alwaysStrict",
    "noImplicitAny",
    "noImplicitThis",
    "strictBindCallApply",
    "strictBuiltinIteratorReturn",
    "strictFunctionTypes",
    "strictNullChecks",
    "strictPropertyInitialization",
    "useUnknownInCatchVariables",
  ]) {
    assert.throws(
      () =>
        validateEffectConfiguration({
          ...config,
          compilerOptions: { ...config.compilerOptions, [option]: false },
        }),
      /EFFECT_TYPESCRIPT_STRICT/u,
    );
  }
  for (const option of ["noCheck", "skipLibCheck", "skipDefaultLibCheck", "allowJs"]) {
    assert.throws(
      () =>
        validateEffectConfiguration({
          ...config,
          compilerOptions: { ...config.compilerOptions, [option]: true },
        }),
      /EFFECT_TYPESCRIPT_SCOPE/u,
    );
  }
  for (const files of [[], [1], [""], ["bad\nfile.ts"], "main.ts"]) {
    assert.throws(
      () => validateEffectConfiguration({ ...config, files }),
      /EFFECT_TYPESCRIPT_FILES/u,
    );
  }
  assert.throws(
    () => validateEffectConfiguration({ ...config, references: [] }),
    /EFFECT_TYPESCRIPT_SCOPE/u,
  );
});

test("runtime input limits reject ambiguous paths, unbounded work and unknown controls", () => {
  const input = {
    cwd: "/consumer",
    projects: ["./tsconfig.json", "sdk/tsconfig.jsonc"],
    signal: new AbortController().signal,
  };
  assert.deepEqual(effectInputs(input).projects, ["tsconfig.json", "sdk/tsconfig.jsonc"]);
  assert.equal(effectInputs(input).budgetMs, 300_000);
  for (const projects of [
    [],
    ["a.json", "./a.json"],
    ["../a.json"],
    ["/a.json"],
    ["C:\\a.json"],
    ["a//b.json"],
    ["././a.json"],
    ["-a.json"],
    ["node_modules/a.json"],
    ["a.ts"],
    ["a\u0000.json"],
    Array.from({ length: 65 }, (_, index) => `${index}.json`),
  ]) {
    assert.throws(() => effectInputs({ ...input, projects }), /EFFECT_PROJECT/u);
  }
  for (const budgetMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    assert.throws(() => effectInputs({ ...input, budgetMs }), /EFFECT_BUDGET/u);
  }
  for (const change of [
    { cwd: "" },
    { cwd: "bad\nroot" },
    { signal: {} },
    { args: ["--noCheck"] },
    { executable: "tsc" },
  ]) {
    assert.throws(
      () => effectInputs({ ...input, ...change } as unknown as EffectCheckInput),
      /EFFECT_/u,
    );
  }
  assert.throws(() => effectInputs(null as unknown as EffectCheckInput), /EFFECT_CONFIG_OBJECT/u);
});

test("six-digit errors and warnings remain diagnostics only with a qualified exit envelope", () => {
  const valid = {
    exitCode: 1,
    signal: null,
    stderr: "",
    stdout:
      "sdk/main.ts(2,8): error TS377137: stability leak\nadapter.ts(3,1): warning TS377136: unstable use\nadapter.ts(4,1): error TS377136: second use\nerror TS2322: ordinary type mismatch\n",
  };
  assert.deepEqual(classifyEffectOutput(valid), {
    status: "diagnostics",
    diagnosticCodes: [2322, 377136, 377137],
  });
  assert.deepEqual(classifyEffectOutput({ exitCode: 0, signal: null, stderr: "", stdout: "" }), {
    status: "passed",
    diagnosticCodes: [],
  });
  for (const change of [
    { exitCode: 0 },
    { exitCode: 3 },
    { exitCode: null },
    { signal: "SIGSEGV" },
    { stderr: "panic: crash after diagnostics" },
    { stdout: "" },
    ...[
      "panic: crash",
      "  panic: crash",
      "  fatal error: crash",
      "  runtime.gopanic()",
      "  at nativeCheck()",
      "  unqualified continuation",
      "unrecognized banner",
    ].map((line) => ({ stdout: valid.stdout + line + "\n" })),
  ]) {
    assert.throws(() => classifyEffectOutput({ ...valid, ...change }), /EFFECT_EXECUTION_OUTPUT/u);
  }
});

test("ordinary TypeScript message chains preserve primary codes and bounded tree depth", () => {
  const stdout = [
    "nested.ts(2,14): error TS2322: Type '{ response: { count: string; }; }' is not assignable to type '{ response: { count: number; }; }'.",
    "  The types of 'response.count' are incompatible between these types.",
    "    Type 'string' is not assignable to type 'number'.",
    "overload.ts(4,1): error TS2769: No overload matches this call.",
    "  Overload 1 of 2, '(value: number): void', gave the following error.",
    "    Argument of type 'string' is not assignable to parameter of type 'number'.",
    "  Overload 2 of 2, '(value: boolean): void', gave the following error.",
    "    Argument of type 'string' is not assignable to parameter of type 'boolean'.",
    "effect.ts(1,1): error TS377136: unstable export",
    "",
  ].join("\n");
  for (const output of [stdout, stdout.replaceAll("\n", "\r\n")]) {
    assert.deepEqual(
      classifyEffectOutput({ stdout: output, stderr: "", exitCode: 1, signal: null }),
      {
        status: "diagnostics",
        diagnosticCodes: [2322, 2769, 377136],
      },
    );
  }
  for (const message of [
    "The types returned by 'read' are incompatible between these types.",
    "Types of property 'count' are incompatible.",
    "Types of parameters 'left' and 'right' are incompatible.",
    "Property 'read' is missing in type 'Empty'.",
    "Property 'read' is missing in type 'Empty' but required in type 'Port'.",
    "Type 'Source' provides no match for the signature '(value: number): void'.",
    "Index signature for type 'string' is missing in type 'Source'.",
    "'string' and 'number' index signatures are incompatible.",
    "'string' index signatures are incompatible.",
    "Target signature provides too few arguments. Expected 2 or more, but got 1.",
    "Call signature return types 'string' and 'number' are incompatible.",
  ]) {
    assert.equal(
      classifyEffectOutput({
        stdout: `error TS2322: incompatible types\n  ${message}\n`,
        stderr: "",
        exitCode: 2,
        signal: null,
      }).status,
      "diagnostics",
    );
  }
});

test("unframed, malformed, excessive and crash-tailed chains remain execution failures", () => {
  const header = "main.ts(1,1): error TS2322: incompatible types\n";
  const message = "Type 'string' is not assignable to type 'number'.";
  for (const stdout of [
    `  ${message}\n`,
    `${header}\n  ${message}\n`,
    `${header}    ${message}\n`,
    `${header}   ${message}\n`,
    `${header}\t${message}\n`,
    `${header}  ${message}\n      ${message}\n`,
    `${header}${Array.from({ length: 33 }, (_, index) => `${"  ".repeat(index + 1)}${message}\n`).join("")}`,
    `${header}${`  ${message}\n`.repeat(129)}`,
    `${header}  Type '${"x".repeat(8192)}' is not assignable to type 'number'.\n`,
    `${header}  Type 'string' is not assignable to type 'number'. panic: crash\n`,
    `${header}  Type 'foo'bar' is not assignable to type 'number'.\n`,
    `main.ts(1,1): error TS377136: unstable export\n  ${message}\n`,
    ...[
      "panic: failure",
      "fatal error: failure",
      "runtime.gopanic()",
      "at nativeCheck()",
      "unqualified continuation",
    ].map((line) => `${header}  ${message}\n  ${line}\n`),
  ]) {
    assert.throws(
      () => classifyEffectOutput({ stdout, stderr: "", exitCode: 1, signal: null }),
      /EFFECT_EXECUTION_OUTPUT/u,
    );
  }
  const deepest =
    header +
    Array.from({ length: 32 }, (_, index) => `${"  ".repeat(index + 1)}${message}\n`).join("");
  assert.equal(
    classifyEffectOutput({ stdout: deepest, stderr: "", exitCode: 1, signal: null }).status,
    "diagnostics",
  );
  assert.equal(
    classifyEffectOutput({
      stdout: header + `  ${message}\n`.repeat(128),
      stderr: "",
      exitCode: 1,
      signal: null,
    }).status,
    "diagnostics",
  );
});
