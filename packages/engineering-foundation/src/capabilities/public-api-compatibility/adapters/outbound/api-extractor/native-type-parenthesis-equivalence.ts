import { dirname, join } from "node:path";
import { API } from "typescript/unstable/sync";
import * as ast from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import type { PublicApiSignatureEquivalence } from "../../../application/ports/public-api-signature-equivalence.js";
import type { PublicApiItem } from "../../../application/model/public-api.js";
import {
  assertPinnedAuditSdk,
  nativeCompilerPath,
  NATIVE_EXTRACTOR_VERSION,
} from "./load-pinned-audit-sdk.js";

const MAX_SIGNATURE_CHARACTERS = 10_000;
const MAX_NODES = 20_000;
const MAX_DEPTH = 128;
interface SyntaxProof {
  readonly shape: string;
  readonly tokens: readonly (readonly [ast.SyntaxKind, string])[];
  readonly parentheses: number;
}

function declarationSyntax(source: ast.SourceFile): SyntaxProof | undefined {
  const declaration = source.statements[0];
  if (
    source.statements.length !== 1 ||
    declaration === undefined ||
    !(
      ast.isTypeAliasDeclaration(declaration) ||
      (ast.isInterfaceDeclaration(declaration) &&
        declaration.members.length === 1 &&
        declaration.members[0] !== undefined &&
        declaration.members[0].kind === ast.SyntaxKind.PropertySignature)
    )
  ) {
    return;
  }
  let nodes = 0;
  const parentheses = new Set<number>();
  const shape = (node: ast.Node, depth: number): string | undefined => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) {
      return;
    }
    if (ast.isParenthesizedTypeNode(node)) {
      const start = node.getStart(),
        end = node.end - 1;
      if (source.text[start] !== "(" || source.text[end] !== ")") {
        return;
      }
      parentheses.add(start);
      parentheses.add(end);
      return shape(node.type, depth + 1);
    }
    const children: (string | undefined)[] = [];
    node.forEachChild((child) => {
      children.push(shape(child, depth + 1));
    });
    return children.includes(undefined) ? undefined : `${node.kind}[${children.join(",")}]`;
  };
  const structural = shape(declaration, 0);
  if (structural === undefined) {
    return;
  }
  const scanner = ast.createScanner(true, ast.LanguageVariant.Standard, source.text);
  const tokens: [ast.SyntaxKind, string][] = [];
  // Syntax diagnostics already validated the declaration. Template and regexp
  // rescanning would need more context; these forms deliberately receive no proof.
  for (let kind = scanner.scan(); kind !== ast.SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (
      tokens.length >= MAX_NODES ||
      kind === ast.SyntaxKind.TemplateHead ||
      kind === ast.SyntaxKind.SlashToken ||
      kind === ast.SyntaxKind.SlashEqualsToken
    ) {
      return;
    }
    if (!parentheses.has(scanner.getTokenStart())) {
      tokens.push([kind, scanner.getTokenText()]);
    } else if (kind !== ast.SyntaxKind.OpenParenToken && kind !== ast.SyntaxKind.CloseParenToken) {
      return;
    }
  }
  return { shape: structural, tokens, parentheses: parentheses.size / 2 };
}

/** Canonicalize only native-decoded string literal spelling; preserve every other byte. */
function literalQuoteSpelling(source: ast.SourceFile): string | undefined {
  let nodes = 0;
  let cursor = 0;
  const parts: string[] = [];
  let valid = true;
  const visit = (node: ast.Node, depth: number): void => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) {
      valid = false;
      return;
    }
    if (ast.isStringLiteral(node)) {
      const start = node.getStart();
      if (start < cursor || (source.text[start] !== "'" && source.text[start] !== '"')) {
        valid = false;
        return;
      }
      parts.push(source.text.slice(cursor, start), JSON.stringify(node.text));
      cursor = node.end;
      return;
    }
    node.forEachChild((child) => {
      visit(child, depth + 1);
    });
  };
  visit(source, 0);
  return valid ? parts.join("") + source.text.slice(cursor) : undefined;
}

function prove(released: string, current: string, allowParentheses: boolean = true): boolean {
  assertPinnedAuditSdk();
  const root = join(dirname(nativeCompilerPath), ".foundation-signature-comparison");
  const configPath = join(root, "tsconfig.json");
  const beforePath = join(root, "before.d.ts"),
    afterPath = join(root, "after.d.ts");
  const virtual = createVirtualFileSystem({
    [configPath]: JSON.stringify({
      compilerOptions: { noLib: true, noResolve: true, types: [], noEmit: true },
      files: ["before.d.ts", "after.d.ts"],
    }),
    [beforePath]: released,
    [afterPath]: current,
  });
  const read = virtual.readFile,
    entries = virtual.getAccessibleEntries;
  if (read === undefined || entries === undefined) {
    return false;
  }
  // Missing virtual input must not fall back to the host filesystem.
  virtual.readFile = (path) => read(path) ?? null;
  virtual.getAccessibleEntries = (path) => entries(path) ?? { files: [], directories: [] };
  const api = new API({ cwd: root, tsserverPath: nativeCompilerPath, fs: virtual });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [configPath] });
    try {
      const program = snapshot.getProject(configPath)?.program;
      if (
        program === undefined ||
        program.getConfigFileParsingDiagnostics().length !== 0 ||
        program.getSyntacticDiagnostics().length !== 0
      ) {
        return false;
      }
      const before = program.getSourceFile(beforePath),
        after = program.getSourceFile(afterPath);
      if (before === undefined || after === undefined) {
        return false;
      }
      const beforeQuotes = literalQuoteSpelling(before);
      const afterQuotes = literalQuoteSpelling(after);
      if (beforeQuotes !== undefined && afterQuotes !== undefined && beforeQuotes === afterQuotes) {
        return true;
      }
      if (!allowParentheses) {
        return false;
      }
      const left = declarationSyntax(before),
        right = declarationSyntax(after);
      return (
        left !== undefined &&
        right !== undefined &&
        (left.parentheses > 0 || right.parentheses > 0) &&
        left.shape === right.shape &&
        JSON.stringify(left.tokens) === JSON.stringify(right.tokens)
      );
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

/** One bounded native session per differing alias pair, owned and closed by
 * this call. Raw excerpts and their evidence/fingerprint bytes are never edited. */
export function createNativeTypeParenthesisEquivalence(): PublicApiSignatureEquivalence {
  return {
    equivalent: (released: PublicApiItem, current: PublicApiItem, extractorVersions): boolean => {
      if (
        extractorVersions.released !== NATIVE_EXTRACTOR_VERSION ||
        extractorVersions.current !== NATIVE_EXTRACTOR_VERSION ||
        (released.kind !== "TypeAlias" &&
          released.kind !== "PropertySignature" &&
          released.kind !== "Variable" &&
          released.kind !== "Function") ||
        current.kind !== released.kind ||
        released.canonicalReference !== current.canonicalReference ||
        released.parentKind !== current.parentKind ||
        released.parentReference !== current.parentReference ||
        released.signature.length > MAX_SIGNATURE_CHARACTERS ||
        current.signature.length > MAX_SIGNATURE_CHARACTERS
      ) {
        return false;
      }
      try {
        return released.kind === "PropertySignature"
          ? prove(
              `interface SignatureProof { ${released.signature} }`,
              `interface SignatureProof { ${current.signature} }`,
            )
          : prove(released.signature, current.signature, released.kind === "TypeAlias");
      } catch {
        // Invalid/unsupported syntax, SDK or cleanup failures provide no proof.
        return false;
      }
    },
  };
}
