// Retained parser ESTree contract from @typescript-eslint/types 8.73.0 (MIT).
// Exact provenance and native nullability adaptations: eslint-syntax-provenance.json.
import type {
  AST_NODE_TYPES,
  Accessibility,
  BaseNode,
  ClassBody,
  Expression,
  Identifier,
  LiteralExpression,
  NullLiteral,
  Parameter,
  ProgramStatement,
  PropertyName,
  PropertyNameComputed,
  PropertyNameNonComputed,
  RegExpLiteral,
  TSHeritageBase,
  TSModuleDeclarationGlobal,
  TSModuleDeclarationModule,
  TSModuleDeclarationNamespace,
  TSTypeAnnotation,
  TSTypeLiteral,
  TSTypeParameter,
  TSTypeParameterDeclaration,
  TSTypeParameterInstantiation,
  TypeElement,
  TypeNode,
  UnaryExpressionMinus,
  UnaryExpressionPlus,
} from "../ast.js";

export interface TSIndexSignature extends BaseNode {
  type: AST_NODE_TYPES.TSIndexSignature;
  accessibility: Accessibility | undefined;
  parameters: Parameter[];
  readonly: boolean;
  static: boolean;
  typeAnnotation: TSTypeAnnotation | undefined | null;
}
export interface TSIndexSignature {
  parent: ClassBody | TSInterfaceBody | TSTypeLiteral;
}
export interface TSIndexedAccessType extends BaseNode {
  type: AST_NODE_TYPES.TSIndexedAccessType;
  indexType: TypeNode;
  objectType: TypeNode;
}
export interface TSInferType extends BaseNode {
  type: AST_NODE_TYPES.TSInferType;
  typeParameter: TSTypeParameter;
}
export interface TSInstantiationExpression extends BaseNode {
  type: AST_NODE_TYPES.TSInstantiationExpression;
  expression: Expression;
  typeArguments: TSTypeParameterInstantiation;
}
export interface TSInterfaceBody extends BaseNode {
  type: AST_NODE_TYPES.TSInterfaceBody;
  body: TypeElement[];
}
export interface TSInterfaceBody {
  parent: TSInterfaceDeclaration;
}
export interface TSInterfaceDeclaration extends BaseNode {
  type: AST_NODE_TYPES.TSInterfaceDeclaration;
  /**
   * The body of the interface
   */
  body: TSInterfaceBody;
  /**
   * Whether the interface was `declare`d
   */
  declare: boolean;
  /**
   * The types this interface `extends`
   */
  extends: TSInterfaceHeritage[];
  /**
   * The name of this interface
   */
  id: Identifier;
  /**
   * The generic type parameters declared for the interface. Empty declaration
   * (`<>`) is different from no declaration.
   */
  typeParameters: TSTypeParameterDeclaration | undefined | null;
}
export interface TSInterfaceHeritage extends TSHeritageBase {
  type: AST_NODE_TYPES.TSInterfaceHeritage;
}
export interface TSInterfaceHeritage {
  parent: TSInterfaceBody;
}
export interface TSIntersectionType extends BaseNode {
  type: AST_NODE_TYPES.TSIntersectionType;
  types: TypeNode[];
}
export interface TSIntrinsicKeyword extends BaseNode {
  type: AST_NODE_TYPES.TSIntrinsicKeyword;
}
export interface TSLiteralType extends BaseNode {
  type: AST_NODE_TYPES.TSLiteralType;
  literal:
    | Exclude<LiteralExpression, NullLiteral | RegExpLiteral>
    | UnaryExpressionMinus
    | UnaryExpressionPlus;
}
export interface TSMappedType extends BaseNode {
  type: AST_NODE_TYPES.TSMappedType;
  constraint: TypeNode;
  key: Identifier;
  nameType: TypeNode | null;
  optional: boolean | "+" | "-" | undefined;
  readonly: boolean | "+" | "-" | undefined | null;
  typeAnnotation: TypeNode | undefined | null;
}
export type TSMethodSignature = TSMethodSignatureComputedName | TSMethodSignatureNonComputedName;
interface TSMethodSignatureBase extends BaseNode {
  type: AST_NODE_TYPES.TSMethodSignature;
  accessibility: Accessibility | undefined;
  computed: boolean;
  key: PropertyName;
  kind: "get" | "method" | "set";
  optional: boolean;
  params: Parameter[];
  readonly: boolean;
  returnType: TSTypeAnnotation | undefined | null;
  static: boolean;
  typeParameters: TSTypeParameterDeclaration | undefined | null;
}
interface TSMethodSignatureComputedName extends TSMethodSignatureBase {
  computed: true;
  key: PropertyNameComputed;
}
interface TSMethodSignatureComputedName {
  parent: TSInterfaceBody | TSTypeLiteral;
}
interface TSMethodSignatureNonComputedName extends TSMethodSignatureBase {
  computed: false;
  key: PropertyNameNonComputed;
}
interface TSMethodSignatureNonComputedName {
  parent: TSInterfaceBody | TSTypeLiteral;
}
export interface TSModuleBlock extends BaseNode {
  type: AST_NODE_TYPES.TSModuleBlock;
  body: ProgramStatement[];
}
export interface TSModuleBlock {
  parent: TSModuleDeclaration;
}
export type TSModuleDeclaration =
  | TSModuleDeclarationGlobal
  | TSModuleDeclarationModule
  | TSModuleDeclarationNamespace;
