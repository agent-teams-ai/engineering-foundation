// Retained parser ESTree contract from @typescript-eslint/types 8.73.0 (MIT).
// Exact provenance and native nullability adaptations: eslint-syntax-provenance.json.
import type {
  AST_NODE_TYPES,
  Accessibility,
  BaseNode,
  Decorator,
  Expression,
  FunctionLike,
  Identifier,
  Literal,
  ParameterPropertyParameter,
  StringLiteral,
  TSModuleBlock,
  TSPropertySignatureComputedName,
  TSPropertySignatureNonComputedName,
  TSQualifiedName,
  TypeNode,
} from "../ast.js";

interface TSModuleDeclarationBase extends BaseNode {
  type: AST_NODE_TYPES.TSModuleDeclaration;
  /**
   * The body of the module.
   * This can only be `undefined` for the code `module 'mod';`
   */
  body?: TSModuleBlock | null;
  /**
   * Whether the module is `declare`d
   * @example
   * ```ts
   * namespace F {}
   * ```
   */
  declare: boolean;
  /**
   * Whether this is a global declaration
   * @example
   * ```ts
   * global {}
   * ```
   *
   * @deprecated Use {@link kind} instead
   */
  global: boolean;
  /**
   * The name of the module
   * ```
   * namespace A {}
   * namespace A.B.C {}
   * module 'a' {}
   * ```
   */
  id: Identifier | Literal | TSQualifiedName;
  /**
   * The keyword used to define this module declaration
   * @example
   * ```ts
   * namespace Foo {}
   * ^^^^^^^^^
   *
   * module 'foo' {}
   * ^^^^^^
   *
   * global {}
   * ^^^^^^
   * ```
   */
  kind: TSModuleDeclarationKind;
}
export interface TSModuleDeclarationGlobal extends TSModuleDeclarationBase {
  body: TSModuleBlock;
  /**
   * This will always be an Identifier with name `global`
   */
  id: Identifier;
  kind: "global";
}
type TSModuleDeclarationKind = "global" | "module" | "namespace";
export type TSModuleDeclarationModule =
  | TSModuleDeclarationModuleWithIdentifierId
  | TSModuleDeclarationModuleWithStringId;
interface TSModuleDeclarationModuleBase extends TSModuleDeclarationBase {
  kind: "module";
}
/**
 * The legacy module declaration, replaced with namespace declarations.
 * ```
 * module A {}
 * ```
 */
interface TSModuleDeclarationModuleWithIdentifierId extends TSModuleDeclarationModuleBase {
  body: TSModuleBlock;
  id: Identifier;
  kind: "module";
}
type TSModuleDeclarationModuleWithStringId =
  | TSModuleDeclarationModuleWithStringIdDeclared
  | TSModuleDeclarationModuleWithStringIdNotDeclared;
/**
 * A string module declaration that is declared:
 * ```
 * module 'foo' {}
 * module 'foo';
 * ```
 */
interface TSModuleDeclarationModuleWithStringIdDeclared extends TSModuleDeclarationModuleBase {
  body?: TSModuleBlock | null;
  declare: true;
  id: StringLiteral;
  kind: "module";
}
/**
 * A string module declaration that is not declared:
 * ```
 * module 'foo' {}
 * ```
 */
interface TSModuleDeclarationModuleWithStringIdNotDeclared extends TSModuleDeclarationModuleBase {
  body: TSModuleBlock;
  declare: false;
  id: StringLiteral;
  kind: "module";
}
export interface TSModuleDeclarationNamespace extends TSModuleDeclarationBase {
  body: TSModuleBlock;
  id: Identifier | TSQualifiedName;
  kind: "namespace";
}
export interface TSNamedTupleMember extends BaseNode {
  type: AST_NODE_TYPES.TSNamedTupleMember;
  elementType: TypeNode;
  label: Identifier;
  optional: boolean;
}
/**
 * For the following declaration:
 * ```
 * export as namespace X;
 * ```
 */
export interface TSNamespaceExportDeclaration extends BaseNode {
  type: AST_NODE_TYPES.TSNamespaceExportDeclaration;
  /**
   * The name of the global variable that's exported as namespace
   */
  id: Identifier;
}
export interface TSNeverKeyword extends BaseNode {
  type: AST_NODE_TYPES.TSNeverKeyword;
}
export interface TSNonNullExpression extends BaseNode {
  type: AST_NODE_TYPES.TSNonNullExpression;
  expression: Expression;
}
export interface TSNullKeyword extends BaseNode {
  type: AST_NODE_TYPES.TSNullKeyword;
}
export interface TSNumberKeyword extends BaseNode {
  type: AST_NODE_TYPES.TSNumberKeyword;
}
export interface TSObjectKeyword extends BaseNode {
  type: AST_NODE_TYPES.TSObjectKeyword;
}
export interface TSOptionalType extends BaseNode {
  type: AST_NODE_TYPES.TSOptionalType;
  typeAnnotation: TypeNode;
}
export interface TSParameterProperty extends BaseNode {
  type: AST_NODE_TYPES.TSParameterProperty;
  accessibility: Accessibility | undefined;
  decorators: Decorator[];
  override: boolean;
  parameter: ParameterPropertyParameter;
  readonly: boolean;
  static: boolean;
}
export interface TSParameterProperty {
  parent: FunctionLike;
}
export interface TSPrivateKeyword extends BaseNode {
  type: AST_NODE_TYPES.TSPrivateKeyword;
}
export type TSPropertySignature =
  | TSPropertySignatureComputedName
  | TSPropertySignatureNonComputedName;
