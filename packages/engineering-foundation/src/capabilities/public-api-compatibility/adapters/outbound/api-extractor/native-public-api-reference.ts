import { dirname, resolve } from "node:path";
import * as ast from "typescript/unstable/ast";
import { SymbolFlags, type Symbol as NativeSymbol } from "typescript/unstable/sync";
import { Meaning } from "@microsoft/tsdoc/lib-commonjs/beta/DeclarationReference.js";
import { createNativeExternalReference } from "./native-public-api-item.js";
import type { NativePublicApiContext } from "./native-public-api-engine.js";
import { nativeParent, type NativeDeclaration } from "./native-public-api-excerpt.js";

export interface NativeReferenceOccurrence { readonly node: ast.Node; readonly symbol: NativeSymbol; readonly start: number; readonly end: number }
interface Component { readonly node: NativeDeclaration; readonly name: string }
type Report = (id: string, text: string, node?: ast.Node) => void;
export function aliased(context: NativePublicApiContext, symbol: NativeSymbol): NativeSymbol {
  return (symbol.flags & SymbolFlags.Alias) !== 0 ? context.checker.getAliasedSymbol(symbol) : symbol;
}
export function symbolDeclarations(symbol: NativeSymbol): ast.Node[] {
  return symbol.declarations.map(handle => handle.resolve()).filter((node): node is ast.Node => node !== undefined);
}
const declarationMeanings: Readonly<Partial<Record<ast.SyntaxKind, Meaning>>> = {
  [ast.SyntaxKind.InterfaceDeclaration]: Meaning.Interface,
  [ast.SyntaxKind.TypeAliasDeclaration]: Meaning.TypeAlias,
  [ast.SyntaxKind.ClassDeclaration]: Meaning.Class,
  [ast.SyntaxKind.EnumDeclaration]: Meaning.Enum,
  [ast.SyntaxKind.EnumMember]: Meaning.Member,
  [ast.SyntaxKind.ModuleDeclaration]: Meaning.Namespace,
  [ast.SyntaxKind.SourceFile]: Meaning.Namespace,
  [ast.SyntaxKind.FunctionDeclaration]: Meaning.Function,
  [ast.SyntaxKind.VariableDeclaration]: Meaning.Variable,
  [ast.SyntaxKind.MethodDeclaration]: Meaning.Member,
  [ast.SyntaxKind.MethodSignature]: Meaning.Member,
  [ast.SyntaxKind.PropertyDeclaration]: Meaning.Member,
  [ast.SyntaxKind.PropertySignature]: Meaning.Member,
  [ast.SyntaxKind.GetAccessor]: Meaning.Member,
  [ast.SyntaxKind.SetAccessor]: Meaning.Member,
};
function typeMeaning(node: ast.Node): Meaning | undefined { return declarationMeanings[node.kind]; }
export function symbolRoot(context: NativePublicApiContext, symbol: NativeSymbol): NativeSymbol {
  let current = symbol;
  const visited = new Set<number>();
  while (!visited.has(current.id)) {
    visited.add(current.id);
    const parent = current.getParent();
    if (parent === undefined || symbolDeclarations(parent).some(ast.isSourceFile)) { break; }
    if (!symbolDeclarations(parent).some(node => typeMeaning(node) !== undefined)) { break; }
    current = aliased(context, parent);
  }
  return current;
}
export function uniqueSymbol(symbol: NativeSymbol): boolean {
  const declarations = symbolDeclarations(symbol);
  if (declarations.length !== 1 || !ast.isVariableDeclaration(declarations[0]!)) { return false; }
  const type = declarations[0].type;
  return type !== undefined && ast.isTypeOperatorNode(type) && type.operator === ast.SyntaxKind.UniqueKeyword && type.type.kind === ast.SyntaxKind.SymbolKeyword;
}
export function packageNameFor(context: NativePublicApiContext, node: ast.Node): string | undefined {
  let directory = dirname(node.getSourceFile().fileName);
  while (directory !== dirname(directory)) {
    const bytes = context.files.get(resolve(directory, "package.json").replaceAll("\\", "/"));
    if (bytes !== undefined) {
      const manifest = JSON.parse(bytes) as { readonly name?: unknown };
      if (typeof manifest.name === "string") { return manifest.name; }
    }
    directory = dirname(directory);
  }
  return undefined;
}
export function references(context: NativePublicApiContext, node: ast.Node, report: Report): NativeReferenceOccurrence[] {
  if (ast.isSourceFile(node) || ast.isModuleDeclaration(node)) { return []; }
  const limit = ast.isClassDeclaration(node) || ast.isInterfaceDeclaration(node) || ast.isEnumDeclaration(node) ? node.members.pos : node.end;
  const result: NativeReferenceOccurrence[] = [];
  const visit = (child: ast.Node): void => {
    if (child.getStart() >= limit) { return; }
    if (ast.isImportTypeNode(child) && child.qualifier === undefined) {
      report("native-whole-module-import-reference", "A whole-module import type requires an explicit native reference projection.", child); return;
    }
    if (ast.isQualifiedName(child) || ast.isPropertyAccessExpression(child)) {
      const symbol = context.checker.getSymbolAtLocation(ast.isQualifiedName(child) ? child.right : child.name);
      if (symbol !== undefined) { result.push({ node: child, symbol: aliased(context, symbol), start: child.getStart(), end: child.end }); }
      return;
    }
    if (ast.isIdentifier(child)) {
      const parent = child.parent as NativeDeclaration;
      if (parent.name === child || ast.isTypeParameterDeclaration(parent)) { return; }
      const found = context.checker.getSymbolAtLocation(child);
      if (found !== undefined) {
        const symbol = aliased(context, found);
        if ((symbol.flags & SymbolFlags.TypeParameter) === 0 && symbolDeclarations(symbol).some(declaration => typeMeaning(declaration) !== undefined)) {
          result.push({ node: child, symbol, start: child.getStart(), end: child.end });
        }
      }
    }
    child.forEachChild(visit);
  };
  node.forEachChild(visit);
  return result.toSorted((left, right) => left.start - right.start);
}
function qualifiedNames(node: ast.Node): string[] {
  if (ast.isIdentifier(node)) { return [node.text]; }
  if (ast.isQualifiedName(node)) { return [...qualifiedNames(node.left), node.right.text]; }
  if (ast.isPropertyAccessExpression(node)) { return [...qualifiedNames(node.expression), node.name.text]; }
  return [];
}
function importNames(declaration: ast.Node, names: readonly string[]): readonly string[] {
  if (ast.isImportSpecifier(declaration)) { return [declaration.propertyName?.text ?? declaration.name.text, ...names.slice(1)]; }
  return ast.isImportClause(declaration) ? ["default", ...names.slice(1)] : names.slice(1);
}
function importSpecifier(node: ast.Node): ast.Node | undefined {
  if (ast.isImportDeclaration(node)) { return node.moduleSpecifier; }
  return ast.isImportEqualsDeclaration(node) && ast.isExternalModuleReference(node.moduleReference) ? node.moduleReference.expression : undefined;
}
function importBinding(node: ast.Node): boolean {
  return ast.isImportSpecifier(node) || ast.isNamespaceImport(node) || ast.isImportClause(node) || ast.isImportEqualsDeclaration(node);
}
function occurrenceModule(context: NativePublicApiContext, node: ast.Node): { readonly symbol: NativeSymbol; readonly preferred: readonly string[] } | undefined {
  let cursor = node;
  while (ast.isQualifiedName(cursor) || ast.isPropertyAccessExpression(cursor)) { cursor = ast.isQualifiedName(cursor) ? cursor.left : cursor.expression; }
  const names = qualifiedNames(node);
  let enclosing = nativeParent(node);
  while (enclosing !== undefined && ast.isQualifiedName(enclosing)) { enclosing = nativeParent(enclosing); }
  if (enclosing !== undefined && ast.isImportTypeNode(enclosing) && ast.isLiteralTypeNode(enclosing.argument)) {
    const symbol = context.checker.getSymbolAtLocation(enclosing.argument.literal);
    return symbol === undefined ? undefined : { symbol, preferred: names };
  }
  const imported = context.checker.getSymbolAtLocation(cursor);
  const declaration = imported?.declarations.length === 1 ? imported.declarations[0]?.resolve() : undefined;
  if (declaration === undefined || !importBinding(declaration)) { return; }
  const preferred = importNames(declaration, names);
  let ancestor: ast.Node | undefined = declaration;
  while (ancestor !== undefined) {
    const literal = importSpecifier(ancestor);
    if (literal !== undefined) {
      const symbol = context.checker.getSymbolAtLocation(literal);
      return symbol === undefined ? undefined : { symbol, preferred };
    }
    ancestor = nativeParent(ancestor);
  }
  return;
}
function namespaceSymbol(symbol: NativeSymbol): boolean {
  return symbolDeclarations(symbol).some(node => ast.isSourceFile(node) || ast.isModuleDeclaration(node));
}
function exportedRoot(context: NativePublicApiContext, module: NativeSymbol, target: NativeSymbol, preferred: readonly string[]): Component[] | undefined {
  let visited = 0;
  const search = (owner: NativeSymbol, ancestors: ReadonlySet<number>): Component[][] => {
    if (++visited > 20_000 || ancestors.size > 128) { throw new Error("Native external export graph budget exhausted."); }
    if (ancestors.has(owner.id)) { return []; }
    const next = new Set(ancestors); next.add(owner.id);
    return context.checker.getExportsOfModule(owner).flatMap(exported => {
      const actual = aliased(context, exported);
      const node = symbolDeclarations(actual)[0];
      if (node === undefined) { return []; }
      const component = { node: node as NativeDeclaration, name: exported.name };
      if (actual.id === target.id) { return [[component]]; }
      return namespaceSymbol(actual) ? search(actual, next).map(path => [component, ...path]) : [];
    });
  };
  const paths = search(module, new Set());
  const exact = paths.filter(path => path.every((component, index) => component.name === preferred[index]));
  return exact.length === 1 ? exact[0] : paths.length === 1 ? paths[0] : undefined;
}
function symbolComponent(symbol: NativeSymbol, report: Report): Component | undefined {
  const nodes = symbolDeclarations(symbol);
  const callable = nodes.filter(node => ast.isFunctionDeclaration(node) || ast.isMethodDeclaration(node) || node.kind === ast.SyntaxKind.MethodSignature);
  if (callable.length > 1) { report("native-external-overload-reference", `External callable ${symbol.name} has multiple declaration identities; a unique target cannot be proven.`, nodes[0]); return; }
  const node = nodes[0];
  if (node === undefined) { return; }
  return { name: symbol.name, node };
}

