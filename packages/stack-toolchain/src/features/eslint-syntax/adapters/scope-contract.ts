// Consumed public scope contracts from @typescript-eslint/scope-manager 8.73.0 (MIT).

import type * as TSESTree from "./ast.js";

type NodeWithParent = Exclude<TSESTree.Node, TSESTree.Program>;

export enum DefinitionType {
  CatchClause = "CatchClause",
  ClassName = "ClassName",
  FunctionName = "FunctionName",
  ImplicitGlobalVariable = "ImplicitGlobalVariable",
  ImportBinding = "ImportBinding",
  Parameter = "Parameter",
  TSEnumName = "TSEnumName",
  TSEnumMember = "TSEnumMemberName",
  TSModuleName = "TSModuleName",
  Type = "Type",
  Variable = "Variable",
}

export enum ScopeType {
  block = "block",
  catch = "catch",
  class = "class",
  classFieldInitializer = "class-field-initializer",
  classStaticBlock = "class-static-block",
  conditionalType = "conditionalType",
  for = "for",
  function = "function",
  functionExpressionName = "function-expression-name",
  functionType = "functionType",
  global = "global",
  mappedType = "mappedType",
  module = "module",
  switch = "switch",
  tsEnum = "tsEnum",
  tsModule = "tsModule",
  type = "type",
  with = "with",
}

interface DefinitionBase<
  Type extends DefinitionType,
  Node extends TSESTree.Node,
  Parent extends TSESTree.Node | null,
  Name extends TSESTree.Node,
> {
  readonly type: Type;
  readonly name: Name;
  readonly node: Node;
  readonly parent: Parent;
  readonly isTypeDefinition: boolean;
  readonly isVariableDefinition: boolean;
}

export interface CatchClauseDefinition extends DefinitionBase<
  DefinitionType.CatchClause,
  TSESTree.CatchClause,
  null,
  TSESTree.Identifier
> {}

export interface ClassNameDefinition extends DefinitionBase<
  DefinitionType.ClassName,
  TSESTree.ClassDeclaration | TSESTree.ClassExpression,
  null,
  TSESTree.Identifier
> {}

export interface FunctionNameDefinition extends DefinitionBase<
  DefinitionType.FunctionName,
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.TSDeclareFunction
  | TSESTree.TSEmptyBodyFunctionExpression,
  null,
  TSESTree.Identifier
> {}

export interface ImplicitGlobalVariableDefinition extends DefinitionBase<
  DefinitionType.ImplicitGlobalVariable,
  NodeWithParent,
  null,
  TSESTree.BindingName
> {}

export interface ImportBindingDefinition extends DefinitionBase<
  DefinitionType.ImportBinding,
  | TSESTree.ImportDefaultSpecifier
  | TSESTree.ImportNamespaceSpecifier
  | TSESTree.ImportSpecifier
  | TSESTree.TSImportEqualsDeclaration,
  TSESTree.ImportDeclaration | TSESTree.TSImportEqualsDeclaration,
  TSESTree.Identifier
> {}

export interface ParameterDefinition extends DefinitionBase<
  DefinitionType.Parameter,
  | TSESTree.ArrowFunctionExpression
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.TSCallSignatureDeclaration
  | TSESTree.TSConstructorType
  | TSESTree.TSConstructSignatureDeclaration
  | TSESTree.TSDeclareFunction
  | TSESTree.TSEmptyBodyFunctionExpression
  | TSESTree.TSFunctionType
  | TSESTree.TSMethodSignature,
  null,
  TSESTree.BindingName
> {
  readonly rest: boolean;
}

export interface TSEnumMemberDefinition extends DefinitionBase<
  DefinitionType.TSEnumMember,
  TSESTree.TSEnumMember,
  null,
  TSESTree.Identifier | TSESTree.StringLiteral
> {}

export interface TSEnumNameDefinition extends DefinitionBase<
  DefinitionType.TSEnumName,
  TSESTree.TSEnumDeclaration,
  null,
  TSESTree.Identifier
> {}

export interface TSModuleNameDefinition extends DefinitionBase<
  DefinitionType.TSModuleName,
  TSESTree.TSModuleDeclaration,
  null,
  TSESTree.Identifier
> {}

export interface TypeDefinition extends DefinitionBase<
  DefinitionType.Type,
  | TSESTree.TSInterfaceDeclaration
  | TSESTree.TSMappedType
  | TSESTree.TSTypeAliasDeclaration
  | TSESTree.TSTypeParameter,
  null,
  TSESTree.Identifier
> {}

export interface VariableDefinition extends DefinitionBase<
  DefinitionType.Variable,
  TSESTree.VariableDeclarator,
  TSESTree.VariableDeclaration,
  TSESTree.Identifier
> {}

export type Definition =
  | CatchClauseDefinition
  | ClassNameDefinition
  | FunctionNameDefinition
  | ImplicitGlobalVariableDefinition
  | ImportBindingDefinition
  | ParameterDefinition
  | TSEnumMemberDefinition
  | TSEnumNameDefinition
  | TSModuleNameDefinition
  | TypeDefinition
  | VariableDefinition;
