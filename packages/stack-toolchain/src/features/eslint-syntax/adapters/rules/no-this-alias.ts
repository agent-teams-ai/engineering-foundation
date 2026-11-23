// Adapted from typescript-eslint 8.59.1 (MIT). See THIRD_PARTY_NOTICES.md and eslint-syntax-provenance.json.
import type * as TSESTree from "../ast.js";

import { AST_NODE_TYPES } from "../ast.js";

import { createRule } from "../helpers/index.js";

export type Options = [
  {
    allowDestructuring?: boolean;
    allowedNames?: string[];
  },
];
export type MessageIds = "thisAssignment" | "thisDestructure";

export default createRule<Options, MessageIds>({
  name: "no-this-alias",
  meta: {
    type: "suggestion",
    docs: {
      description: "Disallow aliasing `this`",
      recommended: "recommended",
    },
    messages: {
      thisAssignment: "Unexpected aliasing of 'this' to local variable.",
      thisDestructure: "Unexpected aliasing of members of 'this' to local variables.",
    },
    schema: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          allowDestructuring: {
            type: "boolean",
            description:
              "Whether to ignore destructurings, such as `const { props, state } = this`.",
          },
          allowedNames: {
            type: "array",
            description: 'Names to ignore, such as ["self"] for `const self = this;`.',
            items: {
              type: "string",
            },
          },
        },
      },
    ],
  },
  defaultOptions: [
    {
      allowDestructuring: true,
      allowedNames: [],
    },
  ],
  create(context, [{ allowDestructuring, allowedNames }]) {
    return {
      "VariableDeclarator[init.type='ThisExpression'], AssignmentExpression[right.type='ThisExpression']"(
        node: TSESTree.AssignmentExpression | TSESTree.VariableDeclarator,
      ): void {
        const id = node.type === AST_NODE_TYPES.VariableDeclarator ? node.id : node.left;
        if (allowDestructuring === true && id.type !== AST_NODE_TYPES.Identifier) {
          return;
        }

        const hasAllowedName =
          id.type === AST_NODE_TYPES.Identifier
            ? // https://github.com/typescript-eslint/typescript-eslint/issues/5439

              allowedNames!.includes(id.name)
            : false;
        if (!hasAllowedName) {
          context.report({
            node: id,
            messageId: id.type === AST_NODE_TYPES.Identifier ? "thisAssignment" : "thisDestructure",
          });
        }
      },
    };
  },
});