/** Resolve export aliases through actual native module exports before asking the
 * official model constructors to own the canonical declaration identity. */
export function externalReference(context: NativePublicApiContext, occurrence: NativeReferenceOccurrence, currentPackage: string, report: Report): string | undefined {
  const { symbol } = occurrence;
  const declaration = symbolDeclarations(symbol)[0];
  if (declaration === undefined || typeMeaning(declaration) === undefined) { return; }
  const library = context.program.isSourceFileDefaultLibrary(declaration.getSourceFile());
  const imported = library ? undefined : occurrenceModule(context, occurrence.node);
  const importedDeclaration = imported === undefined ? undefined : symbolDeclarations(imported.symbol)[0];
  const packageName = library ? undefined : packageNameFor(context, importedDeclaration ?? declaration);
  if (!library && (packageName === undefined || packageName === currentPackage)) { return; }
  const chain: NativeSymbol[] = [symbol];
  let parent = symbol.getParent();
  while (parent !== undefined && symbolDeclarations(parent).some(node => !ast.isSourceFile(node) && typeMeaning(node) !== undefined)) { chain.unshift(parent); parent = parent.getParent(); }
  const components = chain.map(item => symbolComponent(item, report));
  if (components.some(item => item === undefined)) { return; }
  const actual = components as Component[];
  if (!library) {
    const module = imported?.symbol ?? context.checker.getSymbolAtLocation(declaration.getSourceFile());
    const root = module === undefined ? undefined : exportedRoot(context, module, chain[0]!, imported?.preferred ?? []);
    if (root === undefined) { report("native-external-export-reference", `Cannot prove a unique exported identity for external symbol ${symbol.name}.`, occurrence.node); return; }
    actual.splice(0, 1, ...root);
  }
  return createNativeExternalReference(context, packageName, actual);
}
