// Retained parser ESTree contract from @typescript-eslint/types 8.73.0 (MIT).
// Exact provenance and native nullability adaptations: eslint-syntax-provenance.json.
import type {
  AST_NODE_TYPES,
  ArrayExpression,
  ArrayPattern,
  ArrowFunctionExpression,
  AssignmentExpression,
  AwaitExpression,
  BaseNode,
  BinaryExpression,
  BlockStatement,
  CallExpression,
  ChainExpression,
  ClassExpression,
  ConditionalExpression,
  ExportKind,
  ExportNamedDeclaration,
  ExportNamedDeclarationBase,
  FunctionExpression,
  Identifier,
  ImportAttribute,
  ImportExpression,
  JSXElement,
  JSXFragment,
  LetOrConstOrVarDeclaration,
  LiteralExpression,
  LogicalExpression,
  MemberExpression,
  MetaProperty,
  NamedExportDeclarations,
  NewExpression,
  ObjectExpression,
  ObjectPattern,
  Program,
  SequenceExpression,
  Statement,
  StringLiteral,
  Super,
  TSAsExpression,
  TSInstantiationExpression,
  TSModuleBlock,
  TSNonNullExpression,
  TSSatisfiesExpression,
  TSTypeAssertion,
  TaggedTemplateExpression,
  TemplateLiteral,
  ThisExpression,
  UnaryExpression,
  UpdateExpression,
  UsingInForOfDeclaration,
  YieldExpression,
} from "../ast.js";

export interface ExportNamedDeclarationWithoutSourceWithMultiple extends ExportNamedDeclarationBase {
    /**
     * This will always be an empty array.
     * @deprecated Replaced with {@link `attributes`}.
     */
    assertions: ImportAttribute[];
    /**
     * This will always be an empty array.
     */
    attributes: ImportAttribute[];
    declaration: null;
    source: null;
    specifiers: ExportSpecifierWithIdentifierLocal[];
}
/**
 * Exporting a single named declaration.
 * ```
 * export const x = 1;
 * ```
 */
export interface ExportNamedDeclarationWithoutSourceWithMultiple {
    parent: BlockStatement | Program | TSModuleBlock;
}
export interface ExportNamedDeclarationWithoutSourceWithSingle extends ExportNamedDeclarationBase {
    /**
     * This will always be an empty array.
     * @deprecated Replaced with {@link `attributes`}.
     */
    assertions: ImportAttribute[];
    /**
     * This will always be an empty array.
     */
    attributes: ImportAttribute[];
    declaration: NamedExportDeclarations;
    source: null;
    /**
     * This will always be an empty array.
     */
    specifiers: ExportSpecifierWithIdentifierLocal[];
}
/**
 * Export names from another module.
 * ```
 * export { a, b } from 'mod';
 * ```
 */
export interface ExportNamedDeclarationWithoutSourceWithSingle {
    parent: BlockStatement | Program | TSModuleBlock;
}
export type ExportSpecifier = ExportSpecifierWithIdentifierLocal | ExportSpecifierWithStringOrLiteralLocal;
export interface ExportSpecifierBase extends BaseNode {
    type: AST_NODE_TYPES.ExportSpecifier;
    exported: Identifier | StringLiteral;
    exportKind: ExportKind;
    local: Identifier | StringLiteral;
}
export interface ExportSpecifierWithIdentifierLocal extends ExportSpecifierBase {
    local: Identifier;
}
export interface ExportSpecifierWithIdentifierLocal {
    parent: ExportNamedDeclaration;
}
export interface ExportSpecifierWithStringOrLiteralLocal extends ExportSpecifierBase {
    local: Identifier | StringLiteral;
}
export interface ExportSpecifierWithStringOrLiteralLocal {
    parent: ExportNamedDeclaration;
}
export type Expression = ArrayExpression | ArrayPattern | ArrowFunctionExpression | AssignmentExpression | AwaitExpression | BinaryExpression | CallExpression | ChainExpression | ClassExpression | ConditionalExpression | FunctionExpression | Identifier | ImportExpression | JSXElement | JSXFragment | LiteralExpression | LogicalExpression | MemberExpression | MetaProperty | NewExpression | ObjectExpression | ObjectPattern | SequenceExpression | Super | TaggedTemplateExpression | TemplateLiteral | ThisExpression | TSAsExpression | TSInstantiationExpression | TSNonNullExpression | TSSatisfiesExpression | TSTypeAssertion | UnaryExpression | UpdateExpression | YieldExpression;
export interface ExpressionStatement extends BaseNode {
    type: AST_NODE_TYPES.ExpressionStatement;
    directive: string | undefined;
    expression: Expression;
}
export interface ForInStatement extends BaseNode {
    type: AST_NODE_TYPES.ForInStatement;
    body: Statement;
    left: ForInitialiser;
    right: Expression;
}
export type ForInitialiser = Expression | LetOrConstOrVarDeclaration;
export type ForOfInitialiser = Expression | LetOrConstOrVarDeclaration | UsingInForOfDeclaration;
export interface ForOfStatement extends BaseNode {
    type: AST_NODE_TYPES.ForOfStatement;
    await: boolean;
    body: Statement;
    left: ForOfInitialiser;
    right: Expression;
}
export interface ForStatement extends BaseNode {
    type: AST_NODE_TYPES.ForStatement;
    body: Statement;
    init: Expression | ForInitialiser | null;
    test: Expression | null;
    update: Expression | null;
}
