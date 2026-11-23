import { isNullish } from "../source-helpers.js";
// Adapted from typescript-eslint 8.59.1 (MIT). See THIRD_PARTY_NOTICES.md and eslint-syntax-provenance.json.
import type * as TSESLint from "../rule-contract.js";
import type * as TSESTree from "../ast.js";

import { AST_NODE_TYPES } from "../ast.js";

import { createRule } from "../helpers/index.js";

export type Options = [
  {
    fixToUnknown?: boolean;
    ignoreRestArgs?: boolean;
  },
];
export type MessageIds = "suggestNever" | "suggestPropertyKey" | "suggestUnknown" | "unexpectedAny";

export default createRule<Options, MessageIds>({
  name: "no-explicit-any",
  meta: {
    type: "suggestion",
    docs: {
      description: "Disallow the `any` type",
      recommended: "recommended",
    },
    fixable: "code",
    hasSuggestions: true,
    messages: {
      suggestNever:
        "Use `never` instead, this is useful when instantiating generic type parameters that you don't need to know the type of.",
      suggestPropertyKey: "Use `PropertyKey` instead, this is more explicit than `keyof any`.",
      suggestUnknown:
        "Use `unknown` instead, this will force you to explicitly, and safely assert the type is correct.",
      unexpectedAny: "Unexpected any. Specify a different type.",
    },
    schema: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          fixToUnknown: {
            type: "boolean",
            description:
              "Whether to enable auto-fixing in which the `any` type is converted to the `unknown` type.",
          },
          ignoreRestArgs: {
            type: "boolean",
            description: "Whether to ignore rest parameter arrays.",
          },
        },
      },
    ],
  },
  defaultOptions: [
    {
      fixToUnknown: false,
      ignoreRestArgs: false,
    },
  ],
  create(context, [{ fixToUnknown, ignoreRestArgs }]) {
    /**
     * Checks if the node is an arrow function, function/constructor declaration or function expression
     * @param node the node to be validated.
     * @returns true if the node is any kind of function declaration or expression
     * @private
     */

    /**
     * Checks if the node is a rest element child node of a function
     * @param node the node to be validated.
     * @returns true if the node is a rest element child node of a function
     * @private
     */
    function isNodeRestElementInFunction(node: TSESTree.Node): boolean {
      return node.type === AST_NODE_TYPES.RestElement && isNodeValidFunction(node.parent);
    }

    /**
     * Checks if the node is a TSTypeOperator node with a readonly operator
     * @param node the node to be validated.
     * @returns true if the node is a TSTypeOperator node with a readonly operator
     * @private
     */

    /**
     * Checks if the node is a TSTypeReference node with an Array identifier
     * @param node the node to be validated.
     * @returns true if the node is a TSTypeReference node with an Array identifier
     * @private
     */

    /**
     * Checks if the node is a valid TSTypeOperator or TSTypeReference node
     * @param node the node to be validated.
     * @returns true if the node is a valid TSTypeOperator or TSTypeReference node
     * @private
     */
    function isNodeValidTSType(node: TSESTree.Node): boolean {
      return isNodeReadonlyTSTypeOperator(node) || isNodeValidArrayTSTypeReference(node);
    }

    /**
     * Checks if the great grand-parent node is a RestElement node in a function
     * @param node the node to be validated.
     * @returns true if the great grand-parent node is a RestElement node in a function
     * @private
     */
    function isGreatGrandparentRestElement(node: TSESTree.Node): boolean {
      return (
        !isNullish(node.parent?.parent?.parent) &&
        isNodeRestElementInFunction(node.parent.parent.parent)
      );
    }

    /**
     * Checks if the great great grand-parent node is a valid RestElement node in a function
     * @param node the node to be validated.
     * @returns true if the great great grand-parent node is a valid RestElement node in a function
     * @private
     */
    function isGreatGreatGrandparentRestElement(node: TSESTree.Node): boolean {
      return (
        !isNullish(node.parent?.parent?.parent?.parent) &&
        isNodeValidTSType(node.parent.parent) &&
        isNodeRestElementInFunction(node.parent.parent.parent.parent)
      );
    }

    /**
     * Checks if the great grand-parent or the great great grand-parent node is a RestElement node
     * @param node the node to be validated.
     * @returns true if the great grand-parent or the great great grand-parent node is a RestElement node
     * @private
     */
    function isNodeDescendantOfRestElementInFunction(node: TSESTree.Node): boolean {
      return isGreatGrandparentRestElement(node) || isGreatGreatGrandparentRestElement(node);
    }

    /**
     * Checks if the node is within a keyof any expression
     * @param node the node to be validated.
     * @returns true if the node is within a keyof any expression, false otherwise
     * @private
     */

    /**
     * Creates a fixer that replaces a keyof any with PropertyKey
     * @param node the node to be fixed.
     * @returns a function that will fix the node.
     * @private
     */

    return {
      TSAnyKeyword(node): void {
        const isKeyofAny = isNodeWithinKeyofAny(node);

        if (ignoreRestArgs === true && isNodeDescendantOfRestElementInFunction(node)) {
          return;
        }

        const fixOrSuggest: {
          fix: TSESLint.ReportFixFunction | null;
          suggest: TSESLint.ReportSuggestionArray<MessageIds> | null;
        } = {
          fix: null,
          suggest: isKeyofAny
            ? [
                {
                  messageId: "suggestPropertyKey",
                  fix: createPropertyKeyFixer(node),
                },
              ]
            : [
                {
                  messageId: "suggestUnknown",
                  fix: (fixer) => fixer.replaceText(node, "unknown"),
                },
                {
                  messageId: "suggestNever",
                  fix: (fixer) => fixer.replaceText(node, "never"),
                },
              ],
        };

        if (fixToUnknown === true) {
          fixOrSuggest.fix = isKeyofAny
            ? createPropertyKeyFixer(node)
            : (fixer) => fixer.replaceText(node, "unknown");
        }

        context.report({
          node,
          messageId: "unexpectedAny",
          ...fixOrSuggest,
        });
      },
    };
  },
});

