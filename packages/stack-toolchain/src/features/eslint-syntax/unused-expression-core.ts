// Typed extraction of ESLint 10.3.0 no-unused-expressions (MIT).
// Source and helper provenance are recorded in eslint-syntax-provenance.json.
import type { RulesMeta } from "@eslint/core";
import type * as TSESTree from "./ast.js";
import type { RuleContext } from "./rule-contract.js";
import { isFunction } from "./source-helpers.js";

export type MessageIds = "unusedExpression";
export type Options = [{
  allowShortCircuit?: boolean;
  allowTernary?: boolean;
  allowTaggedTemplates?: boolean;
  enforceForJSX?: boolean;
  ignoreDirectives?: boolean;
}];

function isDirectivePrologue(node: TSESTree.ExpressionStatement): boolean {
  const parent = node.parent;
  if (!(parent.type === "Program" || parent.type === "TSModuleBlock" ||
    (parent.type === "BlockStatement" && isFunction(parent.parent)))) return false;
  for (const sibling of parent.body) {
    if (sibling.type !== "ExpressionStatement" || sibling.expression.type !== "Literal" || typeof sibling.expression.value !== "string") return false;
    if (sibling === node) return true;
  }
  return false;
}

const meta = {
  type: "suggestion",
  schema: [{
    type: "object",
    properties: {
      allowShortCircuit: { type: "boolean" },
      allowTernary: { type: "boolean" },
      allowTaggedTemplates: { type: "boolean" },
      enforceForJSX: { type: "boolean" },
      ignoreDirectives: { type: "boolean" },
    },
    additionalProperties: false,
  }],
  messages: {
    unusedExpression: "Expected an assignment or function call and instead saw an expression.",
  },
} satisfies RulesMeta<MessageIds, Options>;

export const unusedExpressionCore = {
  meta,
  create(context: RuleContext<MessageIds, Options>): { ExpressionStatement(node: TSESTree.ExpressionStatement): void } {
    const [{ allowShortCircuit, allowTernary, allowTaggedTemplates, enforceForJSX, ignoreDirectives }] = context.options;

    function isDisallowed(node: TSESTree.Node): boolean {
      switch (node.type) {
        case "ArrayExpression":
        case "ArrowFunctionExpression":
        case "BinaryExpression":
        case "ClassExpression":
        case "FunctionExpression":
        case "Identifier":
        case "Literal":
        case "MemberExpression":
        case "MetaProperty":
        case "ObjectExpression":
        case "SequenceExpression":
        case "TemplateLiteral":
        case "ThisExpression":
          return true;
        case "ChainExpression":
        case "TSAsExpression":
        case "TSTypeAssertion":
        case "TSNonNullExpression":
        case "TSInstantiationExpression":
          return isDisallowed(node.expression);
        case "ConditionalExpression":
          return allowTernary ? isDisallowed(node.consequent) || isDisallowed(node.alternate) : true;
        case "LogicalExpression":
          return allowShortCircuit ? isDisallowed(node.right) : true;
        case "JSXElement":
        case "JSXFragment":
          return enforceForJSX === true;
        case "TaggedTemplateExpression":
          return !allowTaggedTemplates;
        case "UnaryExpression":
          return node.operator !== "void" && node.operator !== "delete";
        default:
          return false;
      }
    }

    return {
      ExpressionStatement(node) {
        if (isDisallowed(node.expression) && typeof node.directive !== "string" && !(ignoreDirectives && isDirectivePrologue(node))) {
          context.report({ node, messageId: "unusedExpression" });
        }
      },
    };
  },
};
