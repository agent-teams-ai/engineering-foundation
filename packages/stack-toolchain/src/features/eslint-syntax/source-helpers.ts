// Selected typescript-eslint 8.59.1 MIT helpers; see the provenance ledger.
import type { Scope, ScopeVariable } from "./scope-runtime.js";
import type * as TSESTree from "./ast.js";
import { AST_NODE_TYPES, AST_TOKEN_TYPES } from "./ast.js";
import type { SourceCode } from "./rule-contract.js";
import { escapeRegExp } from "./helpers/escapeRegExp.js";

export const NullThrowsReasons = {
  MissingParent: "Expected node to have a parent.",
  MissingToken: (token: string, thing: string) => `Expected to find a ${token} for the ${thing}.`,
} as const;

export function nullThrows<T>(value: T, message: string): NonNullable<T> {
  if (value == null) throw new Error(`Non-null Assertion Failed: ${message}`);
  return value;
}

export function isFunction(node: TSESTree.Node | null | undefined): node is TSESTree.ArrowFunctionExpression | TSESTree.FunctionDeclaration | TSESTree.FunctionExpression {
  return node?.type === AST_NODE_TYPES.ArrowFunctionExpression || node?.type === AST_NODE_TYPES.FunctionDeclaration || node?.type === AST_NODE_TYPES.FunctionExpression;
}

export function isLoop(node: TSESTree.Node | null | undefined): node is TSESTree.DoWhileStatement | TSESTree.ForStatement | TSESTree.ForInStatement | TSESTree.ForOfStatement | TSESTree.WhileStatement {
  return node?.type === AST_NODE_TYPES.DoWhileStatement || node?.type === AST_NODE_TYPES.ForStatement || node?.type === AST_NODE_TYPES.ForInStatement || node?.type === AST_NODE_TYPES.ForOfStatement || node?.type === AST_NODE_TYPES.WhileStatement;
}

export function isOpeningParenToken(token: TSESTree.Token | null | undefined): token is TSESTree.PunctuatorToken {
  return token?.type === AST_TOKEN_TYPES.Punctuator && token.value === "(";
}

export function isClosingParenToken(token: TSESTree.Token | null | undefined): token is TSESTree.PunctuatorToken {
  return token?.type === AST_TOKEN_TYPES.Punctuator && token.value === ")";
}

/** String-name case of the public upstream scope lookup helper. */
export function findVariable(initial: Scope, name: string): ScopeVariable | null {
  let scope: Scope | null = initial;
  while (scope) {
    const variable = scope.set.get(name);
    if (variable) return variable;
    scope = scope.upper;
  }
  return null;
}

export function isReferenceToGlobalFunction(calleeName: string, node: TSESTree.Node, sourceCode: SourceCode): boolean {
  const reference = sourceCode.getScope(node).references.find((ref) => ref.identifier.name === calleeName);
  return !reference?.resolved?.defs.length;
}

export function isDefinitionFile(fileName: string): boolean {
  const lowerFileName = fileName.toLowerCase();
  return [".d.ts", ".d.cts", ".d.mts"].some((extension) => lowerFileName.endsWith(extension)) || /\.d\.(ts|cts|mts|.*\.ts)$/.test(lowerFileName);
}

export function getNameLocationInGlobalDirectiveComment(sourceCode: SourceCode, comment: TSESTree.Comment, name: string): TSESTree.SourceLocation {
  const namePattern = new RegExp(`[\\s,]${escapeRegExp(name)}(?:$|[\\s,:])`, "gu");
  namePattern.lastIndex = comment.value.indexOf("global") + 6;
  const match = namePattern.exec(comment.value);
  const start = sourceCode.getLocFromIndex(comment.range[0] + "/*".length + (match ? match.index + 1 : 0));
  const end = { column: start.column + (match ? name.length : 1), line: start.line };
  return { end, start };
}
