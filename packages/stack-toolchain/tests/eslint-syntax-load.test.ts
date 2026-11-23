import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const guarded = `
  import { registerHooks, createRequire } from "node:module";
  const blocked = ["typescript", "typescript-eslint", "@typescript-eslint/parser", "@typescript-eslint/typescript-estree", "@typescript-eslint/eslint-plugin", "@typescript-eslint/utils"];
  const forbidden = (specifier) => blocked.some((name) => specifier === name || specifier.startsWith(name + "/") || specifier.includes("/node_modules/" + name + "/"));
  registerHooks({ resolve(specifier, context, next) {
    if (forbidden(specifier)) throw new Error("LEGACY_INITIALIZER_BLOCKED:" + specifier);
    const result = next(specifier, context);
    if (forbidden(result.url)) throw new Error("LEGACY_INITIALIZER_BLOCKED:" + result.url);
    return result;
  } });
`;

function run(source: string): ReturnType<typeof spawnSync> {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

void test("actual syntax entry and its scope graph execute behind an ESM/CJS legacy-load tripwire", () => {
  const entry = new URL("../dist/eslint-syntax.js", import.meta.url).href;
  const host = pathToFileURL(require.resolve("eslint")).href;
  const result = run(guarded + `
    const { configs } = await import(${JSON.stringify(entry)});
    const { Linter } = await import(${JSON.stringify(host)});
    const messages = new Linter().verify("const unused: any = 1;", [...configs.recommended, { files: ["**/*.ts"] }], { filename: "fixture.ts" });
    process.stdout.write(JSON.stringify(messages.map(({ruleId}) => ruleId).sort()));
  `);
  assert.equal(result.status, 0, String(result.stderr));
  assert.deepEqual(JSON.parse(String(result.stdout)), ["@typescript-eslint/no-explicit-any", "@typescript-eslint/no-unused-vars"]);
});

void test("tripwire negative controls reject both ESM import and CommonJS require before resolution", () => {
  for (const action of ['await import("typescript")', 'createRequire(import.meta.url)("@typescript-eslint/eslint-plugin")']) {
    const result = run(guarded + action);
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /LEGACY_INITIALIZER_BLOCKED:/u);
  }
});

void test("existing root entry is lazy and does not initialize the optional ESLint feature", () => {
  const entry = new URL("../dist/index.js", import.meta.url).href;
  const result = run(`
    import { registerHooks } from "node:module";
    registerHooks({ resolve(specifier, context, next) {
      if (["eslint", "eslint-parser-oxc", "oxc-parser", "typescript", "@typescript-eslint/scope-manager"].some((name) => specifier === name || specifier.startsWith(name + "/")) || specifier.includes("/features/eslint-syntax/")) throw new Error("UNEXPECTED_SYNTAX_LOAD:" + specifier);
      return next(specifier, context);
    } });
    const api = await import(${JSON.stringify(entry)});
    if (typeof api.runCommand !== "function") throw new Error("missing existing root contract");
  `);
  assert.equal(result.status, 0, String(result.stderr));
});
