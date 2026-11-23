// Adapted from typescript-eslint 8.59.1 (MIT). See THIRD_PARTY_NOTICES.md and eslint-syntax-provenance.json.
import type * as TSESTree from "../ast.js";

import { AST_NODE_TYPES } from "../ast.js";

/**
 * Recursively checks whether a given reference is used in a type predicate (e.g., `arg is string`)
 */
export function referenceContainsTypePredicate(node: TSESTree.Node): boolean {
  if (node.type === AST_NODE_TYPES.TSTypePredicate) {
    return true;
  }
  if (node.type === AST_NODE_TYPES.TSQualifiedName || node.type === AST_NODE_TYPES.Identifier) {
    return referenceContainsTypePredicate(node.parent);
  }
  return false;
}
