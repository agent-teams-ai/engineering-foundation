// Adapted from typescript-eslint 8.59.1 (MIT). See THIRD_PARTY_NOTICES.md and eslint-syntax-provenance.json.
import type * as TSESTree from "../ast.js";

import { AST_NODE_TYPES } from "../ast.js";

/**
 * Recursively checks whether a given reference has a type query declaration among its parents
 */
export function referenceContainsTypeQuery(node: TSESTree.Node): boolean {
  if (node.type === AST_NODE_TYPES.TSTypeQuery) {
    return true;
  }
  if (node.type === AST_NODE_TYPES.TSQualifiedName || node.type === AST_NODE_TYPES.Identifier) {
    return referenceContainsTypeQuery(node.parent);
  }
  // if we find a different node, there's no chance that we're in a TSTypeQuery
  return false;
}
