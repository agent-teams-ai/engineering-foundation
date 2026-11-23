import { isNullish } from "../../source-helpers.js";
// Adapted from typescript-eslint 8.59.1 (MIT). See THIRD_PARTY_NOTICES.md and eslint-syntax-provenance.json.

import type { Options, TranslatedOptions } from "./contracts.js";

export function translateOptions(firstOption: Options[0]): TranslatedOptions {
  const options: TranslatedOptions = {
    args: "after-used",
    caughtErrors: "all",
    enableAutofixRemoval: {
      imports: false,
    },
    ignoreClassWithStaticInitBlock: false,
    ignoreRestSiblings: false,
    ignoreUsingDeclarations: false,
    reportUsedIgnorePattern: false,
    vars: "all",
  };

  if (typeof firstOption === "string") {
    options.vars = firstOption;
  } else {
    options.vars = firstOption.vars ?? options.vars;
    options.args = firstOption.args ?? options.args;
    options.ignoreRestSiblings = firstOption.ignoreRestSiblings ?? options.ignoreRestSiblings;
    options.ignoreUsingDeclarations =
      firstOption.ignoreUsingDeclarations ?? options.ignoreUsingDeclarations;
    options.caughtErrors = firstOption.caughtErrors ?? options.caughtErrors;
    options.ignoreClassWithStaticInitBlock =
      firstOption.ignoreClassWithStaticInitBlock ?? options.ignoreClassWithStaticInitBlock;
    options.reportUsedIgnorePattern =
      firstOption.reportUsedIgnorePattern ?? options.reportUsedIgnorePattern;

    if (firstOption.varsIgnorePattern) {
      options.varsIgnorePattern = new RegExp(firstOption.varsIgnorePattern, "u");
    }

    if (firstOption.argsIgnorePattern) {
      options.argsIgnorePattern = new RegExp(firstOption.argsIgnorePattern, "u");
    }

    if (firstOption.caughtErrorsIgnorePattern) {
      options.caughtErrorsIgnorePattern = new RegExp(firstOption.caughtErrorsIgnorePattern, "u");
    }

    if (firstOption.destructuredArrayIgnorePattern) {
      options.destructuredArrayIgnorePattern = new RegExp(
        firstOption.destructuredArrayIgnorePattern,
        "u",
      );
    }

    if (firstOption.enableAutofixRemoval) {
      if (!isNullish(firstOption.enableAutofixRemoval.imports)) {
        options.enableAutofixRemoval.imports = firstOption.enableAutofixRemoval.imports;
      }
    }
  }

  return options;
}
