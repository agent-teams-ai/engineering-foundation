import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { parseSync, Visitor } from "oxc-parser";
import { typescriptLoaderOracle } from "./typescript-loader-oracle.ts";
import { NativeSourceParser } from "./typescript-parser-oracle.ts";
import * as ts from "typescript/unstable/ast";
import type { Node, SourceFile, StringLiteralLikeNode } from "typescript/unstable/ast";

interface Reference { kind: string; specifier: string; start: number; end: number }
interface UnresolvedReference { kind: string; start: number; end: number }
interface ParseResult { parseErrors: number; references: Reference[]; unresolved: UnresolvedReference[] }
interface Fixture {
  name: string; filename: string; source: string; expected: string[];
  unresolved?: string[]; parseError?: boolean;
}
interface Literal { value: string; start: number; end: number }

const supportedArguments = new Set(["--verify-only"]);
for (const argument of process.argv.slice(2)) {
  assert.ok(supportedArguments.has(argument), `Unsupported argument: ${argument}`);
}
const verifyOnly = process.argv.includes("--verify-only");

const cases: Fixture[] = [
  {
    name: "esm-static-and-type-edges",
    filename: "module.ts",
    source: `
import type DefaultType from "type-only";
import value from "value";
import { type A, B } from "mixed";
import { type C } from "named-type-only";
import "side-effect";
export * from "export-all";
export type { X } from "export-type";
export { type Y } from "export-named-type";
export { Z } from "export-value";
`,
    expected: [
      "export:export-named-type",
      "export-type:export-type",
      "export:export-all",
      "export:export-value",
      "static:named-type-only",
      "static-type:type-only",
      "static:mixed",
      "static:side-effect",
      "static:value",
    ],
  },
  {
    name: "dynamic-commonjs-and-typescript-specific-edges",
    filename: "module.cts",
    source: `
const dynamicValue = import("dynamic-value");
type Imported = import("type-query").Imported;
import alias = require("import-equals");
import type typeAlias = require("import-equals-type");
const common = require("commonjs");
void dynamicValue;
void common;
`,
    expected: [
      "commonjs:commonjs",
      "dynamic:dynamic-value",
      "import-equals-type:import-equals-type",
      "import-equals:import-equals",
      "type-query:type-query",
    ],
  },
  {
    name: "comments-strings-and-unrelated-call-shapes",
    filename: "false-positives.ts",
    source: `
// import "comment";
const documentation = 'require("string")';
const template = \`import("template")\`;
const meta = import.meta.url;
require.resolve("require-resolve");
module.require("module-require");
void documentation;
void template;
void meta;
`,
    expected: ["commonjs:module-require"],
  },
  {
    name: "non-literal-loads-fail-closed",
    filename: "unresolved.ts",
    source: `
declare const moduleName: string;
void import(moduleName);
void require(moduleName);
`,
    expected: [],
    unresolved: ["commonjs", "dynamic"],
  },
  {
    name: "jsx-and-import-attributes",
    filename: "component.tsx",
    source: `
import data from "json-data" with { type: "json" };
import { render } from "renderer";
export const view = <main>{render(data)}</main>;
`,
    expected: ["static:json-data", "static:renderer"],
  },
  {
    name: "escaped-module-specifier",
    filename: "escaped.mts",
    source: `import "escaped\\u002dname";`,
    expected: ["static:escaped-name"],
  },
  {
    name: "ambient-and-internal-import-equals-are-not-edges",
    filename: "ambient.ts",
    source: `
declare module "ambient-only" { export const value: string; }
declare namespace Internal { const value: string; }
import alias = Internal.value;
void alias;
`,
    expected: [],
  },
  {
    name: "shadowed-require-is-a-user-api",
    filename: "shadowed.cts",
    source: `
function require(name: string): string { return name; }
void require("shadowed-require");
`,
    expected: [],
  },
  {
    name: "malformed-source-fails-closed",
    filename: "malformed.ts",
    source: `import { broken from "broken";`,
    expected: [],
    parseError: true,
  },
];

