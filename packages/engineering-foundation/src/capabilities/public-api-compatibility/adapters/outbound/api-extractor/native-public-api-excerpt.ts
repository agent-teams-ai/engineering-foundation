import * as ast from "typescript/unstable/ast";
import { ExcerptTokenKind, type IExcerptToken, type IExcerptTokenRange } from "@microsoft/api-extractor-model";
import type { NativePublicApiContext } from "./native-public-api-engine.js";

export type NativeDeclaration = ast.Node & { readonly name?: ast.DeclarationName; readonly modifiers?: readonly ast.Node[]; readonly type?: ast.TypeNode;
  readonly parameters?: readonly ast.ParameterDeclaration[]; readonly typeParameters?: readonly ast.TypeParameterDeclaration[];
  readonly members?: readonly ast.Node[]; readonly heritageClauses?: readonly ast.HeritageClause[]; readonly initializer?: ast.Expression;
  readonly questionToken?: ast.Node; readonly body?: ast.Node };
export interface NativeExcerpt {
  readonly tokens: IExcerptToken[];
  readonly range: (node: ast.Node | undefined) => IExcerptTokenRange;
}
export interface NativeExcerptReference { readonly start: number; readonly end: number; readonly canonicalReference: string }
interface PrintedToken { readonly kind: ast.SyntaxKind; readonly text: string; readonly start: number; readonly end: number }
interface OffsetRange { readonly start: number; readonly end: number }
interface PrintedDeclaration {
  readonly text: string;
  readonly original: readonly PrintedToken[];
  readonly positions: ReadonlyMap<number, OffsetRange>;
}

/** Native root nodes have no parent at runtime despite Node.parent's annotation. */
export function nativeParent(node: ast.Node): ast.Node | undefined { return node.parent; }

/** AST traversal is synchronous; collect children before awaiting compiler queries. */
export function nativeChildren(node: ast.Node): readonly ast.Node[] {
  const children: ast.Node[] = [];
  node.forEachChild(child => { children.push(child); });
  return children;
}

