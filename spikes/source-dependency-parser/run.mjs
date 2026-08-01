import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { parseSync, Visitor } from "oxc-parser";
import ts from "typescript";

const supportedArguments = new Set(["--verify-only"]);
for (const argument of process.argv.slice(2)) {
  assert.ok(supportedArguments.has(argument), `Unsupported argument: ${argument}`);
}
const verifyOnly = process.argv.includes("--verify-only");

const cases = [
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
      "export-type:export-named-type",
      "export-type:export-type",
      "export:export-all",
      "export:export-value",
      "static-type:named-type-only",
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
    expected: [],
  },
  {
    name: "non-literal-loads-fail-closed",
    filename: "unresolved.ts",
    source: `
declare const moduleName: string;
void import(moduleName);
declare function require(name: string): unknown;
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
    name: "shadowed-require-is-conservatively-an-edge",
    filename: "shadowed.cts",
    source: `
function require(name: string): string { return name; }
void require("shadowed-require");
`,
    expected: ["commonjs:shadowed-require"],
  },
  {
    name: "malformed-source-fails-closed",
    filename: "malformed.ts",
    source: `import { broken from "broken";`,
    expected: [],
    parseError: true,
  },
];

const oxcOnlyCases = [
  {
    name: "import-source-phase",
    filename: "modern.ts",
    source: `import source moduleSource from "source-phase";`,
    expected: ["static:source-phase"],
    expectedTypeScriptParseError: true,
  },
];

function reference(kind, literal) {
  return {
    kind,
    specifier: literal.value,
    start: literal.start,
    end: literal.end,
  };
}

function unresolved(kind, node) {
  return { kind, start: node.start, end: node.end };
}

function sorted(result) {
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

function oxcAllTypeSpecifiers(specifiers, field) {
  return (
    specifiers.length > 0 &&
    specifiers.every((specifier) => specifier[field] === "type")
  );
}

function parseWithOxc(filename, source) {
  const parsed = parseSync(filename, source, { astType: "ts" });
  if (parsed.errors.length > 0) {
    return { parseErrors: parsed.errors.length, references: [], unresolved: [] };
  }

  const references = [];
  const unresolvedReferences = [];
  const visitor = new Visitor({
    CallExpression(node) {
      if (node.callee.type !== "Identifier" || node.callee.name !== "require") {
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
      const typeOnly =
        node.exportKind === "type" ||
        oxcAllTypeSpecifiers(node.specifiers, "exportKind");
      references.push(reference(typeOnly ? "export-type" : "export", node.source));
    },
    ImportDeclaration(node) {
      const typeOnly =
        node.importKind === "type" ||
        oxcAllTypeSpecifiers(node.specifiers, "importKind");
      references.push(reference(typeOnly ? "static-type" : "static", node.source));
    },
    ImportExpression(node) {
      if (node.source.type === "Literal" && typeof node.source.value === "string") {
        references.push(reference("dynamic", node.source));
      } else {
        unresolvedReferences.push(unresolved("dynamic", node));
      }
    },
    TSImportEqualsDeclaration(node) {
      const expression = node.moduleReference.expression;
      if (
        node.moduleReference.type === "TSExternalModuleReference" &&
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

function scriptKind(filename) {
  return ts.getScriptKindFromFileName(filename) || ts.ScriptKind.TS;
}

function typescriptAllTypeImports(node) {
  const clause = node.importClause;
  if (clause === undefined || clause.name !== undefined) {
    return clause?.isTypeOnly === true;
  }
  if (clause.isTypeOnly || !ts.isNamedImports(clause.namedBindings)) {
    return clause.isTypeOnly;
  }
  return (
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly)
  );
}

function typescriptAllTypeExports(node) {
  if (node.isTypeOnly) {
    return true;
  }
  return (
    node.exportClause !== undefined &&
    ts.isNamedExports(node.exportClause) &&
    node.exportClause.elements.length > 0 &&
    node.exportClause.elements.every((element) => element.isTypeOnly)
  );
}

function typescriptLiteral(node, sourceFile) {
  return {
    value: node.text,
    start: node.getStart(sourceFile),
    end: node.getEnd(),
  };
}

function parseWithTypeScript(filename, source) {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(filename),
  );
  const parseErrors = sourceFile.parseDiagnostics?.length ?? 0;
  if (parseErrors > 0) {
    return { parseErrors, references: [], unresolved: [] };
  }

  const references = [];
  const unresolvedReferences = [];
  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      references.push(
        reference(
          typescriptAllTypeImports(node) ? "static-type" : "static",
          typescriptLiteral(node.moduleSpecifier, sourceFile),
        ),
      );
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      references.push(
        reference(
          typescriptAllTypeExports(node) ? "export-type" : "export",
          typescriptLiteral(node.moduleSpecifier, sourceFile),
        ),
      );
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      references.push(
        reference(
          node.isTypeOnly ? "import-equals-type" : "import-equals",
          typescriptLiteral(node.moduleReference.expression, sourceFile),
        ),
      );
    } else if (ts.isImportTypeNode(node)) {
      const literal = node.argument;
      if (ts.isLiteralTypeNode(literal) && ts.isStringLiteralLike(literal.literal)) {
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
      const kind =
        node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? "dynamic"
          : ts.isIdentifier(node.expression) && node.expression.text === "require"
            ? "commonjs"
            : undefined;
      if (kind !== undefined) {
        const argument = node.arguments[0];
        if (argument !== undefined && ts.isStringLiteralLike(argument)) {
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
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return sorted({
    parseErrors: 0,
    references,
    unresolved: unresolvedReferences,
  });
}

function labels(result) {
  return result.references.map((entry) => `${entry.kind}:${entry.specifier}`).toSorted();
}

function unresolvedLabels(result) {
  return result.unresolved.map((entry) => entry.kind).toSorted();
}

function assertLocations(source, result) {
  for (const edge of result.references) {
    const literalSource = source.slice(edge.start, edge.end);
    assert.ok(
      literalSource.startsWith('"') || literalSource.startsWith("'"),
      `Reference location is not a string literal: ${literalSource}`,
    );
  }
}

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
function benchmark(parser, source, iterations) {
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    parser("benchmark.tsx", source);
  }
  return performance.now() - started;
}

function median(values) {
  const ordered = values.toSorted((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

function benchmarkProfile(name, repetitions, iterations) {
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
    typescript6Milliseconds: Number(typescriptMilliseconds.toFixed(2)),
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
      typescript6CompilerApi: "parse error",
    },
  ],
  conservativeDecisions: [
    "A string-literal require call is an edge even when require is lexically shadowed.",
    "A non-literal dynamic import or require call is unresolved and must fail closed.",
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
