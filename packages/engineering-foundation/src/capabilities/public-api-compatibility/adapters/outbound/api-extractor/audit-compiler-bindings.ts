import { resolve } from "node:path";
import { isExternalModuleReference, isIdentifier, isImportClause, isImportDeclaration, isImportEqualsDeclaration,
  isImportSpecifier, isImportTypeNode, isLiteralTypeNode, isNamespaceImport, isQualifiedName, isPropertyAccessExpression,
  isExportDeclaration, isGetAccessorDeclaration, isSetAccessorDeclaration, isStringLiteralLikeNode, SyntaxKind, type Node } from "typescript/unstable/ast";
import type { Checker, Program, Project } from "typescript/unstable/sync";
import type { AuditDeclaration, AuditReference } from "../../../application/model/public-api-observation.js";
import type { AuditDeclarationInput } from "../../../contract/public-api-audit.js";

interface BindingContext {
  readonly program: Program;
  readonly checker: Checker;
  readonly project: Project;
  readonly root: string;
  readonly declarations: AuditDeclarationInput;
}

function moduleBinding(node: Node, context: BindingContext): string | undefined {
  if (!isStringLiteralLikeNode(node) || node.text.startsWith(".")) { return; }
  const entry = context.declarations.resolutionUniverse.find(candidate =>
    `${candidate.packageName}${candidate.exportPath === "." ? "" : candidate.exportPath.slice(1)}` === node.text);
  const symbol = context.checker.getSymbolAtLocation(node);
  if (symbol === undefined) { return; } // Independent diagnostics retain unresolved imports.
  const declaration = symbol.declarations.length === 1 ? symbol.declarations[0]?.resolve(context.project) : undefined;
  if (entry === undefined || declaration === undefined ||
      resolve(declaration.getSourceFile().fileName) !== resolve(context.root, entry.declarationPath)) {
    throw new Error("Module binding is outside the explicit same-subject universe.");
  }
  return JSON.stringify([entry.packageName, entry.exportPath]);
}

function importLiteral(node: Node): Node | undefined {
  if (isImportTypeNode(node) && isLiteralTypeNode(node.argument)) { return node.argument.literal; }
  if (isExternalModuleReference(node)) { return node.expression; }
  if (isImportDeclaration(node) || isExportDeclaration(node)) { return node.moduleSpecifier; }
  if (isImportEqualsDeclaration(node) && isExternalModuleReference(node.moduleReference)) { return node.moduleReference.expression; }
  return;
}

function importedQualifier(node: Node): Node | undefined {
  if (!isQualifiedName(node) && !isPropertyAccessExpression(node)) { return; }
  let qualifier: Node = isQualifiedName(node) ? node.left : node.expression;
  while (isQualifiedName(qualifier) || isPropertyAccessExpression(qualifier)) { qualifier = isQualifiedName(qualifier) ? qualifier.left : qualifier.expression; }
  return qualifier;
}

function occurrenceBinding(node: Node, context: BindingContext): string | undefined {
  // An inline import owns this occurrence; an unrelated named import cannot lend authority.
  let cursor: Node | undefined = node.parent;
  while (cursor !== undefined && (isQualifiedName(cursor) || isPropertyAccessExpression(cursor))) { cursor = cursor.parent; }
  if (cursor !== undefined && isImportTypeNode(cursor) && isLiteralTypeNode(cursor.argument)) {
    return moduleBinding(cursor.argument.literal, context);
  }
  const qualifier = importedQualifier(node);
  if (qualifier !== undefined) {
    // The leftmost name must be this occurrence's actual imported namespace or
    // named alias. A same-spelled import elsewhere cannot authorize this node.
    return occurrenceBinding(qualifier, context);
  }
  const symbol = context.checker.getSymbolAtLocation(node);
  if (symbol?.declarations.length !== 1) { return; }
  cursor = symbol.declarations[0]?.resolve(context.project);
  if (cursor === undefined || !(isImportSpecifier(cursor) || isNamespaceImport(cursor) || isImportClause(cursor) || isImportEqualsDeclaration(cursor))) { return; }
  while (cursor !== undefined) {
    const literal = importLiteral(cursor);
    if (literal !== undefined) { return moduleBinding(literal, context); }
    cursor = cursor.parent;
  }
  return;
}

