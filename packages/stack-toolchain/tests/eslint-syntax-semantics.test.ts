import assert from "node:assert/strict";
import test from "node:test";
import { Linter } from "eslint";
import { applyDefault } from "../dist/features/eslint-syntax/adapters/create-rule.js";
import {
  applyEdit,
  expectReports,
  lint,
  markedSource,
  ruleConfig,
} from "./eslint-syntax-support.ts";

void test("unused-variable collector preserves scoped names and separate type references", () => {
  const valid = [
    "export const run = function recur(n: number): number { return n ? recur(n - 1) : 0; };",
    "export function recur(n: number): number { return n ? recur(n - 1) : 0; }",
    "export type M<T> = { [K in keyof T]: T[K] };",
    "export enum E { A = 1, B = A + 1 }",
    "export class C { constructor(public value: number) {} }",
    'import type { Value } from "p"; export type T = Value;',
    "export function f(value: unknown): value is string { return typeof value === 'string'; }",
    "export namespace N { export interface Value { value: number } }",
    "export function f(first: number, last: number) { return last; }",
  ];
  for (const code of valid) {
    assert.deepEqual(lint("no-unused-vars", code), [], code);
  }
  expectReports(
    "no-unused-vars",
    "function «recur»(n: number): number { return n ? recur(n - 1) : 0; }",
    ["unusedVar"],
  );
  expectReports("no-unused-vars", "const «value» = 1; export type T = typeof value;", [
    "usedOnlyAsType",
  ]);
  expectReports(
    "no-unused-vars",
    "export function f(first: number, «last»: number) { return first; }",
    ["unusedVar"],
  );
  expectReports(
    "no-unused-vars",
    "export function f(«first»: number, last: number) { return last; }",
    ["unusedVar"],
    [{ args: "all" }],
  );
});

void test("declaration-file ambient export exemption does not hide module-local declarations", () => {
  for (const filename of ["fixture.d.ts", "fixture.d.mts", "fixture.d.cts"]) {
    assert.deepEqual(lint("no-unused-vars", "declare const ambient: 1234;", [], filename), []);
    assert.deepEqual(
      lint("no-unused-vars", "export declare const published: 1234;", [], filename),
      [],
    );
    expectReports(
      "no-unused-vars",
      "const «unused»: 1234; export {};",
      ["unusedVar"],
      [],
      filename,
    );
  }
});

void test("unused-variable options retain rest siblings, caught errors and ignored-name reporting", () => {
  assert.deepEqual(
    lint("no-unused-vars", "const { ignored, ...rest } = source; export { rest };", [
      { ignoreRestSiblings: true },
    ]),
    [],
  );
  assert.deepEqual(
    lint("no-unused-vars", "try { run(); } catch (ignored) { recover(); }", [
      { caughtErrors: "none" },
    ]),
    [],
  );
  expectReports("no-unused-vars", "try { run(); } catch («unused») { recover(); }", ["unusedVar"]);
  expectReports(
    "no-unused-vars",
    "const «_used» = 1; consume(_used);",
    ["usedIgnoredVar"],
    [{ varsIgnorePattern: "^_", reportUsedIgnorePattern: true }],
  );
  assert.deepEqual(
    lint("no-unused-vars", "const [_ignored, used] = source; consume(used);", [
      { destructuredArrayIgnorePattern: "^_" },
    ]),
    [],
  );
  expectReports("no-unused-vars", "/* global «unused» */", ["unusedVar"], [], "fixture.js");
});

void test("unused-expression options preserve all branches and native TypeScript wrappers", () => {
  for (const code of [
    "condition && call();",
    "condition ? first() : second();",
    "tag`value`;",
    "value as string;",
    "value!;",
    "generic<string>;",
    "<string>value;",
  ]) {
    expectReports("no-unused-expressions", `«${code}»`, ["unusedExpression"]);
  }
  const options = [{ allowShortCircuit: true, allowTernary: true, allowTaggedTemplates: true }];
  for (const code of [
    "condition && call();",
    "condition ? first() : second();",
    "tag`value`;",
    'import("p");',
    "fn?.();",
    "void value;",
    "delete object.key;",
  ]) {
    assert.deepEqual(lint("no-unused-expressions", code, options), [], code);
  }
  expectReports("no-unused-expressions", "«condition && value;»", ["unusedExpression"], options);
  expectReports(
    "no-unused-expressions",
    "«condition ? call() : value;»",
    ["unusedExpression"],
    options,
  );
  assert.deepEqual(lint("no-unused-expressions", "<div />;", [], "fixture.tsx"), []);
  expectReports(
    "no-unused-expressions",
    "«<div />;»",
    ["unusedExpression"],
    [{ enforceForJSX: true }],
    "fixture.tsx",
  );
});

