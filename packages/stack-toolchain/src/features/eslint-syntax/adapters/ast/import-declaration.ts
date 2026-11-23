// Retained parser ESTree contract from @typescript-eslint/types 8.73.0 (MIT).
// Exact provenance and native nullability adaptations: eslint-syntax-provenance.json.
import type {
  AST_NODE_TYPES,
  AST_TOKEN_TYPES,
  BaseNode,
  BaseToken,
  DoWhileStatement,
  ExportAllDeclaration,
  ExportAndImportKind,
  ExportNamedDeclaration,
  Expression,
  ForInStatement,
  ForOfStatement,
  ForStatement,
  Identifier,
  ImportAttribute,
  ImportClause,
  JSXNamespacedName,
  JSXOpeningElement,
  JSXOpeningFragment,
  JSXSpreadChild,
  JSXTagNameExpression,
  JSXText,
  Literal,
  StringLiteral,
  WhileStatement,
} from "../ast.js";

export interface ImportDeclaration extends BaseNode {
  type: AST_NODE_TYPES.ImportDeclaration;
  /**
   * The assertions declared for the export.
   * @example
   * ```ts
   * import * from 'mod' assert \{ type: 'json' \};
   * ```
   * @deprecated Replaced with {@link `attributes`}.
   */
  assertions: ImportAttribute[];
  /**
   * The attributes declared for the export.
   * @example
   * ```ts
   * import * from 'mod' with \{ type: 'json' \};
   * ```
   */
  attributes: ImportAttribute[];
  /**
   * The kind of the import.
   */
  importKind: ImportKind;
  /**
   * The phase of the import.
   * `'defer'` when the import defers evaluation of the module until it is
   * first used:
   * ```ts
   * import defer * as mod from 'mod';
   * ```
   * Otherwise `null`.
   */
  phase: "defer" | null;
  /**
   * The source module being imported from.
   */
  source: StringLiteral;
  /**
   * The specifiers being imported.
   * If this is an empty array then either there are no specifiers:
   * ```
   * import {} from 'mod';
   * ```
   * Or it is a side-effect import:
   * ```
   * import 'mod';
   * ```
   */
  specifiers: ImportClause[];
}
export interface ImportDefaultSpecifier extends BaseNode {
  type: AST_NODE_TYPES.ImportDefaultSpecifier;
  local: Identifier;
}
export interface ImportDefaultSpecifier {
  parent: ImportDeclaration;
}
export interface ImportExpression extends BaseNode {
  type: AST_NODE_TYPES.ImportExpression;
  /**
   * The attributes declared for the dynamic import.
   * @example
   * ```ts
   * import('mod', \{ assert: \{ type: 'json' \} \});
   * ```
   * @deprecated Replaced with {@link `options`}.
   */
  attributes: Expression | null;
  /**
   * The options bag declared for the dynamic import.
   * @example
   * ```ts
   * import('mod', \{ assert: \{ type: 'json' \} \});
   * ```
   */
  options: Expression | null;
  /**
   * The phase modifier of the import.
   * @example
   * ```ts
   * import('mod'); // phase: null
   * import.defer('mod'); // phase: defer
   * ```
   */
  phase: "defer" | null;
  source: Expression;
}
export type ImportKind = ExportAndImportKind;
export interface ImportNamespaceSpecifier extends BaseNode {
  type: AST_NODE_TYPES.ImportNamespaceSpecifier;
  local: Identifier;
}
export interface ImportNamespaceSpecifier {
  parent: ImportDeclaration;
}
export interface ImportSpecifier extends BaseNode {
  type: AST_NODE_TYPES.ImportSpecifier;
  imported: Identifier | StringLiteral;
  importKind: ImportKind;
  local: Identifier;
}
export interface ImportSpecifier {
  parent: ExportAllDeclaration | ExportNamedDeclaration | ImportDeclaration;
}
export type IterationStatement =
  | DoWhileStatement
  | ForInStatement
  | ForOfStatement
  | ForStatement
  | WhileStatement;
export interface JSXAttribute extends BaseNode {
  type: AST_NODE_TYPES.JSXAttribute;
  name: JSXIdentifier | JSXNamespacedName;
  value: JSXElement | JSXExpression | JSXFragment | Literal | null;
}
export interface JSXAttribute {
  parent: JSXOpeningElement;
}
export type JSXChild = JSXElement | JSXExpression | JSXFragment | JSXText;
export interface JSXClosingElement extends BaseNode {
  type: AST_NODE_TYPES.JSXClosingElement;
  name: JSXTagNameExpression;
}
export interface JSXClosingElement {
  parent: JSXElement;
}
export interface JSXClosingFragment extends BaseNode {
  type: AST_NODE_TYPES.JSXClosingFragment;
}
export interface JSXClosingFragment {
  parent: JSXFragment;
}
export interface JSXElement extends BaseNode {
  type: AST_NODE_TYPES.JSXElement;
  children: JSXChild[];
  closingElement: JSXClosingElement | null;
  openingElement: JSXOpeningElement;
}
export interface JSXEmptyExpression extends BaseNode {
  type: AST_NODE_TYPES.JSXEmptyExpression;
}
export type JSXExpression = JSXExpressionContainer | JSXSpreadChild;
export interface JSXExpressionContainer extends BaseNode {
  type: AST_NODE_TYPES.JSXExpressionContainer;
  expression: Expression | JSXEmptyExpression;
}
export interface JSXFragment extends BaseNode {
  type: AST_NODE_TYPES.JSXFragment;
  children: JSXChild[];
  closingFragment: JSXClosingFragment;
  openingFragment: JSXOpeningFragment;
}
export interface JSXIdentifier extends BaseNode {
  type: AST_NODE_TYPES.JSXIdentifier;
  name: string;
}
export interface JSXIdentifierToken extends BaseToken {
  type: AST_TOKEN_TYPES.JSXIdentifier;
}
