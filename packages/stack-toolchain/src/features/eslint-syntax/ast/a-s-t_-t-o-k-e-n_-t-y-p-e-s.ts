// Retained parser ESTree contract from @typescript-eslint/types 8.73.0 (MIT).
// Exact provenance and native nullability adaptations: eslint-syntax-provenance.json.
import type {
  AST_NODE_TYPES,
  ClassBody,
  Decorator,
  DestructuringPattern,
  Expression,
  Identifier,
  JSXIdentifier,
  JSXText,
  LiteralBase,
  Node,
  NodeOrTokenData,
  ObjectPattern,
  Parameter,
  PrivateIdentifier,
  PrivateInExpression,
  PropertyDefinitionComputedNameBase,
  PropertyDefinitionNonComputedNameBase,
  SpreadElement,
  Statement,
  SymmetricBinaryExpression,
  TSTypeAnnotation,
  TSTypeParameterDeclaration,
  ValueOf,
} from "../ast.js";

export enum AST_TOKEN_TYPES {
    Boolean = "Boolean",
    Identifier = "Identifier",
    JSXIdentifier = "JSXIdentifier",
    PrivateIdentifier = "PrivateIdentifier",
    JSXText = "JSXText",
    Keyword = "Keyword",
    Null = "Null",
    Numeric = "Numeric",
    Punctuator = "Punctuator",
    RegularExpression = "RegularExpression",
    String = "String",
    Template = "Template",
    Block = "Block",
    Line = "Line"
}
export type Accessibility = 'private' | 'protected' | 'public';
export type AccessorProperty = AccessorPropertyComputedName | AccessorPropertyNonComputedName;
export interface AccessorPropertyComputedName extends PropertyDefinitionComputedNameBase {
    type: AST_NODE_TYPES.AccessorProperty;
}
export interface AccessorPropertyComputedName {
    parent: ClassBody;
}
export interface AccessorPropertyNonComputedName extends PropertyDefinitionNonComputedNameBase {
    type: AST_NODE_TYPES.AccessorProperty;
}
export interface AccessorPropertyNonComputedName {
    parent: ClassBody;
}
export interface ArrayExpression extends BaseNode {
    type: AST_NODE_TYPES.ArrayExpression;
    /**
     * an element will be `null` in the case of a sparse array: `[1, ,3]`
     */
    elements: (Expression | SpreadElement | null)[];
}
export interface ArrayPattern extends BaseNode {
    type: AST_NODE_TYPES.ArrayPattern;
    decorators: Decorator[];
    elements: (DestructuringPattern | null)[];
    optional: boolean;
    typeAnnotation: TSTypeAnnotation | undefined | null;
}
export type ArrowFunctionExpression = ArrowFunctionExpressionWithBlockBody | ArrowFunctionExpressionWithExpressionBody;
export interface ArrowFunctionExpressionBase extends BaseNode {
    type: AST_NODE_TYPES.ArrowFunctionExpression;
    async: boolean;
    body: BlockStatement | Expression;
    expression: boolean;
    generator: false;
    id: null;
    params: Parameter[];
    returnType: TSTypeAnnotation | undefined | null;
    typeParameters: TSTypeParameterDeclaration | undefined | null;
}
export interface ArrowFunctionExpressionWithBlockBody extends ArrowFunctionExpressionBase {
    body: BlockStatement;
    expression: false;
}
export interface ArrowFunctionExpressionWithExpressionBody extends ArrowFunctionExpressionBase {
    body: Expression;
    expression: true;
}
export interface AssignmentExpression extends BaseNode {
    type: AST_NODE_TYPES.AssignmentExpression;
    left: Expression;
    operator: ValueOf<AssignmentOperatorToText>;
    right: Expression;
}
export interface AssignmentOperatorToText {
    AmpersandAmpersandEqualsToken: '&&=';
    AmpersandEqualsToken: '&=';
    AsteriskAsteriskEqualsToken: '**=';
    AsteriskEqualsToken: '*=';
    BarBarEqualsToken: '||=';
    BarEqualsToken: '|=';
    CaretEqualsToken: '^=';
    EqualsToken: '=';
    GreaterThanGreaterThanEqualsToken: '>>=';
    GreaterThanGreaterThanGreaterThanEqualsToken: '>>>=';
    LessThanLessThanEqualsToken: '<<=';
    MinusEqualsToken: '-=';
    PercentEqualsToken: '%=';
    PlusEqualsToken: '+=';
    QuestionQuestionEqualsToken: '??=';
    SlashEqualsToken: '/=';
}
export interface AssignmentPattern extends BaseNode {
    type: AST_NODE_TYPES.AssignmentPattern;
    decorators: Decorator[];
    left: BindingName;
    optional: boolean;
    right: Expression;
    typeAnnotation: TSTypeAnnotation | undefined | null;
}
export interface AwaitExpression extends BaseNode {
    type: AST_NODE_TYPES.AwaitExpression;
    argument: Expression;
}
export interface BaseNode extends NodeOrTokenData {
    type: AST_NODE_TYPES;
}
export interface BaseNode {
    parent: Node;
}
export interface BaseToken extends NodeOrTokenData {
    type: AST_TOKEN_TYPES;
    value: string;
}
export interface BigIntLiteral extends LiteralBase {
    bigint: string;
    value: bigint | null;
}
export type BinaryExpression = PrivateInExpression | SymmetricBinaryExpression;
export interface BinaryOperatorToText {
    AmpersandAmpersandToken: '&&';
    AmpersandToken: '&';
    AsteriskAsteriskToken: '**';
    AsteriskToken: '*';
    BarBarToken: '||';
    BarToken: '|';
    CaretToken: '^';
    EqualsEqualsEqualsToken: '===';
    EqualsEqualsToken: '==';
    ExclamationEqualsEqualsToken: '!==';
    ExclamationEqualsToken: '!=';
    GreaterThanEqualsToken: '>=';
    GreaterThanGreaterThanGreaterThanToken: '>>>';
    GreaterThanGreaterThanToken: '>>';
    GreaterThanToken: '>';
    InKeyword: 'in';
    InstanceOfKeyword: 'instanceof';
    LessThanEqualsToken: '<=';
    LessThanLessThanToken: '<<';
    LessThanToken: '<';
    MinusToken: '-';
    PercentToken: '%';
    PlusToken: '+';
    SlashToken: '/';
}
export type BindingName = BindingPattern | Identifier;
export type BindingPattern = ArrayPattern | ObjectPattern;
export interface BlockComment extends BaseToken {
    type: AST_TOKEN_TYPES.Block;
}
export interface BlockStatement extends BaseNode {
    type: AST_NODE_TYPES.BlockStatement;
    body: Statement[];
}
export interface BooleanLiteral extends LiteralBase {
    raw: 'false' | 'true';
    value: boolean;
}
export interface BooleanToken extends BaseToken {
    type: AST_TOKEN_TYPES.Boolean;
}
