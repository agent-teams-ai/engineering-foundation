import type { Plugin } from "@eslint/core";
import type { Linter } from "eslint";
import { parser } from "./parser-runtime.js";
import banTsComment from "./rules/ban-ts-comment.js";
import noArrayConstructor from "./rules/no-array-constructor.js";
import noDuplicateEnumValues from "./rules/no-duplicate-enum-values.js";
import noEmptyObjectType from "./rules/no-empty-object-type.js";
import noExplicitAny from "./rules/no-explicit-any.js";
import noExtraNonNullAssertion from "./rules/no-extra-non-null-assertion.js";
import noMisusedNew from "./rules/no-misused-new.js";
import noNamespace from "./rules/no-namespace.js";
import noNonNullAssertedOptionalChain from "./rules/no-non-null-asserted-optional-chain.js";
import noRequireImports from "./rules/no-require-imports.js";
import noThisAlias from "./rules/no-this-alias.js";
import noUnnecessaryTypeConstraint from "./rules/no-unnecessary-type-constraint.js";
import noUnsafeDeclarationMerging from "./rules/no-unsafe-declaration-merging.js";
import noUnsafeFunctionType from "./rules/no-unsafe-function-type.js";
import noUnusedExpressions from "./rules/no-unused-expressions.js";
import noUnusedVars from "./rules/no-unused-vars.js";
import noWrapperObjectTypes from "./rules/no-wrapper-object-types.js";
import preferAsConst from "./rules/prefer-as-const.js";
import preferNamespaceKeyword from "./rules/prefer-namespace-keyword.js";
import tripleSlashReference from "./rules/triple-slash-reference.js";

export { parser };

export const plugin: Plugin = {
  meta: { name: "stack-toolchain/eslint-syntax" },
  rules: {
    "ban-ts-comment": banTsComment,
    "no-array-constructor": noArrayConstructor,
    "no-duplicate-enum-values": noDuplicateEnumValues,
    "no-empty-object-type": noEmptyObjectType,
    "no-explicit-any": noExplicitAny,
    "no-extra-non-null-assertion": noExtraNonNullAssertion,
    "no-misused-new": noMisusedNew,
    "no-namespace": noNamespace,
    "no-non-null-asserted-optional-chain": noNonNullAssertedOptionalChain,
    "no-require-imports": noRequireImports,
    "no-this-alias": noThisAlias,
    "no-unnecessary-type-constraint": noUnnecessaryTypeConstraint,
    "no-unsafe-declaration-merging": noUnsafeDeclarationMerging,
    "no-unsafe-function-type": noUnsafeFunctionType,
    "no-unused-expressions": noUnusedExpressions,
    "no-unused-vars": noUnusedVars,
    "no-wrapper-object-types": noWrapperObjectTypes,
    "prefer-as-const": preferAsConst,
    "prefer-namespace-keyword": preferNamespaceKeyword,
    "triple-slash-reference": tripleSlashReference,
  },
};

export const configs: { recommended: Linter.Config[] } = {
  recommended: [
    {
      name: "stack-toolchain/eslint-syntax/base",
      languageOptions: { parser, sourceType: "module" },
      plugins: { "@typescript-eslint": plugin },
    },
    {
      name: "stack-toolchain/eslint-syntax/eslint-recommended",
      files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
      rules: {
        "constructor-super": "off",
        "getter-return": "off",
        "no-class-assign": "off",
        "no-const-assign": "off",
        "no-dupe-args": "off",
        "no-dupe-class-members": "off",
        "no-dupe-keys": "off",
        "no-func-assign": "off",
        "no-import-assign": "off",
        "no-new-native-nonconstructor": "off",
        "no-new-symbol": "off",
        "no-obj-calls": "off",
        "no-redeclare": "off",
        "no-setter-return": "off",
        "no-this-before-super": "off",
        "no-undef": "off",
        "no-unreachable": "off",
        "no-unsafe-negation": "off",
        "no-var": "error",
        "no-with": "off",
        "prefer-const": "error",
        "prefer-rest-params": "error",
        "prefer-spread": "error",
      },
    },
    {
      name: "stack-toolchain/eslint-syntax/recommended",
      rules: {
        "@typescript-eslint/ban-ts-comment": "error",
        "no-array-constructor": "off",
        "@typescript-eslint/no-array-constructor": "error",
        "@typescript-eslint/no-duplicate-enum-values": "error",
        "@typescript-eslint/no-empty-object-type": "error",
        "@typescript-eslint/no-explicit-any": "error",
        "@typescript-eslint/no-extra-non-null-assertion": "error",
        "@typescript-eslint/no-misused-new": "error",
        "@typescript-eslint/no-namespace": "error",
        "@typescript-eslint/no-non-null-asserted-optional-chain": "error",
        "@typescript-eslint/no-require-imports": "error",
        "@typescript-eslint/no-this-alias": "error",
        "@typescript-eslint/no-unnecessary-type-constraint": "error",
        "@typescript-eslint/no-unsafe-declaration-merging": "error",
        "@typescript-eslint/no-unsafe-function-type": "error",
        "no-unused-expressions": "off",
        "@typescript-eslint/no-unused-expressions": "error",
        "no-unused-vars": "off",
        "@typescript-eslint/no-unused-vars": "error",
        "@typescript-eslint/no-wrapper-object-types": "error",
        "@typescript-eslint/prefer-as-const": "error",
        "@typescript-eslint/prefer-namespace-keyword": "error",
        "@typescript-eslint/triple-slash-reference": "error",
      },
    },
  ],
};
