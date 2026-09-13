import { dirname, relative, resolve, sep } from "node:path";
import type { AuditDeclaration, AuditReference } from "../../../application/model/public-api-observation.js";
import type { AuditDeclarationInput, AuditPackageInput } from "../../../contract/public-api-audit.js";
import type { AuditCompilerNode, AuditCompilerProgram, PinnedAuditCompiler } from "./pinned-audit-compiler.js";

interface BindingContext {
  readonly compiler: PinnedAuditCompiler;
  readonly program: AuditCompilerProgram;
  readonly root: string;
  readonly declarations: AuditDeclarationInput;
}

function moduleBinding(node: AuditCompilerNode, context: BindingContext): string | undefined {
  if (node.text === undefined || node.text.startsWith(".")) { return; }
  const entry = context.declarations.resolutionUniverse.find(candidate =>
    `${candidate.packageName}${candidate.exportPath === "." ? "" : candidate.exportPath.slice(1)}` === node.text);
  const symbol = context.program.getTypeChecker().getSymbolAtLocation(node);
  if (symbol === undefined) { return; } // Independent diagnostics retain unresolved imports.
  if (entry === undefined || symbol.declarations?.length !== 1 ||
      resolve(symbol.declarations[0]!.getSourceFile().fileName) !== resolve(context.root, entry.declarationPath)) {
    throw new Error("Module binding is outside the explicit same-subject universe.");
  }
  return JSON.stringify([entry.packageName, entry.exportPath]);
}

function importLiteral(node: AuditCompilerNode, compiler: PinnedAuditCompiler): AuditCompilerNode | undefined {
  if (node.kind === compiler.SyntaxKind["ImportType"]) { return node.argument?.literal; }
  if (node.kind === compiler.SyntaxKind["ExternalModuleReference"]) { return node.expression; }
  return node.moduleSpecifier;
}

function parents(node: AuditCompilerNode): readonly string[] {
  const names: string[] = [];
  let parent = node.parent;
  while (parent !== undefined) {
    if (parent.name?.text !== undefined) { names.unshift(parent.name.text); }
    parent = parent.parent;
  }
  return names;
}

function modelParents(item: AuditDeclaration, items: readonly AuditDeclaration[]): readonly string[] {
  const names: string[] = [];
  const visited = new Set<string>();
  let parent = items.find(candidate => candidate.identity.canonicalReference === item.parentReference);
  while (parent !== undefined && !visited.has(parent.identity.canonicalReference)) {
    visited.add(parent.identity.canonicalReference);
    names.unshift(parent.displayName);
    const next = parent.parentReference;
    parent = items.find(candidate => candidate.identity.canonicalReference === next);
  }
  return names;
}

function occurrenceBinding(node: AuditCompilerNode, context: BindingContext): string | undefined {
  // An inline import owns this qualifier occurrence, independently of named imports.
  let cursor: AuditCompilerNode | undefined = node.parent;
  while (cursor !== undefined && cursor.kind === context.compiler.SyntaxKind["QualifiedName"]) { cursor = cursor.parent; }
  if (cursor !== undefined && cursor.kind === context.compiler.SyntaxKind["ImportType"] && cursor.argument?.literal !== undefined) {
    return moduleBinding(cursor.argument.literal, context);
  }
  const symbol = context.program.getTypeChecker().getSymbolAtLocation(node);
  if (symbol?.declarations?.length !== 1) { return; }
  cursor = symbol.declarations[0];
  // Only this symbol's actual import alias can establish a named/namespace binding.
  if (!["ImportSpecifier", "NamespaceImport", "ImportClause", "ImportEqualsDeclaration"].some(kind => cursor?.kind === context.compiler.SyntaxKind[kind])) { return; }
  while (cursor !== undefined) {
    const literal = importLiteral(cursor, context.compiler) ?? cursor.moduleReference?.expression;
    if (literal !== undefined) { return moduleBinding(literal, context); }
    cursor = cursor.parent;
  }
  return;
}

function declarationOccurrences(node: AuditCompilerNode, context: BindingContext): ReadonlyMap<string, readonly string[]> {
  const occurrences = new Map<string, string[]>();
  function visit(child: AuditCompilerNode): void {
    // Container members have their own modeled excerpts and cannot authorize the container.
    if (node.members?.includes(child) === true || child === node.body) { return; }
    if (child.kind === context.compiler.SyntaxKind["Identifier"] && child.text !== undefined) {
      const binding = occurrenceBinding(child, context);
      if (binding !== undefined) {
        const values = occurrences.get(child.text) ?? [];
        values.push(binding);
        occurrences.set(child.text, values);
      }
    }
    context.compiler.forEachChild(child, visit);
  }
  context.compiler.forEachChild(node, visit);
  return occurrences;
}

/** Bind only occurrences inside the actual unique declaration, never observation-wide imports. */
export function bindAuditCompilerReferences(context: BindingContext & {
  readonly pkg: AuditPackageInput;
  readonly items: readonly AuditDeclaration[];
  readonly bindings: Map<AuditReference, string>;
}): void {
  const nodes: AuditCompilerNode[] = [];
  const packageRoot = resolve(context.root, dirname(context.pkg.manifestPath));
  for (const source of context.program.getSourceFiles()) {
    if (context.program.isSourceFileDefaultLibrary(source)) { continue; }
    const local = relative(packageRoot, source.fileName);
    const owned = local !== ".." && !local.startsWith(`..${sep}`);
    const visit = (node: AuditCompilerNode): void => {
      const literal = importLiteral(node, context.compiler);
      if (literal !== undefined) { moduleBinding(literal, context); }
      if (owned && node.name?.text !== undefined) { nodes.push(node); }
      context.compiler.forEachChild(node, visit);
    };
    context.compiler.forEachChild(source, visit);
  }
  for (const item of context.items) {
    const unresolved = item.references.filter(reference => reference.resolution === "unresolved");
    if (unresolved.length === 0) { continue; }
    const ancestors = JSON.stringify(modelParents(item, context.items));
    const candidates = nodes.filter(node => node.name?.text === item.displayName && JSON.stringify(parents(node)) === ancestors);
    if (candidates.length !== 1) { continue; }
    const occurrences = declarationOccurrences(candidates[0]!, context);
    for (const text of new Set(unresolved.map(reference => reference.text))) {
      const references = unresolved.filter(reference => reference.text === text);
      const actual = occurrences.get(text);
      if (actual?.length !== references.length) { continue; }
      references.forEach((reference, index) => { context.bindings.set(reference, actual[index]!); });
    }
  }
}