export function nativeHasModifier(node: NativeDeclaration, kind: ast.SyntaxKind): boolean {
  return node.modifiers?.some(modifier => modifier.kind === kind) === true;
}
export async function nativeAccessorPair(context: NativePublicApiContext, node: NativeDeclaration, name: string): Promise<NativeDeclaration | undefined> {
  if (!ast.isGetAccessorDeclaration(node) && !ast.isSetAccessorDeclaration(node)) { return; }
  const opposite = ast.isGetAccessorDeclaration(node) ? ast.isSetAccessorDeclaration : ast.isGetAccessorDeclaration;
  for (const item of (node.parent as NativeDeclaration).members ?? []) {
    if (opposite(item) && await context.emitter.printNode(item.name) === name && nativeHasModifier(item, ast.SyntaxKind.StaticKeyword) === nativeHasModifier(node, ast.SyntaxKind.StaticKeyword)) { return item; }
  }
  return;
}
export function nativeSignatureNode(node: NativeDeclaration): NativeDeclaration {
  return ast.isVariableDeclaration(node) && node.type !== undefined && ast.isFunctionTypeNode(node.type) ? node.type : node;
}
function tokens(text: string): PrintedToken[] {
  const scanner = ast.createScanner(true, ast.LanguageVariant.Standard, text);
  const result: PrintedToken[] = [];
  const templates: number[] = [];
  let braces = 0;
  for (let kind = scanner.scan(); kind !== ast.SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (kind === ast.SyntaxKind.TemplateHead) { templates.push(braces); }
    else if (kind === ast.SyntaxKind.OpenBraceToken) { braces++; }
    else if (kind === ast.SyntaxKind.CloseBraceToken && templates.at(-1) === braces) {
      kind = scanner.reScanTemplateToken(false);
      if (kind === ast.SyntaxKind.TemplateTail) { templates.pop(); }
    } else if (kind === ast.SyntaxKind.CloseBraceToken) { braces--; }
    result.push({ kind, text: scanner.getTokenText(), start: scanner.getTokenStart(), end: scanner.getTokenEnd() });
  }
  return result;
}
function removableModifier(kind: ast.SyntaxKind): boolean {
  return [ast.SyntaxKind.ExportKeyword, ast.SyntaxKind.DeclareKeyword, ast.SyntaxKind.DefaultKeyword,
    ast.SyntaxKind.ConstKeyword, ast.SyntaxKind.LetKeyword, ast.SyntaxKind.VarKeyword].includes(kind);
}
function bodyBoundary(node: ast.Node, original: readonly PrintedToken[]): PrintedToken | undefined {
  if (!ast.isClassDeclaration(node) && !ast.isInterfaceDeclaration(node) && !ast.isEnumDeclaration(node)) { return; }
  return original.findLast(token => token.kind === ast.SyntaxKind.OpenBraceToken && node.getStart() + token.start < node.members.pos);
}
function mapPrintedTokens(node: ast.Node, printed: string, original: readonly PrintedToken[], name: string): Map<number, OffsetRange> {
  const output = tokens(printed);
  const body = bodyBoundary(node, original);
  const positions = new Map<number, OffsetRange>();
  let sourceIndex = 0;
  for (let outputIndex = 0; outputIndex < output.length && sourceIndex < original.length;) {
    const before = original[sourceIndex]!; const after = output[outputIndex]!;
    if (before.kind === after.kind && before.text === after.text) {
      positions.set(node.getStart() + before.start, { start: after.start, end: after.end }); sourceIndex++; outputIndex++;
      if (before === body) { break; }
    } else if (removableModifier(before.kind)) { sourceIndex++; }
    else if (removableModifier(after.kind) || after.kind === ast.SyntaxKind.SemicolonToken) { outputIndex++; }
    else { throw new Error(`Native excerpt token mapping failed for ${name}: ${before.text}/${after.text}.`); }
  }
  return positions;
}
async function printDeclaration(context: NativePublicApiContext, input: { readonly node: NativeDeclaration; readonly name: string; readonly exported: boolean }): Promise<PrintedDeclaration> {
  const { node } = input;
  let text = (await context.emitter.printNode(node)).replace(/^(?:(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*)(?:\s*))+/u, "").trim();
  const original = tokens(node.getText());
  const positions = mapPrintedTokens(node, text, original, input.name);
  const body = bodyBoundary(node, original);
  if (body !== undefined) {
    const position = positions.get(node.getStart() + body.start);
    if (position === undefined) { throw new Error("Native container header has no bound body boundary."); }
    text = text.slice(0, position.start).trimEnd();
  }
  if (ast.isVariableDeclaration(node) && !(node.type !== undefined && ast.isFunctionTypeNode(node.type))) {
    const statement = node.parent.parent as NativeDeclaration;
    const kind = (node.parent.flags & ast.NodeFlags.Const) !== 0 ? "const" : (node.parent.flags & ast.NodeFlags.Let) !== 0 ? "let" : "var";
    const prefix = `${input.exported ? "export " : ""}${nativeHasModifier(statement, ast.SyntaxKind.DeclareKeyword) ? "declare " : ""}${kind} `;
    text = `${prefix}${text};`;
    for (const [key, value] of positions) { positions.set(key, { start: value.start + prefix.length, end: value.end + prefix.length }); }
  }
  return { text, original, positions };
}
function offsetRange(node: ast.Node, declaration: PrintedDeclaration, start: number, end: number): OffsetRange | undefined {
  const within = declaration.original.filter(token => node.getStart() + token.start >= start && node.getStart() + token.end <= end);
  const first = within[0]; const last = within.at(-1);
  const mappedStart = first === undefined ? undefined : declaration.positions.get(node.getStart() + first.start);
  const mappedEnd = last === undefined ? undefined : declaration.positions.get(node.getStart() + last.start);
  if (mappedStart === undefined || mappedEnd === undefined || mappedEnd.end > declaration.text.length) { return; }
  return { start: mappedStart.start, end: mappedEnd.end };
}
function typeRanges(node: NativeDeclaration, declaration: PrintedDeclaration): ReadonlyMap<ast.Node, OffsetRange> {
  const signature = nativeSignatureNode(node);
  const nodes = [node.type, node.initializer, signature.type,
    ...(signature.parameters ?? []).map(parameter => parameter.type),
    ...(signature.typeParameters ?? []).flatMap(parameter => [parameter.constraint, parameter.defaultType]),
    ...(node.heritageClauses ?? []).flatMap(clause => [...clause.types])];
  const ranges = new Map<ast.Node, OffsetRange>();
  for (const child of nodes) {
    if (child === undefined) { continue; }
    const range = offsetRange(node, declaration, child.getStart(), child.end);
    if (range !== undefined) { ranges.set(child, range); }
  }
  return ranges;
}
function excerptTokens(text: string, references: readonly (OffsetRange & { canonicalReference: string })[], ranges: ReadonlyMap<ast.Node, OffsetRange>): {
  readonly tokens: IExcerptToken[]; readonly indexes: ReadonlyMap<number, number>;
} {
  const boundaries = [...new Set([0, text.length, ...references.flatMap(item => [item.start, item.end]), ...[...ranges.values()].flatMap(item => [item.start, item.end])])].toSorted((a, b) => a - b);
  const result: IExcerptToken[] = []; const indexes = new Map<number, number>();
  for (let index = 0; index < boundaries.length - 1; index++) {
    const start = boundaries[index]!; const end = boundaries[index + 1]!;
    indexes.set(start, result.length);
    const reference = references.find(item => item.start <= start && item.end >= end);
    result.push({ kind: reference === undefined ? ExcerptTokenKind.Content : ExcerptTokenKind.Reference, text: text.slice(start, end), ...(reference === undefined ? {} : { canonicalReference: reference.canonicalReference }) });
  }
  indexes.set(text.length, result.length);
  return { tokens: result, indexes };
}