const oxcOnlyCases: (Fixture & { expectedTypeScriptParseError: boolean })[] = [
  {
    name: "import-source-phase",
    filename: "modern.ts",
    source: `import source moduleSource from "source-phase";`,
    expected: ["static:source-phase"],
    expectedTypeScriptParseError: true,
  },
];

function reference(kind: string, literal: Literal): Reference {
  return {
    kind,
    specifier: literal.value,
    start: literal.start,
    end: literal.end,
  };
}

function unresolved(kind: string, node: { start: number; end: number }): UnresolvedReference {
  return { kind, start: node.start, end: node.end };
}

function sorted(result: ParseResult): ParseResult {
  return {
    parseErrors: result.parseErrors,
    references: result.references.toSorted(
      (left, right) =>
        left.start - right.start ||
        left.kind.localeCompare(right.kind) ||
        left.specifier.localeCompare(right.specifier),
    ),
    unresolved: result.unresolved.toSorted(
      (left, right) => left.start - right.start || left.kind.localeCompare(right.kind),
    ),
  };
}

function parseWithOxc(filename: string, source: string): ParseResult {
  const parsed = parseSync(filename, source, { astType: "ts" });
  if (parsed.errors.length > 0) {
    return { parseErrors: parsed.errors.length, references: [], unresolved: [] };
  }

  const references: Reference[] = [];
  const unresolvedReferences: UnresolvedReference[] = [];
  const visitor = new Visitor({
    CallExpression(node) {
      // This standalone parity corpus covers direct ambient loaders only.
      // Full lexical/alias/factory behavior is asserted against the production
      // adapter in the dedicated source-dependency-loader-edges tests.
      const callee = node.callee;
      const identifier = callee.type === "Identifier" && callee.name === "require"
        ? callee : callee.type === "MemberExpression" && !callee.computed &&
          callee.object.type === "Identifier" && callee.object.name === "module" &&
          callee.property.type === "Identifier" && callee.property.name === "require"
          ? callee.object : undefined;
      if (identifier === undefined || parsed.program.body.some((statement) =>
        statement.type === "FunctionDeclaration" && statement.id?.name === identifier.name)) {
        return;
      }
      const argument = node.arguments[0];
      if (argument?.type === "Literal" && typeof argument.value === "string") {
        references.push(reference("commonjs", argument));
      } else {
        unresolvedReferences.push(unresolved("commonjs", node));
      }
    },
    ExportAllDeclaration(node) {
      references.push(
        reference(node.exportKind === "type" ? "export-type" : "export", node.source),
      );
    },
    ExportNamedDeclaration(node) {
      if (node.source === null) {
        return;
      }
      references.push(reference(node.exportKind === "type" ? "export-type" : "export", node.source));
    },
    ImportDeclaration(node) {
      references.push(reference(node.importKind === "type" ? "static-type" : "static", node.source));
    },
    ImportExpression(node) {
      if (node.source.type === "Literal" && typeof node.source.value === "string") {
        references.push(reference("dynamic", node.source));
      } else {
        unresolvedReferences.push(unresolved("dynamic", node));
      }
    },
    TSImportEqualsDeclaration(node) {
      if (node.moduleReference.type !== "TSExternalModuleReference") { return; }
      const expression = node.moduleReference.expression;
      if (
        expression.type === "Literal" &&
        typeof expression.value === "string"
      ) {
        references.push(
          reference(
            node.importKind === "type" ? "import-equals-type" : "import-equals",
            expression,
          ),
        );
      }
    },
    TSImportType(node) {
      if (node.source.type === "Literal" && typeof node.source.value === "string") {
        references.push(reference("type-query", node.source));
      } else {
        unresolvedReferences.push(unresolved("type-query", node));
      }
    },
  });
  visitor.visit(parsed.program);
  return sorted({
    parseErrors: 0,
    references,
    unresolved: unresolvedReferences,
  });
}