function qualifiedText(qualifier: Node): string | undefined {
  if (isIdentifier(qualifier)) { return qualifier.text; }
  if (!isQualifiedName(qualifier) && !isPropertyAccessExpression(qualifier)) { return; }
  const left = qualifiedText(isQualifiedName(qualifier) ? qualifier.left : qualifier.expression);
  return left === undefined ? undefined : `${left}.${isQualifiedName(qualifier) ? qualifier.right.text : qualifier.name.text}`;
}

function bindingDeclarations(node: Node, context: BindingContext): readonly Node[] {
  if (!isGetAccessorDeclaration(node)) { return [node]; }
  const symbol = context.checker.getSymbolAtLocation(node.name);
  if (symbol === undefined) { return [node]; }
  const declarations: Node[] = [node];
  const isStatic = node.modifiers?.some(modifier => modifier.kind === SyntaxKind.StaticKeyword) === true;
  for (const handle of symbol.declarations) {
    const paired = handle.resolve(context.project);
    if (paired === undefined || !isSetAccessorDeclaration(paired) || paired.parent !== node.parent ||
        context.checker.getSymbolAtLocation(paired.name)?.id !== symbol.id ||
        (paired.modifiers?.some(modifier => modifier.kind === SyntaxKind.StaticKeyword) === true) !== isStatic) { continue; }
    declarations.push(paired);
  }
  if (declarations.length > 2) { throw new Error("Native property has multiple setter declarations."); }
  return declarations; // The model excerpt orders the getter before its own setter.
}

function declarationOccurrences(nodes: readonly Node[], context: BindingContext): ReadonlyMap<string, readonly string[]> {
  const occurrences = new Map<string, string[]>();
  function record(text: string, binding: string | undefined): void {
    if (binding === undefined) { return; }
    const values = occurrences.get(text) ?? [];
    values.push(binding);
    occurrences.set(text, values);
  }
  for (const node of nodes) {
    function visit(child: Node): void {
      // Each container member owns its own excerpt and cannot authorize its container.
      if (("members" in node && Array.isArray(node.members) && node.members.includes(child)) ||
          ("body" in node && child === node.body)) { return; }
      if (isQualifiedName(child) || isPropertyAccessExpression(child)) {
        const text = qualifiedText(child);
        if (text !== undefined) { record(text, occurrenceBinding(child, context)); }
        return; // The model owns one qualified token, not separate identifier edges.
      }
      if (isIdentifier(child)) { record(child.text, occurrenceBinding(child, context)); }
      child.forEachChild(visit);
    }
    node.forEachChild(visit);
  }
  return occurrences;
}

/** Preserve native declaration identity and each actual module-binding occurrence. */
export function bindAuditCompilerReferences(context: BindingContext & {
  readonly items: readonly AuditDeclaration[];
  readonly declarationBindings: ReadonlyMap<string, Node>;
  readonly bindings: Map<AuditReference, string>;
}): void {
  for (const path of context.program.getSourceFileNames()) {
    if (context.program.getSourceFileMetadata(path)?.isDefaultLibrary === true) { continue; }
    const source = context.program.getSourceFile(path);
    if (source === undefined) { throw new Error("Native compiler source is unavailable."); }
    const visit = (node: Node): void => {
      const literal = importLiteral(node);
      if (literal !== undefined) { moduleBinding(literal, context); }
      node.forEachChild(visit);
    };
    source.forEachChild(visit);
  }
  for (const item of context.items) {
    const unresolved = item.references.filter(reference => reference.resolution === "unresolved");
    if (unresolved.length === 0) { continue; }
    const declaration = context.declarationBindings.get(item.identity.canonicalReference);
    if (declaration === undefined) { continue; }
    const occurrences = declarationOccurrences(bindingDeclarations(declaration, context), context);
    for (const text of new Set(unresolved.map(reference => reference.text))) {
      const references = unresolved.filter(reference => reference.text === text);
      const actual = occurrences.get(text);
      if (actual?.length !== references.length) { continue; }
      references.forEach((reference, index) => { context.bindings.set(reference, actual[index]!); });
    }
  }
}
