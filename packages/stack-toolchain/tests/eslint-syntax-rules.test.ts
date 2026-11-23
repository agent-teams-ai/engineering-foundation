import assert from "node:assert/strict";
import test from "node:test";
import { Linter } from "eslint";
import { configs, plugin } from "../dist/eslint-syntax.js";
import { applyEdit, expectReports, lint, markedSource, ruleConfig } from "./eslint-syntax-support.ts";

interface RuleFixture {
  rule: string;
  valid: string;
  invalid: string;
  messages: string[];
  fixed?: string;
}

const fixtures: RuleFixture[] = [
  { rule: "ban-ts-comment", valid: "// @ts-expect-error: known fixture\nconsume();", invalid: "«// @ts-ignore»\nconsume();", messages: ["tsIgnoreInsteadOfExpectError"] },
  { rule: "no-array-constructor", valid: "new Array<number>(2); Array(2);", invalid: "«Array(1, 2)»;", messages: ["useLiteral"], fixed: "[1, 2];" },
  { rule: "no-duplicate-enum-values", valid: "enum E { A = 1, B = 2 }", invalid: "enum E { A = 1, «B = 1» }", messages: ["duplicateValue"] },
  { rule: "no-empty-object-type", valid: "interface E { x: number } type T = {} & string;", invalid: "type E = «{}»;", messages: ["noEmptyObject"] },
  { rule: "no-explicit-any", valid: "let value: unknown;", invalid: "let value: «any»;", messages: ["unexpectedAny"] },
  { rule: "no-extra-non-null-assertion", valid: "value!;", invalid: "«value!»!;", messages: ["noExtraNonNullAssertion"], fixed: "value!;" },
  { rule: "no-misused-new", valid: "interface C { new (): Other; }", invalid: "interface C { «new (): C;» }", messages: ["errorMessageInterface"] },
  { rule: "no-namespace", valid: 'declare module "p" { export const value: number; }', invalid: "«namespace N {}»", messages: ["moduleSyntaxIsPreferred"] },
  { rule: "no-non-null-asserted-optional-chain", valid: "foo?.bar;", invalid: "«foo?.bar!»;", messages: ["noNonNullOptionalChain"] },
  { rule: "no-require-imports", valid: 'import value from "p";', invalid: 'const value = «require("p")»;', messages: ["noRequireImports"] },
  { rule: "no-this-alias", valid: "const { value } = this;", invalid: "const «self» = this;", messages: ["thisAssignment"] },
  { rule: "no-unnecessary-type-constraint", valid: "type T<U extends string> = U;", invalid: "type T<«U extends unknown»> = U;", messages: ["unnecessaryConstraint"] },
  { rule: "no-unsafe-declaration-merging", valid: "class A {} interface B {}", invalid: "class «A» {} interface «A» {}", messages: ["unsafeMerging", "unsafeMerging"] },
  { rule: "no-unsafe-function-type", valid: "type F = () => void;", invalid: "type F = «Function»;", messages: ["bannedFunctionType"] },
  { rule: "no-unused-expressions", valid: 'call(); import("p"); optional?.();', invalid: "«value;»", messages: ["unusedExpression"] },
  { rule: "no-unused-vars", valid: "export const used = 1;", invalid: "const «unused» = 1;", messages: ["unusedVar"] },
  { rule: "no-wrapper-object-types", valid: "type T = string;", invalid: "type T = «String»;", messages: ["bannedClassType"], fixed: "type T = string;" },
  { rule: "prefer-as-const", valid: 'const value = "a" as const;', invalid: 'const value = "a" as «"a"»;', messages: ["preferConstAssertion"], fixed: 'const value = "a" as const;' },
  { rule: "prefer-namespace-keyword", valid: "namespace N {}", invalid: "«module N {}»", messages: ["useNamespace"], fixed: "namespace N {}" },
  { rule: "triple-slash-reference", valid: '/// <reference lib="es2024" />\nexport {};', invalid: '«/// <reference path="./types.d.ts" />»\nexport {};', messages: ["tripleSlashReference"] },
];

void test("public recommended preset retains exactly the 20 qualified rule names", () => {
  const names = fixtures.map(({ rule }) => rule).toSorted();
  assert.deepEqual(Object.keys(plugin.rules ?? {}).toSorted(), names);
  assert.equal(configs.recommended.length, 3);
  assert.deepEqual(Object.entries(configs.recommended[2]?.rules ?? {})
    .filter(([name, level]) => name.startsWith("@typescript-eslint/") && level === "error")
    .map(([name]) => name.replace("@typescript-eslint/", "")).toSorted(), names);
});

for (const fixture of fixtures) {
  void test(`${fixture.rule}: accepted source, diagnostic identity and exact span`, () => {
    assert.deepEqual(lint(fixture.rule, fixture.valid), []);
    const messages = expectReports(fixture.rule, fixture.invalid, fixture.messages);
    if (fixture.fixed !== undefined) {
      const fix = messages[0]?.fix;
      assert.ok(fix);
      assert.equal(applyEdit(markedSource(fixture.invalid).code, fix), fixture.fixed);
      const result = new Linter().verifyAndFix(markedSource(fixture.invalid).code, [ruleConfig(fixture.rule)], { filename: "fixture.ts" });
      assert.equal(result.output, fixture.fixed);
      assert.deepEqual(result.messages, []);
    }
  });
}

void test("all eight extensions retain executable syntax diagnostics", () => {
  for (const extension of ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"]) {
    expectReports("no-unused-vars", "const «unused» = 1;", ["unusedVar"], [], `fixture.${extension}`);
  }
});

void test("native fatal parsing remains fatal and does not become a lint success", () => {
  const messages = lint("no-unused-vars", "const value: = ;");
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.fatal, true);
  assert.equal(messages[0]?.severity, 2);
  assert.equal(messages[0]?.ruleId, null);
});

void test("ESLint owns disable directives and unused directive reporting", () => {
  assert.deepEqual(lint("no-explicit-any", "// eslint-disable-next-line @typescript-eslint/no-explicit-any\nlet value: any;"), []);
  const messages = new Linter().verify("// eslint-disable-next-line @typescript-eslint/no-explicit-any\nlet value: string;", [{ ...ruleConfig("no-explicit-any"), linterOptions: { reportUnusedDisableDirectives: "error" } }], { filename: "fixture.ts" });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.ruleId, null);
  assert.equal(messages[0]?.severity, 2);
  assert.equal(messages[0]?.line, 1);
  assert.match(messages[0]?.message ?? "", /^Unused eslint-disable directive/u);
});
