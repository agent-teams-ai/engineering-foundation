// Adapted from typescript-eslint 8.59.1 (MIT). See THIRD_PARTY_NOTICES.md and eslint-syntax-provenance.json.
import type * as TSESTree from "../ast.js";

import * as ASTUtils from "../source-helpers.js";
import { AST_NODE_TYPES } from "../ast.js";

import * as util from "../helpers/index.js";

type Options = [
  {
    allow?: string[];
    allowAsImport?: boolean;
  },
];
type MessageIds = "noRequireImports";

export default util.createRule<Options, MessageIds>({
  name: "no-require-imports",
  meta: {
    type: "problem",
    docs: {
      description: "Disallow invocation of `require()`",
      recommended: "recommended",
    },
    messages: {
      noRequireImports: "A `require()` style import is forbidden.",
    },
    schema: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          allow: {
            type: "array",
            description: "Patterns of import paths to allow requiring from.",
            items: { type: "string" },
          },
          allowAsImport: {
            type: "boolean",
            description: "Allows `require` statements in import declarations.",
          },
        },
      },
    ],
  },
  defaultOptions: [{ allow: [], allowAsImport: false }],
  create(context, options) {
    const allowAsImport = options[0].allowAsImport;
    const allowPatterns = options[0].allow?.map((pattern) => new RegExp(pattern, "u"));
    function isImportPathAllowed(importPath: string): boolean {
      return allowPatterns?.some((pattern) => importPath.match(pattern)) ?? false;
    }

    return {
      'CallExpression[callee.name="require"]'(node: TSESTree.CallExpression): void {
        if (node.arguments[0] && isStringOrTemplateLiteral(node.arguments[0])) {
          const argValue = util.getStaticStringValue(node.arguments[0]);
          if (typeof argValue === "string" && isImportPathAllowed(argValue)) {
            return;
          }
        }
        const variable = ASTUtils.findVariable(context.sourceCode.getScope(node), "require");
        // ignore non-global require usage as it's something user-land custom instead
        // of the commonjs standard
        if ((variable?.identifiers.length ?? 0) === 0) {
          context.report({
            node,
            messageId: "noRequireImports",
          });
        }
      },
      TSExternalModuleReference(node): void {
        if (isStringOrTemplateLiteral(node.expression)) {
          const argValue = util.getStaticStringValue(node.expression);
          if (typeof argValue === "string" && isImportPathAllowed(argValue)) {
            return;
          }
        }
        if (
          allowAsImport === true &&
          node.parent.type === AST_NODE_TYPES.TSImportEqualsDeclaration
        ) {
          return;
        }
        context.report({
          node,
          messageId: "noRequireImports",
        });
      },
    };
  },
});

function isStringOrTemplateLiteral(node: TSESTree.Node): boolean {
  return (
    (node.type === AST_NODE_TYPES.Literal && typeof node.value === "string") ||
    node.type === AST_NODE_TYPES.TemplateLiteral
  );
}
