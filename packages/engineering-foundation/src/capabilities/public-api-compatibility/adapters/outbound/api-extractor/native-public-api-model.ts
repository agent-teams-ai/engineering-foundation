import * as ast from "typescript/unstable/ast";
import type { Symbol as NativeSymbol } from "typescript/unstable/async";
import * as model from "@microsoft/api-extractor-model";
import { TSDocConfiguration, TSDocParser } from "@microsoft/tsdoc";
import { createNativeApiItem } from "./native-public-api-item.js";
import { aliased, externalReference, packageNameFor, references, symbolDeclarations, symbolRoot, uniqueSymbol } from "./native-public-api-reference.js";
import { assertNotCancelled } from "../../../application/policies/public-api-evidence-errors.js";
import { nativeCompilerDiagnostics, type NativePublicApiContext, type NativePublicApiDiagnostic } from "./native-public-api-engine.js";
import { combineNativeExcerpts, createNativeExcerpt, nativeAccessorPair, nativeHasModifier as modifiers, type NativeDeclaration as NamedNode, type NativeExcerptReference } from "./native-public-api-excerpt.js";

type Container = model.ApiItem & model.ApiItemContainerMixin;
interface Descriptor {
  readonly node: NamedNode;
  readonly name: string;
  readonly symbol: NativeSymbol | undefined;
  readonly exported: boolean;
  readonly releaseTag: model.ReleaseTag;
  readonly docComment: ReturnType<TSDocParser["parseString"]>["docComment"] | undefined;
  readonly children: Descriptor[];
  readonly parent: Descriptor | undefined;
  readonly overloadIndex: number;
  canonicalReference: string;
}
function countOverload(siblings: readonly Descriptor[], node: ast.Node, name: string): number {
  return siblings.filter(item => item.node.kind === node.kind && item.name === name && modifiers(item.node, ast.SyntaxKind.StaticKeyword) === modifiers(node, ast.SyntaxKind.StaticKeyword)).length + 1;
}
async function setterWithGetter(context: NativePublicApiContext, node: ast.Node, name: string): Promise<boolean> {
  return ast.isSetAccessorDeclaration(node) && await nativeAccessorPair(context, node, name) !== undefined;
}
function hasDeclarationHeader(node: NamedNode): boolean {
  return (node.heritageClauses?.length ?? 0) > 0 || (node.typeParameters?.length ?? 0) > 0;
}
async function representedDeclarations(context: NativePublicApiContext, descriptor: Descriptor): Promise<readonly NamedNode[]> {
  const companion = ast.isGetAccessorDeclaration(descriptor.node) ? await nativeAccessorPair(context, descriptor.node, descriptor.name) : undefined;
  return companion === undefined ? [descriptor.node] : [descriptor.node, companion];
}
function publicDescriptor(descriptor: Descriptor): boolean {
  let current: Descriptor | undefined = descriptor;
  while (current !== undefined) {
    if (!current.exported) { return false; }
    current = current.parent;
  }
  return true;
}
function releaseTag(comment: ReturnType<TSDocParser["parseString"]>["docComment"] | undefined, inherited: model.ReleaseTag): model.ReleaseTag {
  const tags = comment?.modifierTagSet;
  if (tags?.isInternal() === true) { return model.ReleaseTag.Internal; }
  if (tags?.isAlpha() === true) { return model.ReleaseTag.Alpha; }
  if (tags?.isBeta() === true) { return model.ReleaseTag.Beta; }
  if (tags?.isPublic() === true) { return model.ReleaseTag.Public; }
  return inherited;
}
function readRelease(parser: TSDocParser, node: NamedNode, inherited: model.ReleaseTag, report: (id: string, text: string, node: ast.Node, severity: string) => void) {
  let documented: ast.Node = node;
  if (ast.isVariableDeclaration(node) && ast.isVariableDeclarationList(node.parent) && ast.isVariableStatement(node.parent.parent)) { documented = node.parent.parent; }
  const comments = ast.getLeadingCommentRanges(documented.getSourceFile().text, documented.pos) ?? [];
  const comment = comments.map(range => documented.getSourceFile().text.slice(range.pos, range.end)).findLast(text => text.startsWith("/**"));
  const parsed = comment === undefined ? undefined : parser.parseString(comment);
  for (const message of parsed?.log.messages ?? []) { report(message.messageId, message.text, node, "warning"); }
  return { releaseTag: releaseTag(parsed?.docComment, inherited), docComment: parsed?.docComment };
}

/** Public model constructors retain ownership of identities, parents and overload
 * references. The native adapter owns only compiler observation and projection. */