/** Bind native source occurrences to native printed tokens. A failed lexical
 * correspondence rejects the observation instead of guessing a reference. */
export async function createNativeExcerpt(context: NativePublicApiContext, input: {
  readonly node: NativeDeclaration; readonly name: string; readonly exported: boolean;
}, references: readonly NativeExcerptReference[]): Promise<NativeExcerpt> {
  if (ast.isModuleDeclaration(input.node) || ast.isSourceFile(input.node)) { return { tokens: [], range: () => ({ startIndex: 0, endIndex: 0 }) }; }
  const declaration = await printDeclaration(context, input);
  const boundReferences = references.flatMap(reference => {
    const range = offsetRange(input.node, declaration, reference.start, reference.end);
    return range === undefined ? [] : [{ ...range, canonicalReference: reference.canonicalReference }];
  });
  const ranges = typeRanges(input.node, declaration);
  const result = excerptTokens(declaration.text, boundReferences, ranges);
  return { tokens: result.tokens, range: child => {
    const range = child === undefined ? undefined : ranges.get(child);
    return range === undefined ? { startIndex: 0, endIndex: 0 } : { startIndex: result.indexes.get(range.start)!, endIndex: result.indexes.get(range.end)! };
  } };
}

/** Accessor pairs have one official property identity while both declarations
 * remain observable in its signature and reference tokens. */
export function combineNativeExcerpts(excerpts: readonly NativeExcerpt[]): NativeExcerpt {
  const combined: IExcerptToken[] = [];
  const parts = excerpts.map(excerpt => {
    if (combined.length > 0) { combined.push({ kind: ExcerptTokenKind.Content, text: "\n" }); }
    const offset = combined.length;
    combined.push(...excerpt.tokens);
    return { excerpt, offset };
  });
  return { tokens: combined, range: node => {
    for (const { excerpt, offset } of parts) {
      const range = excerpt.range(node);
      if (range.endIndex > range.startIndex) { return { startIndex: range.startIndex + offset, endIndex: range.endIndex + offset }; }
    }
    return { startIndex: 0, endIndex: 0 };
  } };
}
