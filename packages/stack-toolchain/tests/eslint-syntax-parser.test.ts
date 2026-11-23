import assert from "node:assert/strict";
import test from "node:test";
import { parser } from "../dist/eslint-syntax.js";
import { ImplicitLibVariable } from "../dist/features/eslint-syntax/scope-runtime.js";

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

function nodes(value: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const child of value) {
      nodes(child, found);
    }
  } else if (value !== null && typeof value === "object") {
    const node = record(value);
    if (typeof node["type"] === "string") {
      found.push(node);
    }
    for (const [key, child] of Object.entries(node)) {
      if (!["loc", "range", "parent", "tokens", "comments"].includes(key)) {
        nodes(child, found);
      }
    }
  }
  return found;
}

function parse(code: string): Record<string, unknown> {
  assert.ok("parseForESLint" in parser);
  const result: unknown = parser.parseForESLint(code, { filePath: "fixture.ts" });
  return record(result);
}

void test("native absent children retain their actual null shape without normalization", () => {
  const result = parse(
    "function plain(value) { return value; } type Box<T> = T; declare function empty(): void; class C { field; method() {} } call();",
  );
  const all = nodes(result["ast"]);
  const checks = [
    ["Identifier", "typeAnnotation"],
    ["CallExpression", "typeArguments"],
    ["TSTypeParameter", "constraint"],
    ["TSTypeParameter", "default"],
    ["FunctionDeclaration", "returnType"],
    ["TSDeclareFunction", "body"],
    ["PropertyDefinition", "typeAnnotation"],
  ] as const;
  for (const [type, property] of checks) {
    const node = all.find((candidate) => candidate["type"] === type);
    assert.ok(node, type);
    assert.equal(node[property], null, `${type}.${property}`);
  }
  assert.deepEqual(result["services"], {});
});

void test("native library variables preserve the admitted nominal constructor identity", () => {
  const result = parse("export type T = Promise<Array<string>>;");
  const scopes = record(result["scopeManager"])["scopes"];
  assert.ok(Array.isArray(scopes));
  const variables = record(scopes[0])["variables"];
  assert.ok(Array.isArray(variables));
  for (const name of ["Promise", "Array"]) {
    const variable: unknown = variables.find(
      (candidate: unknown) => record(candidate)["name"] === name,
    );
    assert.ok(variable instanceof ImplicitLibVariable, name);
  }
});

void test("native parse result exposes source-preserving tokens, comments, ranges and JSX", () => {
  const result = parse("// retained\nnew Array<Map<string, Array<number>>>();");
  const ast = record(result["ast"]);
  const tokens = ast["tokens"];
  const comments = ast["comments"];
  assert.ok(Array.isArray(tokens));
  assert.ok(Array.isArray(comments));
  assert.equal(record(comments[0])["value"], " retained");
  assert.deepEqual(
    tokens
      .filter((token: unknown) => record(token)["value"] === ">")
      .map((token: unknown) => record(token)["value"]),
    [">", ">", ">"],
  );
  assert.equal(ast["type"], "Program");
  assert.ok(Array.isArray(ast["range"]));
  assert.ok("parseForESLint" in parser);
  const jsx: unknown = parser.parseForESLint("export const view = <span>&amp;</span>;", {
    filePath: "fixture.tsx",
  });
  const text = nodes(record(jsx)["ast"]).find((node) => node["type"] === "JSXText");
  assert.equal(text?.["value"], "&");
});
