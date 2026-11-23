// Adapted from typescript-eslint 8.59.1 (MIT). See THIRD_PARTY_NOTICES.md and eslint-syntax-provenance.json.
import type * as TSESTree from "../ast.js";
import { AST_NODE_TYPES } from "../ast.js";

import { createRule } from "../helpers/index.js";
import { unusedExpressionCore as baseRule } from "../unused-expression-core.js";
import type { MessageIds, Options } from "../unused-expression-core.js";
export type { MessageIds, Options } from "../unused-expression-core.js";

const defaultOptions: Options = [
  {
    allowShortCircuit: false,
    allowTaggedTemplates: false,
    allowTernary: false,
  },
];

export default createRule<Options, MessageIds>({
  name: "no-unused-expressions",
  meta: {
    type: "suggestion",
    defaultOptions,
    docs: {
      description: "Disallow unused expressions",
      extendsBaseRule: true,
      recommended: "recommended",
    },
    messages: baseRule.meta.messages,
    schema: baseRule.meta.schema,
  },
  defaultOptions,
  create(context, [{ allowShortCircuit = false, allowTernary = false }]) {
    const rules = baseRule.create(context);

    function isValidExpression(node: TSESTree.Node): boolean {
      if (allowShortCircuit && node.type === AST_NODE_TYPES.LogicalExpression) {
        return isValidExpression(node.right);
      }
      if (allowTernary && node.type === AST_NODE_TYPES.ConditionalExpression) {
        return isValidExpression(node.alternate) && isValidExpression(node.consequent);
      }
      return (
        (node.type === AST_NODE_TYPES.ChainExpression &&
          node.expression.type === AST_NODE_TYPES.CallExpression) ||
        node.type === AST_NODE_TYPES.ImportExpression
      );
    }

    return {
      ExpressionStatement(node): void {
        if (
          (typeof node.directive === "string" && node.directive.length > 0) ||
          isValidExpression(node.expression)
        ) {
          return;
        }

        const expressionType = node.expression.type;

        if (
          expressionType === AST_NODE_TYPES.TSInstantiationExpression ||
          expressionType === AST_NODE_TYPES.TSAsExpression ||
          expressionType === AST_NODE_TYPES.TSNonNullExpression ||
          expressionType === AST_NODE_TYPES.TSTypeAssertion
        ) {
          rules.ExpressionStatement({
            ...node,
            expression: node.expression.expression,
          });
          return;
        }

        rules.ExpressionStatement(node);
      },
    };
  },
});
