// Retained parser ESTree contract from @typescript-eslint/types 8.73.0 (MIT).
// Exact provenance and native nullability adaptations: eslint-syntax-provenance.json.
import type {
  AST_NODE_TYPES,
  ArrayPattern,
  AssignmentPattern,
  BaseNode,
  BlockStatement,
  ClassDeclaration,
  ClassDeclarationWithOptionalName,
  ClassExpression,
  ExportNamedDeclarationWithoutSourceWithMultiple,
  ExportNamedDeclarationWithoutSourceWithSingle,
  ExportSpecifier,
  Expression,
  FunctionDeclaration,
  FunctionDeclarationWithName,
  FunctionDeclarationWithOptionalName,
  Identifier,
  ImportAttribute,
  LeftHandSideExpression,
  MemberExpression,
  NamedExportDeclarations,
  ObjectPattern,
  Program,
  RestElement,
  Statement,
  StringLiteral,
  TSDeclareFunction,
  TSEnumDeclaration,
  TSImportEqualsDeclaration,
  TSInterfaceDeclaration,
  TSModuleBlock,
  TSModuleDeclaration,
  TSNamespaceExportDeclaration,
  TSQualifiedName,
  TSTypeAliasDeclaration,
  ThisExpression,
  VariableDeclaration,
} from "../ast.js";

export type DeclarationStatement =
  | ClassDeclaration
  | ClassExpression
  | ExportAllDeclaration
  | ExportDefaultDeclaration
  | ExportNamedDeclaration
  | FunctionDeclaration
  | TSDeclareFunction
  | TSEnumDeclaration
  | TSImportEqualsDeclaration
  | TSInterfaceDeclaration
  | TSModuleDeclaration
  | TSNamespaceExportDeclaration
  | TSTypeAliasDeclaration;
export interface Decorator extends BaseNode {
  type: AST_NODE_TYPES.Decorator;
  expression: LeftHandSideExpression;
}
export type DefaultExportDeclarations =
  | ClassDeclarationWithOptionalName
  | Expression
  | FunctionDeclarationWithName
  | FunctionDeclarationWithOptionalName
  | TSDeclareFunction
  | TSEnumDeclaration
  | TSInterfaceDeclaration
  | TSModuleDeclaration
  | TSTypeAliasDeclaration
  | VariableDeclaration;
export type DestructuringPattern =
  | ArrayPattern
  | AssignmentPattern
  | Identifier
  | MemberExpression
  | ObjectPattern
  | RestElement;
export interface DoWhileStatement extends BaseNode {
  type: AST_NODE_TYPES.DoWhileStatement;
  body: Statement;
  test: Expression;
}
export interface EmptyStatement extends BaseNode {
  type: AST_NODE_TYPES.EmptyStatement;
}
export type EntityName = Identifier | ThisExpression | TSQualifiedName;
export interface ExportAllDeclaration extends BaseNode {
  type: AST_NODE_TYPES.ExportAllDeclaration;
  /**
   * The assertions declared for the export.
   * @example
   * ```ts
   * export * from 'mod' assert \{ type: 'json' \};
   * ```
   * @deprecated Replaced with {@link `attributes`}.
   */
  assertions: ImportAttribute[];
  /**
   * The attributes declared for the export.
   * @example
   * ```ts
   * export * from 'mod' with \{ type: 'json' \};
   * ```
   */
  attributes: ImportAttribute[];
  /**
   * The name for the exported items (`as X`). `null` if no name is assigned.
   */
  exported: Identifier | null;
  /**
   * The kind of the export.
   */
  exportKind: ExportKind;
  /**
   * The source module being exported from.
   */
  source: StringLiteral;
}
export type ExportAndImportKind = "type" | "value";
export type ExportDeclaration = DefaultExportDeclarations | NamedExportDeclarations;
export interface ExportDefaultDeclaration extends BaseNode {
  type: AST_NODE_TYPES.ExportDefaultDeclaration;
  /**
   * The declaration being exported.
   */
  declaration: DefaultExportDeclarations;
  /**
   * The kind of the export. Always `value` for default exports.
   */
  exportKind: "value";
}
export interface ExportDefaultDeclaration {
  parent: BlockStatement | Program | TSModuleBlock;
}
export type ExportKind = ExportAndImportKind;
export type ExportNamedDeclaration =
  | ExportNamedDeclarationWithoutSourceWithMultiple
  | ExportNamedDeclarationWithoutSourceWithSingle
  | ExportNamedDeclarationWithSource;
export interface ExportNamedDeclarationBase extends BaseNode {
  type: AST_NODE_TYPES.ExportNamedDeclaration;
  /**
   * The assertions declared for the export.
   * @example
   * ```ts
   * export { foo } from 'mod' assert \{ type: 'json' \};
   * ```
   * This will be an empty array if `source` is `null`
   * @deprecated Replaced with {@link `attributes`}.
   */
  assertions: ImportAttribute[];
  /**
   * The attributes declared for the export.
   * @example
   * ```ts
   * export { foo } from 'mod' with \{ type: 'json' \};
   * ```
   * This will be an empty array if `source` is `null`
   */
  attributes: ImportAttribute[];
  /**
   * The exported declaration.
   * @example
   * ```ts
   * export const x = 1;
   * ```
   * This will be `null` if `source` is not `null`, or if there are `specifiers`
   */
  declaration: NamedExportDeclarations | null;
  /**
   * The kind of the export.
   */
  exportKind: ExportKind;
  /**
   * The source module being exported from.
   */
  source: StringLiteral | null;
  /**
   * The specifiers being exported.
   * @example
   * ```ts
   * export { a, b };
   * ```
   * This will be an empty array if `declaration` is not `null`
   */
  specifiers: ExportSpecifier[];
}
export interface ExportNamedDeclarationWithSource extends ExportNamedDeclarationBase {
  declaration: null;
  source: StringLiteral;
}
export interface ExportNamedDeclarationWithSource {
  parent: BlockStatement | Program | TSModuleBlock;
}
export type ExportNamedDeclarationWithoutSource =
  | ExportNamedDeclarationWithoutSourceWithMultiple
  | ExportNamedDeclarationWithoutSourceWithSingle;
/**
 * Exporting names from the current module.
 * ```
 * export {};
 * export { a, b };
 * ```
 */