function typescriptLiteral(node: StringLiteralLikeNode, sourceFile: SourceFile): Literal {
  return {
    value: node.text,
    start: node.getStart(sourceFile),
    end: node.getEnd(),
  };
}

function parseWithTypeScript(filename: string, source: string): ParseResult {
  return nativeParser.inspect(filename, source, (sourceFile, checker, diagnostics) => {
    const parseErrors = diagnostics.length;
    if (parseErrors > 0) {
      return { parseErrors, references: [], unresolved: [] };
    }

    const references: Reference[] = [];
    const unresolvedReferences: UnresolvedReference[] = [];
    const loaderOrigin = typescriptLoaderOracle(checker);
    function visit(node: Node): void {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLikeNode(node.moduleSpecifier)) {
        references.push(
          reference(
            node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword ? "static-type" : "static",
            typescriptLiteral(node.moduleSpecifier, sourceFile),
          ),
        );
      } else if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteralLikeNode(node.moduleSpecifier)
      ) {
        references.push(
          reference(
            node.isTypeOnly ? "export-type" : "export",
            typescriptLiteral(node.moduleSpecifier, sourceFile),
          ),
        );
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression !== undefined &&
        ts.isStringLiteralLikeNode(node.moduleReference.expression)
      ) {
        references.push(
          reference(
            node.isTypeOnly ? "import-equals-type" : "import-equals",
            typescriptLiteral(node.moduleReference.expression, sourceFile),
          ),
        );
      } else if (ts.isImportTypeNode(node)) {
        const literal = node.argument;
        if (ts.isLiteralTypeNode(literal) && ts.isStringLiteralLikeNode(literal.literal)) {
          references.push(
            reference("type-query", typescriptLiteral(literal.literal, sourceFile)),
          );
        } else {
          unresolvedReferences.push({
            kind: "type-query",
            start: node.getStart(sourceFile),
            end: node.getEnd(),
          });
        }
      } else if (ts.isCallExpression(node)) {
        const origin = loaderOrigin(node.expression);
        const kind = node.expression.kind === ts.SyntaxKind.ImportKeyword ? "dynamic"
          : origin?.kind === "loader" ? "commonjs" : undefined;
        if (kind !== undefined) {
          const argument = node.arguments[0];
          if (argument !== undefined && ts.isStringLiteral(argument)) {
            references.push(
              reference(kind, typescriptLiteral(argument, sourceFile)),
            );
          } else {
            unresolvedReferences.push({
              kind,
              start: node.getStart(sourceFile),
              end: node.getEnd(),
            });
          }
        }
      }
      node.forEachChild(visit);
    }
    visit(sourceFile);
    return sorted({
      parseErrors: 0,
      references,
      unresolved: unresolvedReferences,
    });
  });
}

function labels(result: ParseResult): string[] {
  return result.references.map((entry) => `${entry.kind}:${entry.specifier}`).toSorted();
}

function unresolvedLabels(result: ParseResult): string[] {
  return result.unresolved.map((entry) => entry.kind).toSorted();
}

function assertLocations(source: string, result: ParseResult): void {
  for (const edge of result.references) {
    const literalSource = source.slice(edge.start, edge.end);
    assert.ok(
      literalSource.startsWith('"') || literalSource.startsWith("'"),
      `Reference location is not a string literal: ${literalSource}`,
    );
  }
}

function benchmark(parser: (filename: string, source: string) => ParseResult, source: string, iterations: number): number {
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    parser("benchmark.tsx", source);
  }
  return performance.now() - started;
}

function median(values: number[]): number {
  const ordered = values.toSorted((left, right) => left - right);
  const middle = ordered[Math.floor(ordered.length / 2)];
  assert.notEqual(middle, undefined);
  return middle!;
}

