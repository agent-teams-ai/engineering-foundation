// Retained parser ESTree contract from @typescript-eslint/types 8.73.0 (MIT).
// Exact provenance and native nullability adaptations: eslint-syntax-provenance.json.
import type {
  AST_NODE_TYPES,
  AST_TOKEN_TYPES,
  Accessibility,
  ArrayExpression,
  ArrayPattern,
  AssignmentPattern,
  BaseNode,
  BaseToken,
  BindingName,
  ClassBody,
  ClassExpression,
  Comment,
  Decorator,
  ExportAllDeclaration,
  ExportDefaultDeclaration,
  ExportNamedDeclaration,
  Expression,
  FunctionExpression,
  Identifier,
  ImportDeclaration,
  JSXElement,
  JSXFragment,
  JSXOpeningElement,
  LiteralBase,
  LiteralExpression,
  MetaProperty,
  PropertyDefinitionNonComputedName,
  PropertyName,
  PropertyNameComputed,
  PropertyNonComputedName,
  Range,
  RestElement,
  SourceLocation,
  SpreadElement,
  Statement,
  Super,
  TSEmptyBodyFunctionExpression,
  TSImportEqualsDeclaration,
  TSNamespaceExportDeclaration,
  TSNullKeyword,
  TSParameterProperty,
  TSTypeAnnotation,
  TemplateLiteral,
  ThisExpression,
  Token,
} from "../ast.js";

export interface NodeOrTokenData {
  type: string;
  /**
   * The source location information of the node.
   *
   * The loc property is defined as nullable by ESTree, but ESLint requires this property.
   */
  loc: SourceLocation;
  range: Range;
}
export interface NullLiteral extends LiteralBase {
  raw: "null";
  value: null;
}
export interface NullToken extends BaseToken {
  type: AST_TOKEN_TYPES.Null;
}
export interface NumberLiteral extends LiteralBase {
  value: number;
}
export interface NumericToken extends BaseToken {
  type: AST_TOKEN_TYPES.Numeric;
}
export interface ObjectExpression extends BaseNode {
  type: AST_NODE_TYPES.ObjectExpression;
  properties: ObjectLiteralElement[];
}
export type ObjectLiteralElement = Property | SpreadElement;
export type ObjectLiteralElementLike = ObjectLiteralElement;
export interface ObjectPattern extends BaseNode {
  type: AST_NODE_TYPES.ObjectPattern;
  decorators: Decorator[];
  optional: boolean;
  properties: (Property | RestElement)[];
  typeAnnotation: TSTypeAnnotation | undefined | null;
}
export type OptionalRangeAndLoc<T> = {
  loc?: SourceLocation;
  range?: Range;
} & Pick<T, Exclude<keyof T, "loc" | "range">>;
export type Parameter =
  | ArrayPattern
  | AssignmentPattern
  | Identifier
  | ObjectPattern
  | RestElement
  | TSParameterProperty;
export type ParameterPropertyParameter =
  | (AssignmentPattern & {
      left: Identifier;
    })
  | Identifier;
export interface Position {
  /**
   * Column number on the line (0-indexed)
   */
  column: number;
  /**
   * Line number (1-indexed)
   */
  line: number;
}
export type PrimaryExpression =
  | ArrayExpression
  | ArrayPattern
  | ClassExpression
  | FunctionExpression
  | Identifier
  | JSXElement
  | JSXFragment
  | JSXOpeningElement
  | LiteralExpression
  | MetaProperty
  | ObjectExpression
  | ObjectPattern
  | Super
  | TemplateLiteral
  | ThisExpression
  | TSNullKeyword;
export interface PrivateIdentifier extends BaseNode {
  type: AST_NODE_TYPES.PrivateIdentifier;
  name: string;
}
export interface PrivateIdentifierToken extends BaseToken {
  type: AST_TOKEN_TYPES.PrivateIdentifier;
}
export interface PrivateInExpression extends BaseNode {
  type: AST_NODE_TYPES.BinaryExpression;
  left: PrivateIdentifier;
  operator: "in";
  right: Expression;
}
export interface Program extends NodeOrTokenData {
  type: AST_NODE_TYPES.Program;
  body: ProgramStatement[];
  comments: Comment[] | undefined;
  sourceType: "module" | "script";
  tokens: Token[] | undefined;
}
export interface Program {
  /**
   * @remarks This never-used property exists only as a convenience for code that tries to access node parents repeatedly.
   */
  parent?: never;
}
export type ProgramStatement =
  | ExportAllDeclaration
  | ExportDefaultDeclaration
  | ExportNamedDeclaration
  | ImportDeclaration
  | Statement
  | TSImportEqualsDeclaration
  | TSNamespaceExportDeclaration;
export type Property = PropertyComputedName | PropertyNonComputedName;
export interface PropertyBase extends BaseNode {
  type: AST_NODE_TYPES.Property;
  computed: boolean;
  key: PropertyName;
  kind: "get" | "init" | "set";
  method: boolean;
  optional: boolean;
  shorthand: boolean;
  value: AssignmentPattern | BindingName | Expression | TSEmptyBodyFunctionExpression;
}
export interface PropertyComputedName extends PropertyBase {
  computed: true;
  key: PropertyNameComputed;
}
export interface PropertyComputedName {
  parent: ObjectExpression | ObjectPattern;
}
export type PropertyDefinition = PropertyDefinitionComputedName | PropertyDefinitionNonComputedName;
export interface PropertyDefinitionBase extends BaseNode {
  accessibility: Accessibility | undefined;
  computed: boolean;
  declare: boolean;
  decorators: Decorator[];
  definite: boolean;
  key: PropertyName;
  optional: boolean;
  override: boolean;
  readonly: boolean;
  static: boolean;
  typeAnnotation: TSTypeAnnotation | undefined | null;
  value: Expression | null;
}
export interface PropertyDefinitionComputedName extends PropertyDefinitionComputedNameBase {
  type: AST_NODE_TYPES.PropertyDefinition;
}
export interface PropertyDefinitionComputedName {
  parent: ClassBody;
}
export interface PropertyDefinitionComputedNameBase extends PropertyDefinitionBase {
  computed: true;
  key: PropertyNameComputed;
}
