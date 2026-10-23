import * as ast from "typescript/unstable/ast";
import type { Symbol as NativeSymbol } from "typescript/unstable/async";
import * as model from "@microsoft/api-extractor-model";
import type { TSDocParser } from "@microsoft/tsdoc";
import {
  aliased,
  packageNameFor,
  references,
  symbolDeclarations,
  symbolRoot,
  uniqueSymbol,
} from "./native-public-api-reference.js";
import { assertNotCancelled } from "../../../application/policies/public-api-evidence-errors.js";
import type { NativePublicApiContext } from "./native-public-api-engine.js";
import {
  nativeAccessorPair,
  nativeHasModifier as modifiers,
  type NativeDeclaration as NamedNode,
} from "./native-public-api-excerpt.js";
export interface Descriptor {
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
  return (
    siblings.filter(
      (item) =>
        item.node.kind === node.kind &&
        item.name === name &&
        modifiers(item.node, ast.SyntaxKind.StaticKeyword) ===
          modifiers(node, ast.SyntaxKind.StaticKeyword),
    ).length + 1
  );
}
async function setterWithGetter(
  context: NativePublicApiContext,
  node: ast.Node,
  name: string,
): Promise<boolean> {
  return (
    ast.isSetAccessorDeclaration(node) &&
    (await nativeAccessorPair(context, node, name)) !== undefined
  );
}
function hasDeclarationHeader(node: NamedNode): boolean {
  return (node.heritageClauses?.length ?? 0) > 0 || (node.typeParameters?.length ?? 0) > 0;
}
export async function representedDeclarations(
  context: NativePublicApiContext,
  descriptor: Descriptor,
): Promise<readonly NamedNode[]> {
  const companion = ast.isGetAccessorDeclaration(descriptor.node)
    ? await nativeAccessorPair(context, descriptor.node, descriptor.name)
    : undefined;
  return companion === undefined ? [descriptor.node] : [descriptor.node, companion];
}
function publicDescriptor(descriptor: Descriptor): boolean {
  let current: Descriptor | undefined = descriptor;
  while (current !== undefined) {
    if (!current.exported) {
      return false;
    }
    current = current.parent;
  }
  return true;
}
function releaseTag(
  comment: ReturnType<TSDocParser["parseString"]>["docComment"] | undefined,
  inherited: model.ReleaseTag,
): model.ReleaseTag {
  const tags = comment?.modifierTagSet;
  if (tags?.isInternal() === true) {
    return model.ReleaseTag.Internal;
  }
  if (tags?.isAlpha() === true) {
    return model.ReleaseTag.Alpha;
  }
  if (tags?.isBeta() === true) {
    return model.ReleaseTag.Beta;
  }
  if (tags?.isPublic() === true) {
    return model.ReleaseTag.Public;
  }
  return inherited;
}
function readRelease(
  parser: TSDocParser,
  node: NamedNode,
  inherited: model.ReleaseTag,
  report: (id: string, text: string, node: ast.Node, severity: string) => void,
) {
  let documented: ast.Node = node;
  if (
    ast.isVariableDeclaration(node) &&
    ast.isVariableDeclarationList(node.parent) &&
    ast.isVariableStatement(node.parent.parent)
  ) {
    documented = node.parent.parent;
  }
  const comments =
    ast.getLeadingCommentRanges(documented.getSourceFile().text, documented.pos) ?? [];
  const comment = comments
    .map((range) => documented.getSourceFile().text.slice(range.pos, range.end))
    .findLast((text) => text.startsWith("/**"));
  const parsed = comment === undefined ? undefined : parser.parseString(comment);
  for (const message of parsed?.log.messages ?? []) {
    report(message.messageId, message.text, node, "warning");
  }
  return { releaseTag: releaseTag(parsed?.docComment, inherited), docComment: parsed?.docComment };
}

export interface NativeDescriptorOptions {
  readonly packageName: string;
  readonly entryPointPath: string;
  readonly includeForgottenExports: boolean;
  readonly untrimmedObservation?: boolean;
}
export type NativeModelProblem = (
  id: string,
  text: string,
  node?: ast.Node,
  severity?: string,
) => void;

