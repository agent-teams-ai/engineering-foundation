import { parseSync, Visitor } from "oxc-parser";

import type {
  ParsedSourceDependencies,
  SourceDependencyKind,
  SourceDependencyReference,
  SourceFileSnapshot,
  UnresolvedSourceDependency
} from "../../../application/model/source-workspace.js";
import type { SourceDependencyParser } from "../../../application/ports/source-dependency-parser.js";

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

export class OxcSourceDependencyParser implements SourceDependencyParser {
  parse(file: SourceFileSnapshot): ParsedSourceDependencies {
    const parsed = parseSync(file.path, file.source, { astType: "ts" });
    if (parsed.errors.length > 0) {
      return {
        parseErrorCount: parsed.errors.length,
        references: [],
        unresolved: []
      };
    }

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
    const visitor = new Visitor({
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || node.callee.name !== "require") {
          return;
        }
        const argument = node.arguments[0];
        if (argument?.type === "Literal" && typeof argument.value === "string") {
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
    });
    visitor.visit(parsed.program);
    return {
      parseErrorCount: 0,
      references: references.toSorted(
        (left, right) =>
          left.start - right.start ||
          left.kind.localeCompare(right.kind) ||
          left.specifier.localeCompare(right.specifier)
      ),
      unresolved: unresolvedReferences.toSorted(
        (left, right) => left.start - right.start || left.kind.localeCompare(right.kind)
      )
    };
  }
}
