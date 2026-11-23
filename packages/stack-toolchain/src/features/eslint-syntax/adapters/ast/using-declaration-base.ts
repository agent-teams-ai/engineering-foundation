// Retained parser ESTree contract from @typescript-eslint/types 8.73.0 (MIT).
// Exact provenance and native nullability adaptations: eslint-syntax-provenance.json.
import type {
  AST_NODE_TYPES,
  BaseNode,
  BindingName,
  Expression,
  Identifier,
  LetOrConstOrVarDeclaration,
  LetOrConstOrVarDeclarator,
  Statement,
  UsingDeclaration,
} from "../ast.js";

export interface UsingDeclarationBase extends BaseNode {
  type: AST_NODE_TYPES.VariableDeclaration;
  /**
   * This value will always be `false`
   * because 'declare' modifier cannot appear on a 'using' declaration.
   */
  declare: false;
  /**
   * The keyword used to the variable(s)
   * @example
   * ```ts
   * using x = 1;
   * await using y = 2;
   * ```
   */
  kind: "await using" | "using";
}
export type UsingDeclarator = UsingInForOfDeclarator | UsingInNormalContextDeclarator;
export interface UsingInForOfDeclaration extends UsingDeclarationBase {
  /**
   * The variables declared by this declaration.
   * Always has exactly one element.
   * @example
   * ```ts
   * for (using x of y) {}
   * ```
   */
  declarations: [UsingInForOfDeclarator];
}
export interface UsingInForOfDeclarator extends VariableDeclaratorBase {
  definite: false;
  id: Identifier;
  init: null;
}
export interface UsingInForOfDeclarator {
  parent: VariableDeclaration;
}
export interface UsingInNormalContextDeclaration extends UsingDeclarationBase {
  /**
   * The variables declared by this declaration.
   * Always non-empty.
   * @example
   * ```ts
   * using x = 1;
   * using y = 1, z = 2;
   * ```
   */
  declarations: UsingInNormalContextDeclarator[];
}
export interface UsingInNormalContextDeclarator extends VariableDeclaratorBase {
  definite: false;
  id: Identifier;
  init: Expression;
}
export interface UsingInNormalContextDeclarator {
  parent: VariableDeclaration;
}
export type ValueOf<T> = T[keyof T];
export type VariableDeclaration = LetOrConstOrVarDeclaration | UsingDeclaration;
export type VariableDeclarator = LetOrConstOrVarDeclarator | UsingDeclarator;
export interface VariableDeclaratorBase extends BaseNode {
  type: AST_NODE_TYPES.VariableDeclarator;
  /**
   * Whether there's definite assignment assertion (`let x!: number`).
   * If `true`, then: `id` must be an identifier with a type annotation,
   * `init` must be `null`, and the declarator must be a `var`/`let` declarator.
   */
  definite: boolean;
  /**
   * The name(s) of the variable(s).
   */
  id: BindingName;
  /**
   * The initializer expression of the variable. Must be present for `const` unless
   * in a `const`.
   */
  init: Expression | null;
}
export interface VariableDeclaratorDefiniteAssignment extends VariableDeclaratorBase {
  definite: true;
  /**
   * The name of the variable. Must have a type annotation.
   */
  id: Identifier;
  init: null;
}
export interface VariableDeclaratorDefiniteAssignment {
  parent: VariableDeclaration;
}
export interface VariableDeclaratorMaybeInit extends VariableDeclaratorBase {
  definite: false;
}
export interface VariableDeclaratorMaybeInit {
  parent: VariableDeclaration;
}
export interface VariableDeclaratorNoInit extends VariableDeclaratorBase {
  definite: false;
  init: null;
}
export interface VariableDeclaratorNoInit {
  parent: VariableDeclaration;
}
export interface WhileStatement extends BaseNode {
  type: AST_NODE_TYPES.WhileStatement;
  body: Statement;
  test: Expression;
}
export interface WithStatement extends BaseNode {
  type: AST_NODE_TYPES.WithStatement;
  body: Statement;
  object: Expression;
}
export type YieldExpression = YieldNoStarExpression | YieldStarExpression;
export interface YieldExpressionBase extends BaseNode {
  type: AST_NODE_TYPES.YieldExpression;
  argument: Expression | null;
  delegate: boolean;
}
export interface YieldNoStarExpression extends YieldExpressionBase {
  delegate: false;
}
export interface YieldStarExpression extends YieldExpressionBase {
  argument: Expression;
  delegate: true;
}
