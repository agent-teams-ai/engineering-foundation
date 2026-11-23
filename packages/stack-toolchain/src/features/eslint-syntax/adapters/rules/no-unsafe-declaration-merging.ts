import { isNullish } from "../source-helpers.js";
// Adapted from typescript-eslint 8.59.1 (MIT). See THIRD_PARTY_NOTICES.md and eslint-syntax-provenance.json.
import type { Scope } from "../scope-runtime.js";
import type * as TSESTree from "../ast.js";

import { AST_NODE_TYPES } from "../ast.js";

import { createRule } from "../helpers/index.js";

export default createRule({
  name: "no-unsafe-declaration-merging",
  meta: {
    type: "problem",
    docs: {
      description: "Disallow unsafe declaration merging",
      recommended: "recommended",
      requiresTypeChecking: false,
    },
    messages: {
      unsafeMerging: "Unsafe declaration merging between classes and interfaces.",
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    function checkUnsafeDeclaration(
      scope: Scope,
      node: TSESTree.Identifier,
      unsafeKind: AST_NODE_TYPES,
    ): void {
      const variable = scope.set.get(node.name);
      if (!variable) {
        return;
      }

      const defs = variable.defs;
      if (defs.length <= 1) {
        return;
      }

      if (defs.some((def) => def.node.type === unsafeKind)) {
        context.report({
          node,
          messageId: "unsafeMerging",
        });
      }
    }

    return {
      ClassDeclaration(node): void {
        if (node.id) {
          // by default eslint returns the inner class scope for the ClassDeclaration node
          // but we want the outer scope within which merged variables will sit
          const currentScope = context.sourceCode.getScope(node).upper;
          if (isNullish(currentScope)) {
            return;
          }

          checkUnsafeDeclaration(currentScope, node.id, AST_NODE_TYPES.TSInterfaceDeclaration);
        }
      },
      TSInterfaceDeclaration(node): void {
        checkUnsafeDeclaration(
          context.sourceCode.getScope(node),
          node.id,
          AST_NODE_TYPES.ClassDeclaration,
        );
      },
    };
  },
});