void test("directives retain program/function, namespace and static-block distinctions", () => {
  assert.deepEqual(lint("no-unused-expressions", '"custom"; function f() { "custom"; }'), []);
  // Retained upstream valid fixtures explicitly admit namespace directive prologues.
  assert.deepEqual(lint("no-unused-expressions", 'namespace N { "custom"; }'), []);
  assert.deepEqual(
    lint("no-unused-expressions", 'namespace N { "custom"; }', [{ ignoreDirectives: true }]),
    [],
  );
  expectReports("no-unused-expressions", 'namespace N { call(); «"late";» }', ["unusedExpression"]);
  expectReports(
    "no-unused-expressions",
    'class C { static { «"custom";» } }',
    ["unusedExpression"],
    [{ ignoreDirectives: true }],
  );
  expectReports(
    "no-unused-expressions",
    'call(); «"late";»',
    ["unusedExpression"],
    [{ ignoreDirectives: true }],
  );
});

interface SuggestionFixture {
  rule: string;
  marked: string;
  messageId: string;
  suggestions: { messageId: string; output: string }[];
  filename?: string;
}

const suggestions: SuggestionFixture[] = [
  {
    rule: "ban-ts-comment",
    marked: "«// @ts-ignore: known fixture»\nconsume();",
    messageId: "tsIgnoreInsteadOfExpectError",
    suggestions: [
      {
        messageId: "replaceTsIgnoreWithTsExpectError",
        output: "// @ts-expect-error: known fixture\nconsume();",
      },
    ],
  },
  {
    rule: "no-empty-object-type",
    marked: "type T = «{}»;",
    messageId: "noEmptyObject",
    suggestions: [
      { messageId: "replaceEmptyObjectType", output: "type T = object;" },
      { messageId: "replaceEmptyObjectType", output: "type T = unknown;" },
    ],
  },
  {
    rule: "no-explicit-any",
    marked: "type T = «any»;",
    messageId: "unexpectedAny",
    suggestions: [
      { messageId: "suggestUnknown", output: "type T = unknown;" },
      { messageId: "suggestNever", output: "type T = never;" },
    ],
  },
  {
    rule: "no-non-null-asserted-optional-chain",
    marked: "«foo?.bar!»;",
    messageId: "noNonNullOptionalChain",
    suggestions: [{ messageId: "suggestRemovingNonNull", output: "foo?.bar;" }],
  },
  {
    rule: "no-unnecessary-type-constraint",
    marked: "const fn = <«T extends unknown»>(value: T) => value;",
    messageId: "unnecessaryConstraint",
    filename: "fixture.tsx",
    suggestions: [
      { messageId: "removeUnnecessaryConstraint", output: "const fn = <T,>(value: T) => value;" },
    ],
  },
  {
    rule: "prefer-as-const",
    marked: 'let value: «"a"» = "a";',
    messageId: "variableConstAssertion",
    suggestions: [{ messageId: "variableSuggest", output: 'let value = "a" as const;' }],
  },
  {
    rule: "no-unused-vars",
    marked: 'import { «unused», /* keep */ used } from "p"; consume(used);',
    messageId: "unusedVar",
    suggestions: [
      {
        messageId: "removeUnusedVar",
        output: 'import {  /* keep */ used } from "p"; consume(used);',
      },
    ],
  },
];

for (const fixture of suggestions) {
  void test(`${fixture.rule}: literal suggestion bytes${fixture.filename ? " in TSX" : ""}`, () => {
    const messages = expectReports(
      fixture.rule,
      fixture.marked,
      [fixture.messageId],
      [],
      fixture.filename,
    );
    assert.deepEqual(
      messages[0]?.suggestions?.map(({ messageId, fix }) => ({
        messageId,
        output: applyEdit(markedSource(fixture.marked).code, fix),
      })),
      fixture.suggestions,
    );
  });
}

void test("constructor fix retains argument comments and generic closers remain intact", () => {
  const result = new Linter().verifyAndFix(
    "Array/*before*/(first, /*inside*/ second);",
    [ruleConfig("no-array-constructor")],
    { filename: "fixture.ts" },
  );
  assert.equal(result.output, "[first, /*inside*/ second];");
  assert.deepEqual(result.messages, []);
  assert.deepEqual(lint("no-array-constructor", "new Array<Map<string, Array<number>>>();"), []);
});

void test("option merging preserves nested undefined, replaces arrays, and leaves defaults immutable", () => {
  const defaults = [{ nested: { left: true, right: true }, values: [1, 2] }, false] as const;
  const merged = applyDefault(defaults, [{ nested: { right: undefined }, values: [3] }, undefined]);
  assert.deepEqual(merged, [{ nested: { left: true, right: undefined }, values: [3] }, false]);
  assert.deepEqual(defaults, [{ nested: { left: true, right: true }, values: [1, 2] }, false]);
  assert.notEqual(merged[0], defaults[0]);
  assert.deepEqual(lint("no-this-alias", "const self = this;", [{ allowedNames: ["self"] }]), []);
  assert.deepEqual(
    lint("no-require-imports", 'require("./allowed.json");', [{ allow: ["\\.json$"] }]),
    [],
  );
});