function isNodeValidFunction(node: TSESTree.Node): boolean {
  return [
    AST_NODE_TYPES.ArrowFunctionExpression, // const x = (...args: any[]) => {};
    AST_NODE_TYPES.FunctionDeclaration, // function f(...args: any[]) {}
    AST_NODE_TYPES.FunctionExpression, // const x = function(...args: any[]) {};
    AST_NODE_TYPES.TSCallSignatureDeclaration, // type T = {(...args: any[]): unknown};
    AST_NODE_TYPES.TSConstructorType, // type T = new (...args: any[]) => unknown
    AST_NODE_TYPES.TSConstructSignatureDeclaration, // type T = {new (...args: any[]): unknown};
    AST_NODE_TYPES.TSDeclareFunction, // declare function _8(...args: any[]): unknown;
    AST_NODE_TYPES.TSEmptyBodyFunctionExpression, // declare class A { f(...args: any[]): unknown; }
    AST_NODE_TYPES.TSFunctionType, // type T = (...args: any[]) => unknown;
    AST_NODE_TYPES.TSMethodSignature, // type T = {f(...args: any[]): unknown};
  ].includes(node.type);
}

function isNodeReadonlyTSTypeOperator(node: TSESTree.Node): boolean {
  return node.type === AST_NODE_TYPES.TSTypeOperator && node.operator === "readonly";
}

function isNodeValidArrayTSTypeReference(node: TSESTree.Node): boolean {
  return (
    node.type === AST_NODE_TYPES.TSTypeReference &&
    node.typeName.type === AST_NODE_TYPES.Identifier &&
    ["Array", "ReadonlyArray"].includes(node.typeName.name)
  );
}

function isNodeWithinKeyofAny(node: TSESTree.TSAnyKeyword): boolean {
  return node.parent.type === AST_NODE_TYPES.TSTypeOperator && node.parent.operator === "keyof";
}

function createPropertyKeyFixer(node: TSESTree.TSAnyKeyword) {
  return (fixer: TSESLint.RuleFixer) => {
    return fixer.replaceText(node.parent, "PropertyKey");
  };
}
