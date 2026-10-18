import { isBuiltin } from "node:module";

import {
  parseSync, Visitor,
  type Declaration, type Expression, type ParseResult, type Program, type StaticExport
} from "oxc-parser";

import { compareBinaryStrings } from "../../../../../binary-string-comparator.js";
import type { SourceFileSnapshot } from "../../../application/model/source-file-snapshot.js";
import type {
  ParsedSourceDependencies,
  SourceDependencyKind,
  SourceDependencyReference,
  SourceRuntimeExport,
  SourceRuntimeExportKind,
  UnresolvedSourceDependency,
  UnsupportedSourceExport
} from "../../../application/model/source-workspace.js";
import type { SourceDependencyParser } from "../../../application/ports/source-dependency-parser.js";

import { LoaderBindingAnalysis } from "./loader-binding-analysis.js";

function reference(
  kind: SourceDependencyKind,
  literal: { readonly value: unknown; readonly start: number; readonly end: number }
): SourceDependencyReference | undefined {
  return typeof literal.value === "string"
    ? { kind, specifier: literal.value, start: literal.start, end: literal.end }
    : undefined;
}

function unresolved(
  kind: UnresolvedSourceDependency["kind"],
  node: { readonly start: number; readonly end: number }
): UnresolvedSourceDependency {
  return { kind, start: node.start, end: node.end };
}

type ExportStatement = Extract<Program["body"][number], { type: "ExportNamedDeclaration" | "ExportDefaultDeclaration" }>;

// Only direct syntactic values are classified. Calls, imported/local aliases and
// mutable declarations need another producer; their kind is never guessed.
function runtimeValueKind(node: Declaration | Expression | null): SourceRuntimeExportKind | undefined {
  if (node === null) { return undefined; }
  if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)) { return "function"; }
  if (["Literal", "ObjectExpression", "ArrayExpression", "TemplateLiteral", "ClassDeclaration", "ClassExpression"].includes(node.type)) {
    return "value";
  }
  if (node.type === "ParenthesizedExpression" || node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression" ||
      node.type === "TSTypeAssertion" || node.type === "TSNonNullExpression") {
    return runtimeValueKind(node.expression);
  }
  return undefined;
}

function directExportKind(statement: ExportStatement | undefined, name: string): SourceRuntimeExportKind | undefined {
  const declaration = statement?.declaration;
  if (declaration === undefined || declaration === null) { return undefined; }
  if (declaration.type !== "VariableDeclaration") { return runtimeValueKind(declaration); }
  if (declaration.kind !== "const") { return undefined; }
  const binding = declaration.declarations.find(({ id }) => id.type === "Identifier" && id.name === name);
  return runtimeValueKind(binding?.init ?? null);
}

type ExportObservations = { runtimeExports: SourceRuntimeExport[]; unsupportedExports: UnsupportedSourceExport[] };

function observeStaticExport(statement: ExportStatement | undefined, exported: StaticExport, facts: ExportObservations): void {
  const declaration = statement?.declaration;
  if (declaration !== undefined && declaration !== null && "declare" in declaration && declaration.declare) { return; }
  for (const entry of exported.entries) {
    if (entry.isType) { continue; }
    const name = statement?.type === "ExportDefaultDeclaration" ? "default" : entry.exportName.name;
    const kind = name === null ? undefined : directExportKind(statement, name);
    if (entry.moduleRequest !== null || name === null) {
      facts.unsupportedExports.push({ kind: "reexport", start: entry.start, end: entry.end });
    } else if (kind === undefined) {
      const reason = declaration === null ? "binding" : statement?.type === "ExportDefaultDeclaration" ? "expression" : "declaration";
      facts.unsupportedExports.push({ kind: reason, start: entry.start, end: entry.end });
    } else {
      facts.runtimeExports.push({ name, kind, start: exported.start, end: exported.end });
    }
  }
}