const nativeParser = new NativeSourceParser();
try {
  assert.equal(cases.length, 9, "retain the complete shared corpus");
  assert.equal(oxcOnlyCases.length, 1, "retain the independent modern-syntax case");
  for (const fixture of cases) {
    const oxc = parseWithOxc(fixture.filename, fixture.source);
    const typescript = parseWithTypeScript(fixture.filename, fixture.source);
    assert.equal(oxc.parseErrors > 0, fixture.parseError === true, `${fixture.name}: Oxc`);
    assert.equal(
      typescript.parseErrors > 0,
      fixture.parseError === true,
      `${fixture.name}: TypeScript`,
    );
    if (fixture.parseError === true) {
      continue;
    }
    assert.deepEqual(labels(oxc), fixture.expected.toSorted(), `${fixture.name}: Oxc truth`);
    assert.deepEqual(
      labels(typescript),
      fixture.expected.toSorted(),
      `${fixture.name}: TypeScript truth`,
    );
    assert.deepEqual(oxc, typescript, `${fixture.name}: normalized parity`);
    assert.deepEqual(
      unresolvedLabels(oxc),
      (fixture.unresolved ?? []).toSorted(),
      `${fixture.name}: Oxc unresolved`,
    );
    assertLocations(fixture.source, oxc);
  }

  for (const fixture of oxcOnlyCases) {
    const oxc = parseWithOxc(fixture.filename, fixture.source);
    const typescript = parseWithTypeScript(fixture.filename, fixture.source);
    assert.deepEqual(labels(oxc), fixture.expected, `${fixture.name}: Oxc truth`);
    assert.equal(
      typescript.parseErrors > 0,
      fixture.expectedTypeScriptParseError,
      `${fixture.name}: expected TypeScript parser limitation`,
    );
  }

  const benchmarkSeed = cases
    .filter((fixture) => fixture.parseError !== true)
    .map((fixture) => fixture.source)
    .join("\n");
  function benchmarkProfile(name: string, repetitions: number, iterations: number) {
    const source = Array.from({ length: repetitions }, () => benchmarkSeed).join("\n");
    parseWithOxc("warmup.tsx", source);
    parseWithTypeScript("warmup.tsx", source);
    const oxcRuns = [];
    const typescriptRuns = [];
    for (let round = 0; round < 5; round += 1) {
      const first = round % 2 === 0 ? "oxc" : "typescript";
      if (first === "oxc") {
        oxcRuns.push(benchmark(parseWithOxc, source, iterations));
        typescriptRuns.push(benchmark(parseWithTypeScript, source, iterations));
      } else {
        typescriptRuns.push(benchmark(parseWithTypeScript, source, iterations));
        oxcRuns.push(benchmark(parseWithOxc, source, iterations));
      }
    }
    const oxcMilliseconds = median(oxcRuns);
    const typescriptMilliseconds = median(typescriptRuns);
    return {
      name,
      iterations,
      sourceBytes: Buffer.byteLength(source),
      oxcMilliseconds: Number(oxcMilliseconds.toFixed(2)),
      typescript7NativeMilliseconds: Number(typescriptMilliseconds.toFixed(2)),
      oxcSpeedup: Number((typescriptMilliseconds / oxcMilliseconds).toFixed(2)),
    };
  }

  const report = {
    schemaVersion: 1,
    corpusCases: cases.length + oxcOnlyCases.length,
    parityCases: cases.length,
    knownDivergences: [
      {
        feature: "import source phase",
        oxc: "supported",
        typescript7NativeApi: "parse error",
      },
    ],
    conservativeDecisions: [
      "Only proven Node loader bindings produce edges; shadowed user APIs do not.",
      "Non-literal loads, written loader bindings, and unrepresentable bases remain unresolved; consumer runtimeReferences exceptions stay explicit.",
      "Any parser error discards partial edges and must fail closed.",
    ],
    ...(verifyOnly
      ? {}
      : {
          endToEndExtractionBenchmark: [
            benchmarkProfile("small", 1, 1_000),
            benchmarkProfile("medium", 10, 200),
            benchmarkProfile("large", 50, 50),
          ],
        }),
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

} finally {
  nativeParser.close();
}