export async function createNativePublicApiModel(context: NativePublicApiContext, options: {
  readonly packageName: string;
  readonly entryPointPath: string;
  readonly includeForgottenExports: boolean;
  readonly untrimmedObservation?: boolean;
  readonly referenceProjection?: "stored-surface" | "declaration-graph";
}): Promise<{
  readonly model: model.ApiModel;
  readonly apiPackage: model.ApiPackage;
  readonly diagnostics: readonly NativePublicApiDiagnostic[];
  readonly succeeded: boolean;
  readonly declarationBindings: ReadonlyMap<string, ast.Node>;
}> {
  const diagnostics: NativePublicApiDiagnostic[] = [...await nativeCompilerDiagnostics(context)];
  const configuration = new TSDocConfiguration();
  const parser = new TSDocParser(configuration);
  const descriptors: Descriptor[] = [];
  const roots: Descriptor[] = [];
  const bySymbol = new Map<number, Descriptor[]>();
  const knownRoots = new Set<number>();
  const declarations = new Map<string, ast.Node>();
  const reported = new Set<string>();
  const problem = (id: string, text: string, node?: ast.Node, severity = "error"): void => {
    const key = `${id}:${text}:${node?.getSourceFile().fileName ?? ""}:${node?.pos ?? ""}`;
    if (reported.has(key)) { return; }
    reported.add(key);
    diagnostics.push({ source: "extractor", id, severity, text,
      ...(node === undefined ? {} : { file: node.getSourceFile().fileName, line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1 }) });
  };
  const addSymbol = async (symbol: NativeSymbol, name: string, exported: boolean, parent?: Descriptor): Promise<void> => {
    const target = await aliased(context, symbol);
    if (await context.checker.isUnknownSymbol(target)) { problem("native-unresolved-export", `Cannot resolve export ${name}.`); return; }
    for (const node of await symbolDeclarations(target)) { await addNode(node, name, exported, parent, target); }
  };
  const addNode = async (node: NamedNode, name: string, exported: boolean, parent: Descriptor | undefined, symbol?: NativeSymbol): Promise<void> => {
    assertNotCancelled(context.signal);
    if (descriptors.length >= 100_000) { throw new Error("Native public API model node budget exhausted."); }
    if (modifiers(node, ast.SyntaxKind.PrivateKeyword) || node.name?.kind === ast.SyntaxKind.PrivateIdentifier) { return; }
    const doc = readRelease(parser, node, parent?.releaseTag ?? model.ReleaseTag.Public, problem);
    if (doc.releaseTag === model.ReleaseTag.Internal && options.untrimmedObservation !== true) { return; }
    const siblings = parent?.children ?? roots;
    const merging = [ast.SyntaxKind.InterfaceDeclaration, ast.SyntaxKind.ModuleDeclaration, ast.SyntaxKind.SourceFile].includes(node.kind);
    const existing = merging ? siblings.find(item => item.name === name && item.node.kind === node.kind && item.symbol?.id === symbol?.id) : undefined;
    if (existing !== undefined) {
      if (hasDeclarationHeader(node)) { problem("native-merged-header", "Merged declaration headers require an unambiguous native projection.", node); }
      await addMembers(node, existing);
      return;
    }
    // Getter/setter pairs are one property in the public model. The getter is
    // the canonical declaration when both are present; setter-only properties
    // retain their actual declaration and parameter type.
    if (await setterWithGetter(context, node, name)) { return; }
    const descriptor: Descriptor = { node, name, symbol, exported, ...doc, children: [], parent, overloadIndex: countOverload(siblings, node, name), canonicalReference: "" };
    siblings.push(descriptor); descriptors.push(descriptor);
    if (symbol !== undefined) { const values = bySymbol.get(symbol.id) ?? []; values.push(descriptor); bySymbol.set(symbol.id, values); }
    await addMembers(node, descriptor);
  };
  const addMembers = async (node: NamedNode, parent: Descriptor): Promise<void> => {
    if (ast.isModuleDeclaration(node) || ast.isSourceFile(node)) {
      const symbol = await context.checker.getSymbolAtLocation(ast.isSourceFile(node) ? node : node.name);
      if (symbol === undefined) { problem("native-namespace-binding", "Cannot bind the namespace declaration.", node); return; }
      for (const child of await context.checker.getExportsOfModule(symbol)) { await addSymbol(child, child.name, true, parent); }
    } else if (ast.isClassDeclaration(node) || ast.isInterfaceDeclaration(node) || ast.isEnumDeclaration(node)) {
      for (const member of node.members) {
        if (member.kind === ast.SyntaxKind.SemicolonClassElement) { continue; }
        const named = member as NamedNode;
        const name = named.name === undefined ? "" : ast.isIdentifier(named.name) || ast.isStringLiteral(named.name) || ast.isNumericLiteral(named.name) ? named.name.text : await context.emitter.printNode(named.name);
        const symbol = named.name === undefined ? undefined : await context.checker.getSymbolAtLocation(named.name);
        await addNode(named, name, true, parent, symbol);
      }
    }
  };

  const source = await context.program.getSourceFile(options.entryPointPath);
  const sourceSymbol = source === undefined ? undefined : await context.checker.getSymbolAtLocation(source);
  if (sourceSymbol === undefined) { throw new Error("Native public API entrypoint must be a declaration module."); }
  if (source?.statements.some(statement => ast.isExportAssignment(statement) && statement.isExportEquals) === true) {
    problem("native-export-assignment", "CommonJS export assignment requires an explicit native API projection.", source);
  }
  for (const exported of await context.checker.getExportsOfModule(sourceSymbol)) {
    const target = await aliased(context, exported);
    knownRoots.add((await symbolRoot(context, target)).id);
    await addSymbol(target, exported.name, true);
  }

  const addHidden = async (root: NativeSymbol): Promise<void> => {
    let name = root.name;
    let suffix = 2;
    while (roots.some(candidate => candidate.name === name)) { name = `${root.name}_${suffix++}`; }
    await addSymbol(root, name, false);
  };
  // Retain hidden dependencies for audit while production continues to reject
  // forgotten exports. ECMAScript symbol brands retain the upstream exemption.
  for (let index = 0; index < descriptors.length; index++) {
    const descriptor = descriptors[index]!;
    for (const node of await representedDeclarations(context, descriptor)) {
      for (const occurrence of await references(context, node, problem)) {
        const root = await symbolRoot(context, occurrence.symbol);
        const declaration = (await symbolDeclarations(root))[0];
        if (declaration === undefined || await context.program.isSourceFileDefaultLibrary(declaration.getSourceFile())) { continue; }
        const owner = packageNameFor(context, declaration);
        if (owner !== undefined && owner !== options.packageName) { continue; }
        if (knownRoots.has(root.id) || bySymbol.get(root.id)?.some(publicDescriptor) === true) { continue; }
        if (!await uniqueSymbol(root)) { problem("ae-forgotten-export", `The symbol "${root.name}" needs to be exported by the entry point.`, descriptor.node); }
        knownRoots.add(root.id);
        if (options.includeForgottenExports) { await addHidden(root); }
      }
    }
  }

  const instantiate = async (descriptor: Descriptor, bind: boolean): Promise<model.ApiDeclaredItem> => {
    const excerpts = [];
    for (const node of await representedDeclarations(context, descriptor)) {
      const boundReferences: NativeExcerptReference[] = [];
      if (bind) {
        for (const occurrence of await references(context, node, problem)) {
          const matches = bySymbol.get(occurrence.symbol.id) ?? [];
          const canonicalReference = matches.find(candidate => candidate.name === occurrence.node.getText())?.canonicalReference ?? matches[0]?.canonicalReference ?? await externalReference(context, occurrence, options.packageName, problem);
          if (canonicalReference !== undefined && canonicalReference.length > 0) { boundReferences.push({ start: occurrence.start, end: occurrence.end, canonicalReference }); }
        }
      }
      excerpts.push(await createNativeExcerpt(context, { ...descriptor, node }, boundReferences));
    }
    const projected = combineNativeExcerpts(excerpts);
    return createNativeApiItem(context, descriptor, projected);
  };
  const build = async (bind: boolean) => {
    const apiModel = new model.ApiModel();
    const apiPackage = new model.ApiPackage({ name: options.packageName, docComment: undefined, tsdocConfiguration: configuration });
    const entry = new model.ApiEntryPoint({ name: "" });
    apiModel.addMember(apiPackage); apiPackage.addMember(entry);
    const append = async (descriptor: Descriptor, parent: Container): Promise<void> => {
      const item = await instantiate(descriptor, bind);
      parent.addMember(item);
      descriptor.canonicalReference = item.canonicalReference.toString();
      declarations.set(descriptor.canonicalReference, descriptor.node);
      if (descriptor.children.length > 0) {
        if (!model.ApiItemContainerMixin.isBaseClassOf(item)) { throw new Error("Native model item cannot own declarations."); }
        for (const child of descriptor.children) { await append(child, item); }
      }
    };
    for (const descriptor of roots) { await append(descriptor, entry); }
    return { model: apiModel, apiPackage };
  };
  const unbound = await build(false);
  const result = options.referenceProjection === "stored-surface" ? unbound : await build(true);
  assertNotCancelled(context.signal);
  return { ...result, diagnostics, succeeded: !diagnostics.some(diagnostic => diagnostic.severity === "error"), declarationBindings: declarations };
}