function observeRuntimeExports(parsed: ParseResult, path: string): ExportObservations {
  const facts: ExportObservations = { runtimeExports: [], unsupportedExports: [] };
  const statements = new Map<number, ExportStatement>();
  for (const statement of parsed.program.body) {
    if (statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration") {
      statements.set(statement.start, statement);
    } else if (statement.type === "TSExportAssignment") {
      facts.unsupportedExports.push({ kind: "declaration", start: statement.start, end: statement.end });
    }
  }
  for (const exported of parsed.module.staticExports) {
    observeStaticExport(statements.get(exported.start), exported, facts);
  }
  if (parsed.program.sourceType !== "module" || /\.(?:cjs|cts)$/u.test(path)) {
    facts.unsupportedExports.push({ kind: "module-format", start: 0, end: 0 });
  }
  return facts;
}

export class OxcSourceDependencyParser implements SourceDependencyParser {
  parse(file: SourceFileSnapshot): ParsedSourceDependencies {
    const parsed = parseSync(file.path, file.source, { astType: "ts" });
    if (parsed.errors.length > 0) {
      return {
        parseErrorCount: parsed.errors.length,
        references: [],
        unresolved: [],
        runtimeExports: [],
        unsupportedExports: []
      };
    }

    const bindings = new LoaderBindingAnalysis(parsed.program, file.path);
    const references: SourceDependencyReference[] = [];
    const unresolvedReferences: UnresolvedSourceDependency[] = [];
    const addReference = (
      kind: SourceDependencyKind,
      literal: { readonly value: unknown; readonly start: number; readonly end: number }
    ) => {
      const candidate = reference(kind, literal);
      if (candidate !== undefined) {
        references.push(candidate);
      }
    };
    new Visitor({
      CallExpression(node) {
        const loaders = bindings.callOrigins(node).filter((origin) =>
          origin.kind === "loader" || origin.kind === "builtin-getter");
        if (loaders.length === 0) {
          return;
        }
        const argument = node.arguments[0];
        if (
          loaders.every((origin) => origin.opaque !== true) &&
          argument?.type === "Literal" &&
          typeof argument.value === "string" &&
          (loaders.every((origin) => origin.kind !== "builtin-getter") || isBuiltin(argument.value))
        ) {
          addReference("commonjs", argument);
        } else {
          unresolvedReferences.push(unresolved("commonjs", node));
        }
      },
      ExportAllDeclaration(node) {
        addReference(
          node.exportKind === "type" ? "export-type" : "export",
          node.source
        );
      },
      ExportNamedDeclaration(node) {
        if (node.source === null) {
          return;
        }
        const typeOnly =
          node.exportKind === "type" ||
          (node.specifiers.length > 0 &&
            node.specifiers.every((specifier) => specifier.exportKind === "type"));
        addReference(typeOnly ? "export-type" : "export", node.source);
      },
      ImportDeclaration(node) {
        const typeOnly =
          node.importKind === "type" ||
          (node.specifiers.length > 0 &&
            node.specifiers.every(
              (specifier) =>
                specifier.type === "ImportSpecifier" &&
                specifier.importKind === "type"
            ));
        addReference(typeOnly ? "static-type" : "static", node.source);
      },
      ImportExpression(node) {
        if (node.source.type === "Literal" && typeof node.source.value === "string") {
          addReference("dynamic", node.source);
        } else {
          unresolvedReferences.push(unresolved("dynamic", node));
        }
      },
      TSImportEqualsDeclaration(node) {
        if (node.moduleReference.type !== "TSExternalModuleReference") {
          return;
        }
        const expression = node.moduleReference.expression;
        if (typeof expression.value === "string") {
          addReference(
            node.importKind === "type" ? "import-equals-type" : "import-equals",
            expression
          );
        }
      },
      TSImportType(node) {
        if (typeof node.source.value === "string") {
          addReference("type-query", node.source);
        } else {
          unresolvedReferences.push(unresolved("type-query", node));
        }
      }
    }).visit(parsed.program);
    return {
      parseErrorCount: 0,
      ...observeRuntimeExports(parsed, file.path),
      references: references.toSorted(
        (left, right) =>
          left.start - right.start ||
          compareBinaryStrings(left.kind, right.kind) ||
          compareBinaryStrings(left.specifier, right.specifier)
      ),
      unresolved: unresolvedReferences.toSorted(
        (left, right) =>
          left.start - right.start || compareBinaryStrings(left.kind, right.kind)
      )
    };
  }
}
