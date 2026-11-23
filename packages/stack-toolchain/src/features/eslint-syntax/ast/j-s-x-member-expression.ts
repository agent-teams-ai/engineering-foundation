// Retained parser ESTree contract from @typescript-eslint/types 8.73.0 (MIT).
// Exact provenance and native nullability adaptations: eslint-syntax-provenance.json.
import type {
  AST_NODE_TYPES,
  AST_TOKEN_TYPES,
  ArrayExpression,
  ArrayPattern,
  ArrowFunctionExpression,
  BaseNode,
  BaseToken,
  BigIntLiteral,
  BooleanLiteral,
  CallExpression,
  ClassExpression,
  ConstDeclaration,
  Expression,
  FunctionExpression,
  Identifier,
  JSXAttribute,
  JSXElement,
  JSXEmptyExpression,
  JSXFragment,
  JSXIdentifier,
  MemberExpression,
  MetaProperty,
  NullLiteral,
  NumberLiteral,
  ObjectExpression,
  ObjectPattern,
  RegExpLiteral,
  SequenceExpression,
  Statement,
  StringLiteral,
  Super,
  TSAsExpression,
  TSNonNullExpression,
  TSTypeAssertion,
  TSTypeParameterInstantiation,
  TaggedTemplateExpression,
  TemplateLiteral,
  ThisExpression,
  VariableDeclaration,
  VariableDeclaratorDefiniteAssignment,
  VariableDeclaratorMaybeInit,
  VariableDeclaratorNoInit,
} from "../ast.js";

export interface JSXMemberExpression extends BaseNode {
    type: AST_NODE_TYPES.JSXMemberExpression;
    object: JSXTagNameExpression;
    property: JSXIdentifier;
}
export interface JSXNamespacedName extends BaseNode {
    type: AST_NODE_TYPES.JSXNamespacedName;
    name: JSXIdentifier;
    namespace: JSXIdentifier;
}
export interface JSXOpeningElement extends BaseNode {
    type: AST_NODE_TYPES.JSXOpeningElement;
    attributes: (JSXAttribute | JSXSpreadAttribute)[];
    name: JSXTagNameExpression;
    selfClosing: boolean;
    typeArguments: TSTypeParameterInstantiation | undefined | null;
}
export interface JSXOpeningElement {
    parent: JSXElement;
}
export interface JSXOpeningFragment extends BaseNode {
    type: AST_NODE_TYPES.JSXOpeningFragment;
}
export interface JSXOpeningFragment {
    parent: JSXFragment;
}
export interface JSXSpreadAttribute extends BaseNode {
    type: AST_NODE_TYPES.JSXSpreadAttribute;
    argument: Expression;
}
export interface JSXSpreadAttribute {
    parent: JSXOpeningElement;
}
export interface JSXSpreadChild extends BaseNode {
    type: AST_NODE_TYPES.JSXSpreadChild;
    expression: Expression | JSXEmptyExpression;
}
export type JSXTagNameExpression = JSXIdentifier | JSXMemberExpression | JSXNamespacedName;
export interface JSXText extends BaseNode {
    type: AST_NODE_TYPES.JSXText;
    raw: string;
    value: string;
}
export interface JSXTextToken extends BaseToken {
    type: AST_TOKEN_TYPES.JSXText;
}
export interface KeywordToken extends BaseToken {
    type: AST_TOKEN_TYPES.Keyword;
}
export interface LabeledStatement extends BaseNode {
    type: AST_NODE_TYPES.LabeledStatement;
    body: Statement;
    label: Identifier;
}
export type LeftHandSideExpression = ArrayExpression | ArrayPattern | ArrowFunctionExpression | CallExpression | ClassExpression | FunctionExpression | Identifier | JSXElement | JSXFragment | LiteralExpression | MemberExpression | MetaProperty | ObjectExpression | ObjectPattern | SequenceExpression | Super | TaggedTemplateExpression | ThisExpression | TSAsExpression | TSNonNullExpression | TSTypeAssertion;
export type LetOrConstOrVarDeclaration = ConstDeclaration | LetOrVarDeclaredDeclaration | LetOrVarNonDeclaredDeclaration;
export interface LetOrConstOrVarDeclarationBase extends BaseNode {
    type: AST_NODE_TYPES.VariableDeclaration;
    /**
     * The variables declared by this declaration.
     * Always non-empty.
     * @example
     * ```ts
     * let x;
     * let y, z;
     * ```
     */
    declarations: LetOrConstOrVarDeclarator[];
    /**
     * Whether the declaration is `declare`d
     * @example
     * ```ts
     * const x = 1;
     * ```
     */
    declare: boolean;
    /**
     * The keyword used to the variable(s)
     * @example
     * ```ts
     * const x = 1;
     * let y = 2;
     * var z = 3;
     * ```
     */
    kind: 'const' | 'let' | 'var';
}
export type LetOrConstOrVarDeclarator = VariableDeclaratorDefiniteAssignment | VariableDeclaratorMaybeInit | VariableDeclaratorNoInit;
export interface LetOrVarDeclaredDeclaration extends LetOrConstOrVarDeclarationBase {
    /**
     * In a `let` declaration, the declarators must not have definite assignment
     * assertions or initializers.
     *
     * @example
     * ```ts
     * using x = 1;
     * using y =1, z = 2;
     * ```
     */
    declarations: VariableDeclaratorNoInit[];
    declare: true;
    kind: 'let' | 'var';
}
export interface LetOrVarNonDeclaredDeclaration extends LetOrConstOrVarDeclarationBase {
    /**
     * In a `let`/`var` declaration, the declarators may have definite assignment
     * assertions or initializers, but not both.
     */
    declarations: (VariableDeclaratorDefiniteAssignment | VariableDeclaratorMaybeInit)[];
    declare: false;
    kind: 'let' | 'var';
}
export interface LineComment extends BaseToken {
    type: AST_TOKEN_TYPES.Line;
}
export type Literal = BigIntLiteral | BooleanLiteral | NullLiteral | NumberLiteral | RegExpLiteral | StringLiteral;
export interface LiteralBase extends BaseNode {
    type: AST_NODE_TYPES.Literal;
    raw: string;
    value: bigint | boolean | number | string | RegExp | null;
}
export type LiteralExpression = Literal | TemplateLiteral;
export interface LogicalExpression extends BaseNode {
    type: AST_NODE_TYPES.LogicalExpression;
    left: Expression;
    operator: '&&' | '??' | '||';
    right: Expression;
}
