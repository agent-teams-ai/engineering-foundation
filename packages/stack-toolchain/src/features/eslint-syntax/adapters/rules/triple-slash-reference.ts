// Adapted from typescript-eslint 8.59.1 (MIT). See THIRD_PARTY_NOTICES.md and eslint-syntax-provenance.json.
import type * as TSESTree from "../ast.js";

import { AST_NODE_TYPES, AST_TOKEN_TYPES } from "../ast.js";

import { createRule, nullThrows } from "../helpers/index.js";

type Options = [
  {
    lib?: "always" | "never";
    path?: "always" | "never";
    types?: "always" | "never" | "prefer-import";
  },
];
type MessageIds = "tripleSlashReference";

export default createRule<Options, MessageIds>({
  name: "triple-slash-reference",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow certain triple slash directives in favor of ES6-style import declarations",
      recommended: "recommended",
    },
    messages: {
      tripleSlashReference:
        "Do not use a triple slash reference for {{module}}, use `import` style instead.",
    },
    schema: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          lib: {
            type: "string",
            description: 'What to enforce for `/// <reference lib="..." />` references.',
            enum: ["always", "never"],
          },
          path: {
            type: "string",
            description: 'What to enforce for `/// <reference path="..." />` references.',
            enum: ["always", "never"],
          },
          types: {
            type: "string",
            description: 'What to enforce for `/// <reference types="..." />` references.',
            enum: ["always", "never", "prefer-import"],
          },
        },
      },
    ],
  },
  defaultOptions: [
    {
      lib: "always",
      path: "never",
      types: "prefer-import",
    },
  ],
  create(context, [{ lib, path, types }]) {
    let programNode: TSESTree.Node | undefined;

    const references: {
      comment: TSESTree.Comment;
      importName: string;
    }[] = [];

    function hasMatchingReference(source: TSESTree.Literal): void {
      references.forEach((reference) => {
        if (reference.importName === source.value) {
          context.report({
            node: reference.comment,
            messageId: "tripleSlashReference",
            data: {
              module: reference.importName,
            },
          });
        }
      });
    }
    return {
      ImportDeclaration(node): void {
        if (programNode) {
          hasMatchingReference(node.source);
        }
      },
      Program(node): void {
        if (lib === "always" && path === "always" && types === "always") {
          return;
        }
        programNode = node;
        const referenceRegExp = /^\/\s*<reference\s*(types|path|lib)\s*=\s*["|'](.*)["|']/;
        const commentsBefore = context.sourceCode.getCommentsBefore(programNode);

        commentsBefore.forEach((comment) => {
          if (comment.type !== AST_TOKEN_TYPES.Line) {
            return;
          }
          const referenceResult = referenceRegExp.exec(comment.value);

          if (referenceResult) {
            if (
              (referenceResult[1] === "types" && types === "never") ||
              (referenceResult[1] === "path" && path === "never") ||
              (referenceResult[1] === "lib" && lib === "never")
            ) {
              context.report({
                node: comment,
                messageId: "tripleSlashReference",
                data: {
                  module: referenceResult[2],
                },
              });
              return;
            }
            if (referenceResult[1] === "types" && types === "prefer-import") {
              references.push({
                comment,
                importName: nullThrows(
                  referenceResult[2],
                  "Matched reference must contain its import name.",
                ),
              });
            }
          }
        });
      },
      TSImportEqualsDeclaration(node): void {
        if (programNode) {
          const reference = node.moduleReference;

          if (reference.type === AST_NODE_TYPES.TSExternalModuleReference) {
            hasMatchingReference(reference.expression);
          }
        }
      },
    };
  },
});
