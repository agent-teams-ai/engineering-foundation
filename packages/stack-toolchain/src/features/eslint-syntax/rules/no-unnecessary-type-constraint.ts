// Adapted from typescript-eslint 8.59.1 (MIT). See THIRD_PARTY_NOTICES.md and eslint-syntax-provenance.json.
import type * as TSESLint from "../rule-contract.js";
import type * as TSESTree from "../ast.js";

import { AST_NODE_TYPES } from "../ast.js";
import { extname } from "node:path";

import type { MakeRequired } from "../helpers/index.js";

import { createRule, nullThrows } from "../helpers/index.js";

type TypeParameterWithConstraint = MakeRequired<TSESTree.TSTypeParameter, "constraint">;

export default createRule({
  name: "no-unnecessary-type-constraint",
  meta: {
    type: "suggestion",
    docs: {
      description: "Disallow unnecessary constraints on generic types",
      recommended: "recommended",
    },
    hasSuggestions: true,
    messages: {
      removeUnnecessaryConstraint: "Remove the unnecessary `{{constraint}}` constraint.",
      unnecessaryConstraint:
        "Constraining the generic type `{{name}}` to `{{constraint}}` does nothing and is unnecessary.",
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    // In theory, we could use the type checker for more advanced constraint types...
    // ...but in practice, these types are rare, and likely not worth requiring type info.
    // https://github.com/typescript-eslint/typescript-eslint/pull/2516#discussion_r495731858
    const unnecessaryConstraints = new Map([
      [AST_NODE_TYPES.TSAnyKeyword, "any"],
      [AST_NODE_TYPES.TSUnknownKeyword, "unknown"],
    ]);

    const requiresGenericDeclarationDisambiguation = checkRequiresGenericDeclarationDisambiguation(
      context.filename,
    );

    const checkNode = (node: TypeParameterWithConstraint, inArrowFunction: boolean): void => {
      const constraint = unnecessaryConstraints.get(node.constraint.type);
      function shouldAddTrailingComma(): boolean {
        if (!inArrowFunction || !requiresGenericDeclarationDisambiguation) {
          return false;
        }
        // Only <T>() => {} would need trailing comma
        return (
          (node.parent as TSESTree.TSTypeParameterDeclaration).params.length === 1 &&
          nullThrows(
            context.sourceCode.getTokensAfter(node)[0],
            "Type parameter must have a following token.",
          ).value !== "," &&
          !node.default
        );
      }

      if (constraint) {
        context.report({
          node,
          messageId: "unnecessaryConstraint",
          data: {
            name: node.name.name,
            constraint,
          },
          suggest: [
            {
              messageId: "removeUnnecessaryConstraint",
              data: {
                constraint,
              },
              fix(fixer): TSESLint.RuleFix | null {
                return fixer.replaceTextRange(
                  [node.name.range[1], node.constraint.range[1]],
                  shouldAddTrailingComma() ? "," : "",
                );
              },
            },
          ],
        });
      }
    };

    return {
      ":not(ArrowFunctionExpression) > TSTypeParameterDeclaration > TSTypeParameter[constraint]"(
        node: TypeParameterWithConstraint,
      ): void {
        checkNode(node, false);
      },
      "ArrowFunctionExpression > TSTypeParameterDeclaration > TSTypeParameter[constraint]"(
        node: TypeParameterWithConstraint,
      ): void {
        checkNode(node, true);
      },
    };
  },
});

function checkRequiresGenericDeclarationDisambiguation(filename: string): boolean {
  const pathExt = extname(filename).toLocaleLowerCase();
  switch (pathExt) {
    case ".cts":
    case ".mts":
    case ".tsx":
      return true;

    default:
      return false;
  }
}
