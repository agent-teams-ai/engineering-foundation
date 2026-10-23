import * as ast from "typescript/unstable/ast";
import * as model from "@microsoft/api-extractor-model";
import { TSDocConfiguration, type DocComment } from "@microsoft/tsdoc";
import { DeclarationReference } from "@microsoft/tsdoc/lib-commonjs/beta/DeclarationReference.js";
import type { NativePublicApiContext } from "./native-public-api-engine.js";
import {
  nativeAccessorPair,
  nativeHasModifier,
  nativeSignatureNode,
  type NativeDeclaration,
  type NativeExcerpt,
} from "./native-public-api-excerpt.js";

export interface NativeModelDeclaration {
  readonly node: NativeDeclaration;
  readonly name: string;
  readonly exported: boolean;
  readonly releaseTag: model.ReleaseTag;
  readonly docComment: DocComment | undefined;
  readonly overloadIndex: number;
}
async function signatureOptions(
  context: NativePublicApiContext,
  node: NativeDeclaration,
  projected: NativeExcerpt,
  overloadIndex: number,
) {
  const signature = nativeSignatureNode(node);
  const parameters: {
    parameterName: string;
    parameterTypeTokenRange: model.IExcerptTokenRange;
    isOptional: boolean;
  }[] = [];
  for (const parameter of signature.parameters ?? []) {
    parameters.push({
      parameterName: await context.emitter.printNode(parameter.name),
      parameterTypeTokenRange: projected.range(parameter.type),
      isOptional: parameter.questionToken !== undefined || parameter.initializer !== undefined,
    });
  }
  return {
    overloadIndex,
    parameters,
    typeParameters: (signature.typeParameters ?? []).map((parameter) => ({
      typeParameterName: parameter.name.text,
      constraintTokenRange: projected.range(parameter.constraint),
      defaultTypeTokenRange: projected.range(parameter.defaultType),
    })),
    returnTypeTokenRange: projected.range(signature.type),
  };
}
function memberOptions(node: NativeDeclaration) {
  return {
    isOptional: node.questionToken !== undefined,
    isReadonly: nativeHasModifier(node, ast.SyntaxKind.ReadonlyKeyword),
    isStatic: nativeHasModifier(node, ast.SyntaxKind.StaticKeyword),
    isProtected: nativeHasModifier(node, ast.SyntaxKind.ProtectedKeyword),
    isAbstract: nativeHasModifier(node, ast.SyntaxKind.AbstractKeyword),
  };
}
function classHeritage(node: NativeDeclaration, projected: NativeExcerpt) {
  const base = node.heritageClauses?.find(
    (clause) => clause.token === ast.SyntaxKind.ExtendsKeyword,
  )?.types[0];
  return {
    extendsTokenRange: base === undefined ? undefined : projected.range(base),
    implementsTokenRanges:
      node.heritageClauses
        ?.filter((clause) => clause.token === ast.SyntaxKind.ImplementsKeyword)
        .flatMap((clause) => clause.types.map((type) => projected.range(type))) ?? [],
  };
}
async function readonlyAccessor(
  context: NativePublicApiContext,
  descriptor: NativeModelDeclaration,
): Promise<boolean> {
  if (!ast.isGetAccessorDeclaration(descriptor.node)) {
    return false;
  }
  return (await nativeAccessorPair(context, descriptor.node, descriptor.name)) === undefined;
}
function commonOptions(descriptor: NativeModelDeclaration, projected: NativeExcerpt) {
  return {
    name: descriptor.name,
    docComment: descriptor.docComment,
    releaseTag: descriptor.releaseTag,
    excerptTokens: projected.tokens,
    isExported: descriptor.exported,
  };
}
async function variableItem(
  context: NativePublicApiContext,
  descriptor: NativeModelDeclaration,
  projected: NativeExcerpt,
): Promise<model.ApiDeclaredItem> {
  const common = commonOptions(descriptor, projected);
  if (nativeSignatureNode(descriptor.node) !== descriptor.node) {
    return new model.ApiFunction({
      ...common,
      ...(await signatureOptions(context, descriptor.node, projected, descriptor.overloadIndex)),
    });
  }
  return new model.ApiVariable({
    ...common,
    isReadonly: (descriptor.node.parent.flags & ast.NodeFlags.Const) !== 0,
    variableTypeTokenRange: projected.range(descriptor.node.type),
    initializerTokenRange: projected.range(descriptor.node.initializer),
  });
}
function interfaceHeritage(node: NativeDeclaration, projected: NativeExcerpt) {
  return (
    node.heritageClauses?.flatMap((clause) => clause.types.map((type) => projected.range(type))) ??
    []
  );
}
function accessorType(node: NativeDeclaration) {
  return node.type ?? node.parameters?.[0]?.type;
}

/** Exhaustive supported declaration-to-model mapping. Unsupported native syntax
 * fails before it can be represented as an empty or successful API surface. */