/** Owns one traversal's mutable descriptor graph; no state escapes across extractions. */
export class NativeDescriptorCollector {
  private readonly descriptors: Descriptor[] = [];
  readonly roots: Descriptor[] = [];
  readonly bySymbol = new Map<number, Descriptor[]>();
  private readonly knownRoots = new Set<number>();
  constructor(
    private readonly context: NativePublicApiContext,
    private readonly options: NativeDescriptorOptions,
    private readonly parser: TSDocParser,
    private readonly problem: NativeModelProblem,
  ) {}
  private async addSymbol(
    symbol: NativeSymbol,
    name: string,
    exported: boolean,
    parent?: Descriptor,
  ): Promise<void> {
    const target = await aliased(this.context, symbol);
    if (await this.context.checker.isUnknownSymbol(target)) {
      this.problem("native-unresolved-export", `Cannot resolve export ${name}.`);
      return;
    }
    for (const node of await symbolDeclarations(target)) {
      await this.addNode(node, name, exported, parent, target);
    }
  }
  private async addNode(
    node: NamedNode,
    name: string,
    exported: boolean,
    parent: Descriptor | undefined,
    symbol?: NativeSymbol,
  ): Promise<void> {
    assertNotCancelled(this.context.signal);
    if (this.descriptors.length >= 100_000) {
      throw new Error("Native public API model node budget exhausted.");
    }
    if (
      modifiers(node, ast.SyntaxKind.PrivateKeyword) ||
      node.name?.kind === ast.SyntaxKind.PrivateIdentifier
    ) {
      return;
    }
    const doc = readRelease(
      this.parser,
      node,
      parent?.releaseTag ?? model.ReleaseTag.Public,
      this.problem,
    );
    if (
      doc.releaseTag === model.ReleaseTag.Internal &&
      this.options.untrimmedObservation !== true
    ) {
      return;
    }
    const siblings = parent?.children ?? this.roots;
    const merging = [
      ast.SyntaxKind.InterfaceDeclaration,
      ast.SyntaxKind.ModuleDeclaration,
      ast.SyntaxKind.SourceFile,
    ].includes(node.kind);
    const existing = merging
      ? siblings.find(
          (item) =>
            item.name === name && item.node.kind === node.kind && item.symbol?.id === symbol?.id,
        )
      : undefined;
    if (existing !== undefined) {
      if (hasDeclarationHeader(node)) {
        this.problem(
          "native-merged-header",
          "Merged declaration headers require an unambiguous native projection.",
          node,
        );
      }
      await this.addMembers(node, existing);
      return;
    }
    // Getter/setter pairs are one property in the public model. The getter is
    // the canonical declaration when both are present; setter-only properties
    // retain their actual declaration and parameter type.
    if (await setterWithGetter(this.context, node, name)) {
      return;
    }
    const descriptor: Descriptor = {
      node,
      name,
      symbol,
      exported,
      ...doc,
      children: [],
      parent,
      overloadIndex: countOverload(siblings, node, name),
      canonicalReference: "",
    };
    siblings.push(descriptor);
    this.descriptors.push(descriptor);
    if (symbol !== undefined) {
      const values = this.bySymbol.get(symbol.id) ?? [];
      values.push(descriptor);
      this.bySymbol.set(symbol.id, values);
    }
    await this.addMembers(node, descriptor);
  }
  private async addMembers(node: NamedNode, parent: Descriptor): Promise<void> {
    if (ast.isModuleDeclaration(node) || ast.isSourceFile(node)) {
      const symbol = await this.context.checker.getSymbolAtLocation(
        ast.isSourceFile(node) ? node : node.name,
      );
      if (symbol === undefined) {
        this.problem("native-namespace-binding", "Cannot bind the namespace declaration.", node);
        return;
      }
      for (const child of await this.context.checker.getExportsOfModule(symbol)) {
        await this.addSymbol(child, child.name, true, parent);
      }
    } else if (
      ast.isClassDeclaration(node) ||
      ast.isInterfaceDeclaration(node) ||
      ast.isEnumDeclaration(node)
    ) {
      for (const member of node.members) {
        if (member.kind === ast.SyntaxKind.SemicolonClassElement) {
          continue;
        }
        const named = member as NamedNode;
        const name =
          named.name === undefined
            ? ""
            : ast.isIdentifier(named.name) ||
                ast.isStringLiteral(named.name) ||
                ast.isNumericLiteral(named.name)
              ? named.name.text
              : await this.context.emitter.printNode(named.name);
        const symbol =
          named.name === undefined
            ? undefined
            : await this.context.checker.getSymbolAtLocation(named.name);
        await this.addNode(named, name, true, parent, symbol);
      }
    }
  }

  async collect(): Promise<void> {
    const source = await this.context.program.getSourceFile(this.options.entryPointPath);
    const sourceSymbol =
      source === undefined ? undefined : await this.context.checker.getSymbolAtLocation(source);
    if (sourceSymbol === undefined) {
      throw new Error("Native public API entrypoint must be a declaration module.");
    }
    if (
      source?.statements.some(
        (statement) => ast.isExportAssignment(statement) && statement.isExportEquals,
      ) === true
    ) {
      this.problem(
        "native-export-assignment",
        "CommonJS export assignment requires an explicit native API projection.",
        source,
      );
    }
    for (const exported of await this.context.checker.getExportsOfModule(sourceSymbol)) {
      const target = await aliased(this.context, exported);
      this.knownRoots.add((await symbolRoot(this.context, target)).id);
      await this.addSymbol(target, exported.name, true);
    }

    const addHidden = async (root: NativeSymbol): Promise<void> => {
      let name = root.name;
      let suffix = 2;
      while (this.roots.some((candidate) => candidate.name === name)) {
        name = `${root.name}_${suffix++}`;
      }
      await this.addSymbol(root, name, false);
    };
    // Retain hidden dependencies for audit while production continues to reject
    // forgotten exports. ECMAScript symbol brands retain the upstream exemption.
    for (let index = 0; index < this.descriptors.length; index++) {
      const descriptor = this.descriptors[index]!;
      for (const node of await representedDeclarations(this.context, descriptor)) {
        for (const occurrence of await references(this.context, node, this.problem)) {
          const root = await symbolRoot(this.context, occurrence.symbol);
          const declaration = (await symbolDeclarations(root))[0];
          if (
            declaration === undefined ||
            (await this.context.program.isSourceFileDefaultLibrary(declaration.getSourceFile()))
          ) {
            continue;
          }
          const owner = packageNameFor(this.context, declaration);
          if (owner !== undefined && owner !== this.options.packageName) {
            continue;
          }
          if (
            this.knownRoots.has(root.id) ||
            this.bySymbol.get(root.id)?.some(publicDescriptor) === true
          ) {
            continue;
          }
          if (!(await uniqueSymbol(root))) {
            this.problem(
              "ae-forgotten-export",
              `The symbol "${root.name}" needs to be exported by the entry point.`,
              descriptor.node,
            );
          }
          this.knownRoots.add(root.id);
          if (this.options.includeForgottenExports) {
            await addHidden(root);
          }
        }
      }
    }
  }
}
