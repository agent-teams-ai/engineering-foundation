// Retained parser ESTree contract from @typescript-eslint/types 8.73.0 (MIT).
// Exact provenance and native nullability adaptations: eslint-syntax-provenance.json.
import type {
  AST_NODE_TYPES,
  Accessibility,
  BaseNode,
  EntityName,
  Expression,
  Identifier,
  PropertyName,
  PropertyNameComputed,
  PropertyNameNonComputed,
  TSImportType,
  TSInferType,
  TSInterfaceBody,
  TSMappedType,
  TemplateElement,
  TypeElement,
  TypeNode,
} from "../ast.js";

interface TSPropertySignatureBase extends BaseNode {
  type: AST_NODE_TYPES.TSPropertySignature;
  accessibility: Accessibility | undefined;
  computed: boolean;
  key: PropertyName;
  optional: boolean;
  readonly: boolean;
  static: boolean;
  typeAnnotation: TSTypeAnnotation | undefined | null;
}
export interface TSPropertySignatureComputedName extends TSPropertySignatureBase {
  computed: true;
  key: PropertyNameComputed;
}
export interface TSPropertySignatureComputedName {
  parent: TSInterfaceBody | TSTypeLiteral;
}
export interface TSPropertySignatureNonComputedName extends TSPropertySignatureBase {
  computed: false;
  key: PropertyNameNonComputed;
}
export interface TSPropertySignatureNonComputedName {
  parent: TSInterfaceBody | TSTypeLiteral;
}
export interface TSProtectedKeyword extends BaseNode {
  type: AST_NODE_TYPES.TSProtectedKeyword;
}
export interface TSPublicKeyword extends BaseNode {
  type: AST_NODE_TYPES.TSPublicKeyword;
}
export interface TSQualifiedName extends BaseNode {
  type: AST_NODE_TYPES.TSQualifiedName;
  left: EntityName;
  right: Identifier;
}
export interface TSReadonlyKeyword extends BaseNode {
  type: AST_NODE_TYPES.TSReadonlyKeyword;
}
export interface TSRestType extends BaseNode {
  type: AST_NODE_TYPES.TSRestType;
  typeAnnotation: TypeNode;
}
export interface TSSatisfiesExpression extends BaseNode {
  type: AST_NODE_TYPES.TSSatisfiesExpression;
  expression: Expression;
  typeAnnotation: TypeNode;
}
export interface TSStaticKeyword extends BaseNode {
  type: AST_NODE_TYPES.TSStaticKeyword;
}
export interface TSStringKeyword extends BaseNode {
  type: AST_NODE_TYPES.TSStringKeyword;
}
export interface TSSymbolKeyword extends BaseNode {
  type: AST_NODE_TYPES.TSSymbolKeyword;
}
export interface TSTemplateLiteralType extends BaseNode {
  type: AST_NODE_TYPES.TSTemplateLiteralType;
  quasis: TemplateElement[];
  types: TypeNode[];
}
export interface TSThisType extends BaseNode {
  type: AST_NODE_TYPES.TSThisType;
}
export interface TSTupleType extends BaseNode {
  type: AST_NODE_TYPES.TSTupleType;
  elementTypes: TypeNode[];
}
export interface TSTypeAliasDeclaration extends BaseNode {
  type: AST_NODE_TYPES.TSTypeAliasDeclaration;
  /**
   * Whether the type was `declare`d.
   * @example
   * ```ts
   * type T = 1;
   * ```
   */
  declare: boolean;
  /**
   * The name of the type.
   */
  id: Identifier;
  /**
   * The "value" (type) of the declaration
   */
  typeAnnotation: TypeNode;
  /**
   * The generic type parameters declared for the type. Empty declaration
   * (`<>`) is different from no declaration.
   */
  typeParameters: TSTypeParameterDeclaration | undefined | null;
}
export interface TSTypeAnnotation extends BaseNode {
  type: AST_NODE_TYPES.TSTypeAnnotation;
  typeAnnotation: TypeNode;
}
export interface TSTypeAssertion extends BaseNode {
  type: AST_NODE_TYPES.TSTypeAssertion;
  expression: Expression;
  typeAnnotation: TypeNode;
}
export interface TSTypeLiteral extends BaseNode {
  type: AST_NODE_TYPES.TSTypeLiteral;
  members: TypeElement[];
}
export interface TSTypeOperator extends BaseNode {
  type: AST_NODE_TYPES.TSTypeOperator;
  operator: "keyof" | "readonly" | "unique";
  typeAnnotation: TypeNode | undefined | null;
}
export interface TSTypeParameter extends BaseNode {
  type: AST_NODE_TYPES.TSTypeParameter;
  const: boolean;
  constraint: TypeNode | undefined | null;
  default: TypeNode | undefined | null;
  in: boolean;
  name: Identifier;
  out: boolean;
}
export interface TSTypeParameter {
  parent: TSInferType | TSMappedType | TSTypeParameterDeclaration;
}
export interface TSTypeParameterDeclaration extends BaseNode {
  type: AST_NODE_TYPES.TSTypeParameterDeclaration;
  params: TSTypeParameter[];
}
export interface TSTypeParameterInstantiation extends BaseNode {
  type: AST_NODE_TYPES.TSTypeParameterInstantiation;
  params: TypeNode[];
}
export type TSTypePredicate = TSTypePredicateNoAsserts | TSTypePredicateWithAsserts;
interface TSTypePredicateBase extends BaseNode {
  type: AST_NODE_TYPES.TSTypePredicate;
  asserts: boolean;
  parameterName: Identifier | TSThisType;
  typeAnnotation: TSTypeAnnotation | null;
}
interface TSTypePredicateNoAsserts extends TSTypePredicateBase {
  asserts: false;
  typeAnnotation: TSTypeAnnotation;
}
interface TSTypePredicateWithAsserts extends TSTypePredicateBase {
  asserts: true;
}
export interface TSTypeQuery extends BaseNode {
  type: AST_NODE_TYPES.TSTypeQuery;
  exprName: EntityName | TSImportType;
  typeArguments: TSTypeParameterInstantiation | undefined | null;
}
export interface TSTypeReference extends BaseNode {
  type: AST_NODE_TYPES.TSTypeReference;
  typeArguments: TSTypeParameterInstantiation | undefined | null;
  typeName: EntityName;
}