export async function createNativeApiItem(
  context: NativePublicApiContext,
  descriptor: NativeModelDeclaration,
  projected: NativeExcerpt,
): Promise<model.ApiDeclaredItem> {
  const { node } = descriptor;
  const common = commonOptions(descriptor, projected);
  const signature = await signatureOptions(context, node, projected, descriptor.overloadIndex);
  const member = memberOptions(node);
  const access = async () =>
    new model.ApiProperty({
      ...common,
      ...member,
      isReadonly: await readonlyAccessor(context, descriptor),
      propertyTypeTokenRange: projected.range(accessorType(node)),
    });
  const constructors: Partial<
    Record<ast.SyntaxKind, () => model.ApiDeclaredItem | Promise<model.ApiDeclaredItem>>
  > = {
    [ast.SyntaxKind.FunctionDeclaration]: () => new model.ApiFunction({ ...common, ...signature }),
    [ast.SyntaxKind.TypeAliasDeclaration]: () =>
      new model.ApiTypeAlias({
        ...common,
        typeParameters: signature.typeParameters,
        typeTokenRange: projected.range(node.type),
      }),
    [ast.SyntaxKind.ClassDeclaration]: () =>
      new model.ApiClass({
        ...common,
        typeParameters: signature.typeParameters,
        isAbstract: member.isAbstract,
        ...classHeritage(node, projected),
      }),
    [ast.SyntaxKind.InterfaceDeclaration]: () =>
      new model.ApiInterface({
        ...common,
        typeParameters: signature.typeParameters,
        extendsTokenRanges: interfaceHeritage(node, projected),
      }),
    [ast.SyntaxKind.ModuleDeclaration]: () => new model.ApiNamespace(common),
    [ast.SyntaxKind.SourceFile]: () => new model.ApiNamespace(common),
    [ast.SyntaxKind.EnumDeclaration]: () => new model.ApiEnum(common),
    [ast.SyntaxKind.EnumMember]: () =>
      new model.ApiEnumMember({
        ...common,
        initializerTokenRange: projected.range(node.initializer),
      }),
    [ast.SyntaxKind.VariableDeclaration]: () => variableItem(context, descriptor, projected),
    [ast.SyntaxKind.Constructor]: () =>
      new model.ApiConstructor({ ...common, ...signature, isProtected: member.isProtected }),
    [ast.SyntaxKind.MethodDeclaration]: () =>
      new model.ApiMethod({ ...common, ...signature, ...member }),
    [ast.SyntaxKind.MethodSignature]: () =>
      new model.ApiMethodSignature({ ...common, ...signature, isOptional: member.isOptional }),
    [ast.SyntaxKind.CallSignature]: () => new model.ApiCallSignature({ ...common, ...signature }),
    [ast.SyntaxKind.ConstructSignature]: () =>
      new model.ApiConstructSignature({ ...common, ...signature }),
    [ast.SyntaxKind.IndexSignature]: () =>
      new model.ApiIndexSignature({ ...common, ...signature, isReadonly: member.isReadonly }),
    [ast.SyntaxKind.PropertyDeclaration]: () =>
      new model.ApiProperty({
        ...common,
        ...member,
        propertyTypeTokenRange: projected.range(node.type),
        initializerTokenRange: projected.range(node.initializer),
      }),
    [ast.SyntaxKind.PropertySignature]: () =>
      new model.ApiPropertySignature({
        ...common,
        ...member,
        propertyTypeTokenRange: projected.range(node.type),
      }),
    [ast.SyntaxKind.GetAccessor]: access,
    [ast.SyntaxKind.SetAccessor]: access,
  };
  const construct = constructors[node.kind];
  if (construct === undefined) {
    throw new Error(`Unsupported native public API declaration: ${ast.SyntaxKind[node.kind]}.`);
  }
  return construct();
}

/** Use the same public constructors for an external identity as for its actual
 * API model. In particular they own callable overload selectors and the
 * distinction between static and instance member navigation. */
export async function createNativeExternalReference(
  context: NativePublicApiContext,
  packageName: string | undefined,
  chain: readonly {
    readonly node: NativeDeclaration;
    readonly name: string;
  }[],
): Promise<string> {
  const pkg = new model.ApiPackage({
    name: packageName ?? "typescript-native-global",
    docComment: undefined,
    tsdocConfiguration: new TSDocConfiguration(),
  });
  const entry = new model.ApiEntryPoint({ name: "" });
  pkg.addMember(entry);
  let parent: model.ApiItem & model.ApiItemContainerMixin = entry;
  let reference = entry.canonicalReference;
  const empty: NativeExcerpt = { tokens: [], range: () => ({ startIndex: 0, endIndex: 0 }) };
  for (const [index, declaration] of chain.entries()) {
    const item = await createNativeApiItem(
      context,
      {
        ...declaration,
        exported: true,
        releaseTag: model.ReleaseTag.Public,
        docComment: undefined,
        overloadIndex: 1,
      },
      empty,
    );
    parent.addMember(item);
    reference = item.canonicalReference;
    if (index < chain.length - 1) {
      if (!model.ApiItemContainerMixin.isBaseClassOf(item)) {
        throw new Error("External native declaration identity has a non-container parent.");
      }
      parent = item;
    }
  }
  return packageName === undefined
    ? reference.withSource(DeclarationReference.global().source).toString()
    : reference.toString();
}
