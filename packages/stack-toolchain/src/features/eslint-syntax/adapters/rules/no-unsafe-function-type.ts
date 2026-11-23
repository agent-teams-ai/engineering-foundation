// Adapted from typescript-eslint 8.59.1 (MIT). See THIRD_PARTY_NOTICES.md and eslint-syntax-provenance.json.
import type * as TSESTree from "../ast.js";

import { AST_NODE_TYPES } from "../ast.js";

import { createRule, isReferenceToGlobalFunction } from "../helpers/index.js";

export default createRule({
  name: "no-unsafe-function-type",
  meta: {
    type: "problem",
    docs: {
      description: "Disallow using the unsafe built-in Function type",
      recommended: "recommended",
    },
    messages: {
      bannedFunctionType: [
        "The `Function` type accepts any function-like value.",
        "Prefer explicitly defining any function parameters and return type.",
      ].join("\n"),
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    function checkBannedTypes(node: TSESTree.Node): void {
      if (
        node.type === AST_NODE_TYPES.Identifier &&
        node.name === "Function" &&
        isReferenceToGlobalFunction("Function", node, context.sourceCode)
      ) {
        context.report({
          node,
          messageId: "bannedFunctionType",
        });
      }
    }

    return {
      TSClassImplements(node): void {
        checkBannedTypes(node.expression);
      },
      TSInterfaceHeritage(node): void {
        checkBannedTypes(node.expression);
      },
      TSTypeReference(node): void {
        checkBannedTypes(node.typeName);
      },
    };
  },
});
