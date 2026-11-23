// Adapted from typescript-eslint 8.59.1 (MIT). See THIRD_PARTY_NOTICES.md and eslint-syntax-provenance.json.

import type { MessageIds, Options } from "./contracts.js";

import type { RulesMeta } from "@eslint/core";
import type { RuleDocs } from "../../rule-contract.js";

export const meta = {
  type: "problem",
  docs: {
    description: "Disallow unused variables",
    extendsBaseRule: true,
    recommended: "recommended",
  },
  fixable: "code",
  hasSuggestions: true,
  messages: {
    removeUnusedImportDeclaration: "Remove unused import declaration.",
    removeUnusedVar: 'Remove unused variable "{{varName}}".',
    unusedVar: "'{{varName}}' is {{action}} but never used{{additional}}.",
    usedIgnoredVar: "'{{varName}}' is marked as ignored but is used{{additional}}.",
    usedOnlyAsType: "'{{varName}}' is {{action}} but only used as a type{{additional}}.",
  },
  schema: [
    {
      oneOf: [
        {
          type: "string",
          description: "Broad setting for unused variables to target.",
          enum: ["all", "local"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            args: {
              type: "string",
              description: "Whether to check all, some, or no arguments.",
              enum: ["all", "after-used", "none"],
            },
            argsIgnorePattern: {
              type: "string",
              description: "Regular expressions of argument names to not check for usage.",
            },
            caughtErrors: {
              type: "string",
              description: "Whether to check catch block arguments.",
              enum: ["all", "none"],
            },
            caughtErrorsIgnorePattern: {
              type: "string",
              description:
                "Regular expressions of catch block argument names to not check for usage.",
            },
            destructuredArrayIgnorePattern: {
              type: "string",
              description:
                "Regular expressions of destructured array variable names to not check for usage.",
            },
            enableAutofixRemoval: {
              type: "object",
              additionalProperties: false,
              description: "Configurable automatic fixes for different types of unused variables.",
              properties: {
                imports: {
                  type: "boolean",
                  description: "Whether to enable automatic removal of unused imports.",
                },
              },
            },
            ignoreClassWithStaticInitBlock: {
              type: "boolean",
              description:
                "Whether to ignore classes with at least one static initialization block.",
            },
            ignoreRestSiblings: {
              type: "boolean",
              description: "Whether to ignore sibling properties in `...` destructurings.",
            },
            ignoreUsingDeclarations: {
              type: "boolean",
              description: "Whether to ignore using or await using declarations.",
            },
            reportUsedIgnorePattern: {
              type: "boolean",
              description:
                "Whether to report variables that match any of the valid ignore pattern options if they have been used.",
            },
            vars: {
              type: "string",
              description: "Whether to check all variables or only locally-declared variables.",
              enum: ["all", "local"],
            },
            varsIgnorePattern: {
              type: "string",
              description: "Regular expressions of variable names to not check for usage.",
            },
          },
        },
      ],
    },
  ],
} satisfies RulesMeta<MessageIds, Options, RuleDocs>;
