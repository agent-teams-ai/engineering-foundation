// Typed extraction of ESLint 10.3.0 no-unused-expressions (MIT).
// Source and helper provenance are recorded in eslint-syntax-provenance.json.
import type { RulesMeta } from "@eslint/core";
import type * as TSESTree from "./ast.js";
import { AST_NODE_TYPES } from "./ast.js";
import type { RuleContext } from "./rule-contract.js";
import { isFunction } from "./source-helpers.js";

export type MessageIds = "unusedExpression";
export type Options = [
  {
    allowShortCircuit?: boolean;
    allowTernary?: boolean;
    allowTaggedTemplates?: boolean;
    enforceForJSX?: boolean;
    ignoreDirectives?: boolean;
  },
];

function isDirectivePrologue(node: TSESTree.ExpressionStatement): boolean {
  const parent = node.parent;
  if (
    !(
      parent.type === AST_NODE_TYPES.Program ||
      parent.type === AST_NODE_TYPES.TSModuleBlock ||
      (parent.type === AST_NODE_TYPES.BlockStatement && isFunction(parent.parent))
    )
  ) {
    return false;
  }
  for (const sibling of parent.body) {
    if (
      sibling.type !== AST_NODE_TYPES.ExpressionStatement ||
      sibling.expression.type !== AST_NODE_TYPES.Literal ||
      typeof sibling.expression.value !== "string"
    ) {
      return false;
    }
    if (sibling === node) {
      return true;
    }
  }
  return false;
}

const meta = {
  type: "suggestion",
  schema: [
    {
      type: "object",
      properties: {
        allowShortCircuit: { type: "boolean" },
        allowTernary: { type: "boolean" },
        allowTaggedTemplates: { type: "boolean" },
        enforceForJSX: { type: "boolean" },
        ignoreDirectives: { type: "boolean" },
      },
      additionalProperties: false,
    },
  ],
  messages: {
    unusedExpression: "Expected an assignment or function call and instead saw an expression.",
  },
} satisfies RulesMeta<MessageIds, Options>;

const alwaysDisallowed = new Set([
  "ArrayExpression",
  "ArrowFunctionExpression",
  "BinaryExpression",
  "ClassExpression",
  "FunctionExpression",
  "Identifier",
  "Literal",
  "MemberExpression",
  "MetaProperty",
  "ObjectExpression",
  "SequenceExpression",
  "TemplateLiteral",
  "ThisExpression",
]);

export const unusedExpressionCore = {
  meta,
  create(context: RuleContext<MessageIds, Options>): {
    ExpressionStatement(node: TSESTree.ExpressionStatement): void;
  } {
    const [
      { allowShortCircuit, allowTernary, allowTaggedTemplates, enforceForJSX, ignoreDirectives },
    ] = context.options;

    function isDisallowed(node: TSESTree.Node): boolean {
      if (alwaysDisallowed.has(node.type)) {
        return true;
      }
      if (
        node.type === AST_NODE_TYPES.ChainExpression ||
        node.type === AST_NODE_TYPES.TSAsExpression ||
        node.type === AST_NODE_TYPES.TSTypeAssertion ||
        node.type === AST_NODE_TYPES.TSNonNullExpression ||
        node.type === AST_NODE_TYPES.TSInstantiationExpression
      ) {
        return isDisallowed(node.expression);
      }
      if (node.type === AST_NODE_TYPES.ConditionalExpression) {
        return allowTernary === true
          ? isDisallowed(node.consequent) || isDisallowed(node.alternate)
          : true;
      }
      if (node.type === AST_NODE_TYPES.LogicalExpression) {
        return allowShortCircuit === true ? isDisallowed(node.right) : true;
      }
      if (node.type === AST_NODE_TYPES.JSXElement || node.type === AST_NODE_TYPES.JSXFragment) {
        return enforceForJSX === true;
      }
      if (node.type === AST_NODE_TYPES.TaggedTemplateExpression) {
        return allowTaggedTemplates !== true;
      }
      if (node.type === AST_NODE_TYPES.UnaryExpression) {
        return node.operator !== "void" && node.operator !== "delete";
      }
      return false;
    }

    return {
      ExpressionStatement(node) {
        if (
          isDisallowed(node.expression) &&
          typeof node.directive !== "string" &&
          !(ignoreDirectives === true && isDirectivePrologue(node))
        ) {
          context.report({ node, messageId: "unusedExpression" });
        }
      },
    };
  },
};
