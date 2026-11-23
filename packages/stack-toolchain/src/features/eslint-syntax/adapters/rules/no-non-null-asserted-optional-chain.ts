// Adapted from typescript-eslint 8.59.1 (MIT). See THIRD_PARTY_NOTICES.md and eslint-syntax-provenance.json.
import type * as TSESLint from "../rule-contract.js";
import type * as TSESTree from "../ast.js";

import { createRule } from "../helpers/index.js";

export default createRule({
  name: "no-non-null-asserted-optional-chain",
  meta: {
    type: "problem",
    docs: {
      description: "Disallow non-null assertions after an optional chain expression",
      recommended: "recommended",
    },
    hasSuggestions: true,
    messages: {
      noNonNullOptionalChain:
        "Optional chain expressions can return undefined by design - using a non-null assertion is unsafe and wrong.",
      suggestRemovingNonNull: "You should remove the non-null assertion.",
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      // non-nulling a wrapped chain will scrub all nulls introduced by the chain
      // (x?.y)!
      // (x?.())!
      "TSNonNullExpression > ChainExpression"(node: TSESTree.ChainExpression): void {
        // selector guarantees this assertion
        const parent = node.parent as TSESTree.TSNonNullExpression;
        context.report({
          node,
          messageId: "noNonNullOptionalChain",
          // use a suggestion instead of a fixer, because this can obviously break type checks
          suggest: [
            {
              messageId: "suggestRemovingNonNull",
              fix(fixer): TSESLint.RuleFix {
                return fixer.removeRange([parent.range[1] - 1, parent.range[1]]);
              },
            },
          ],
        });
      },

      // non-nulling at the end of a chain will scrub all nulls introduced by the chain
      // x?.y!
      // x?.()!
      "ChainExpression > TSNonNullExpression"(node: TSESTree.TSNonNullExpression): void {
        context.report({
          node,
          messageId: "noNonNullOptionalChain",
          // use a suggestion instead of a fixer, because this can obviously break type checks
          suggest: [
            {
              messageId: "suggestRemovingNonNull",
              fix(fixer): TSESLint.RuleFix {
                return fixer.removeRange([node.range[1] - 1, node.range[1]]);
              },
            },
          ],
        });
      },
    };
  },
});
