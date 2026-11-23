// Adapted from typescript-eslint 8.59.1 (MIT). See THIRD_PARTY_NOTICES.md and eslint-syntax-provenance.json.
import type * as TSESTree from "../ast.js";

import { AST_NODE_TYPES } from "../ast.js";

/**
 * Recursively checks whether a given reference is used in a type predicate (e.g., `arg is string`)
 */
export function referenceContainsTypePredicate(node: TSESTree.Node): boolean {
  switch (node.type) {
    case AST_NODE_TYPES.TSTypePredicate:
      return true;

    case AST_NODE_TYPES.TSQualifiedName:
    case AST_NODE_TYPES.Identifier:
      return referenceContainsTypePredicate(node.parent);

    default:
      return false;
  }
}
