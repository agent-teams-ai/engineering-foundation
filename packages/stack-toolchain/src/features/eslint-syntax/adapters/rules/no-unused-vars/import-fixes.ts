import { isNullish } from "../../source-helpers.js";
// Adapted from typescript-eslint 8.59.1 (MIT). See THIRD_PARTY_NOTICES.md and eslint-syntax-provenance.json.

import type { ImportBindingDefinition } from "../../scope-runtime.js";
import type * as TSESTree from "../../ast.js";

import type * as TSESLint from "../../rule-contract.js";
import { AST_NODE_TYPES, AST_TOKEN_TYPES } from "../../ast.js";

import { nullThrows, NullThrowsReasons } from "../../helpers/index.js";

import type { RuleState, MessageIds } from "./contracts.js";

interface Predicate {
  predicate: (token: TSESTree.Token) => boolean;
  tokenChar: string;
}
const isCommaToken: Predicate = {
  predicate: (token: TSESTree.Token): boolean =>
    token.type === AST_TOKEN_TYPES.Punctuator && token.value === ",",
  tokenChar: ",",
};
const isLeftCurlyToken: Predicate = {
  predicate: (token: TSESTree.Token): boolean =>
    token.type === AST_TOKEN_TYPES.Punctuator && token.value === "{",
  tokenChar: "{",
};
const isRightCurlyToken: Predicate = {
  predicate: (token: TSESTree.Token): boolean =>
    token.type === AST_TOKEN_TYPES.Punctuator && token.value === "}",
  tokenChar: "}",
};

function assertToken(
  { predicate, tokenChar }: Predicate,
  token: TSESTree.Token | null,
): TSESTree.Token {
  if (isNullish(token)) {
    throw new Error(`Expected a valid "${tokenChar}" token, but found no token`);
  }

  if (!predicate(token)) {
    throw new Error(`Expected a valid "${tokenChar}" token, but got "${token.value}" instead`);
  }
  return token;
}

function areAllSpecifiersUnused(state: RuleState, decl: TSESTree.ImportDeclaration): boolean {
  const { context, reportedUnusedVariables } = state;

  return context.sourceCode.getDeclaredVariables(decl).every((variable) => {
    return reportedUnusedVariables.has(variable);
  });
}

function removeNodeWithTrailingNewline(
  state: RuleState,
  fixer: TSESLint.RuleFixer,
  node: TSESTree.Node,
): TSESLint.RuleFix {
  const { context } = state;

  const sourceCode = context.sourceCode;
  const { line: startLine } = node.loc.start;
  const { line: endLine } = node.loc.end;
  // Expand range: start of first line to start of next line (or EOF)
  const lineRangeStart = sourceCode.getIndexFromLoc({
    column: 0,
    line: startLine,
  });
  const lineRangeEnd =
    endLine < sourceCode.lines.length
      ? sourceCode.getIndexFromLoc({ column: 0, line: endLine + 1 })
      : sourceCode.text.length;
  // If node is the only non-whitespace on its line(s), remove full line(s)
  if (sourceCode.getText(node) === sourceCode.text.slice(lineRangeStart, lineRangeEnd).trim()) {
    return fixer.removeRange([lineRangeStart, lineRangeEnd]);
  }
  return fixer.remove(node);
}

export function getImportFixer(
  state: RuleState,
  def: ImportBindingDefinition,
): {
  fix: TSESLint.ReportFixFunction;
  messageId: MessageIds;
} {
  const { context, reportedUnusedVariables } = state;

  switch (def.node.type) {
    case AST_NODE_TYPES.TSImportEqualsDeclaration:
      // import equals declarations can only have one binding -- so we can
      // just remove entire import declaration
      return {
        messageId: "removeUnusedImportDeclaration",
        fix: (fixer) => removeNodeWithTrailingNewline(state, fixer, def.node),
      };

    case AST_NODE_TYPES.ImportDefaultSpecifier: {
      const importDecl = def.node.parent;
      if (importDecl.specifiers.length === 1 || areAllSpecifiersUnused(state, importDecl)) {
        // all specifiers are unused -- so we can just remove entire import
        // declaration
        return {
          messageId: "removeUnusedImportDeclaration",
          fix: (fixer) => removeNodeWithTrailingNewline(state, fixer, importDecl),
        };
      }

      // in this branch we know the following things:
      // 1) there is at least one specifier that is used
      // 2) the default specifier is unused
      //
      // by process of elimination we can deduce that there is at least one
      // named specifier that is used
      //
      // i.e. the code must be import Unused, { Used, ... } from 'module';
      //
      // there's one or more unused named specifiers, so we must remove the
      // default specifier in isolation including the trailing comma.
      //
      //     import Unused, { Used, ... } from 'module';
      //            ^^^^^^^ remove this
      //
      // NOTE: we could also remove the spaces between the comma and the
      // opening curly brace -- but this does risk removing comments. To be
      // safe we'll be conservative for now
      //
      // TODO(bradzacher) -- consider removing the extra space whilst also
      //                     preserving comments.
      return {
        messageId: "removeUnusedVar",
        fix: (fixer) => {
          const comma = nullThrows(
            context.sourceCode.getTokenAfter(def.node),
            NullThrowsReasons.MissingToken(",", "import specifier"),
          );
          assertToken(isCommaToken, comma);

          return fixer.removeRange([
            Math.min(def.node.range[0], comma.range[0]),
            Math.max(def.node.range[1], comma.range[1]),
          ]);
        },
      };
    }

    case AST_NODE_TYPES.ImportSpecifier: {
      // guaranteed to NOT be in an export statement as we're inspecting an
      // import
      const importDecl = def.node.parent as Exclude<
        typeof def.node.parent,
        TSESTree.ExportAllDeclaration | TSESTree.ExportNamedDeclaration
      >;
      if (importDecl.specifiers.length === 1 || areAllSpecifiersUnused(state, importDecl)) {
        // all specifiers are unused -- so we can just remove entire import
        // declaration
        return {
          messageId: "removeUnusedImportDeclaration",
          fix: (fixer) => removeNodeWithTrailingNewline(state, fixer, importDecl),
        };
      }

      return {
        messageId: "removeUnusedVar",
        fix: (fixer) => {
          const usedNamedSpecifiers = context.sourceCode
            .getDeclaredVariables(importDecl)
            .map((variable) => {
              if (reportedUnusedVariables.has(variable)) {
                return null;
              }
              const specifier = nullThrows(
                variable.defs[0],
                "Imported variable must have a definition.",
              ).node;
              if (specifier.type !== AST_NODE_TYPES.ImportSpecifier) {
                return null;
              }
              return specifier;
            })
            .filter((v) => !isNullish(v));

          if (usedNamedSpecifiers.length === 0) {
            // in this branch we know the following things:
            // 1) there is at least one specifier that is used
            // 2) all named specifiers are unused
            //
            // by process of elimination we can deduce that there is a
            // default specifier and it is the only used specifier
            //
            // i.e. the code must be import Used, { Unused, ... } from
            //     'module';
            //
            // So we can just remove the entire curly content and the comma
            // before, eg import Used, { Unused, ... } from 'module';
            // ^^^^^^^^^^^^^^^^^ remove this

            const leftCurly = assertToken(
              isLeftCurlyToken,
              context.sourceCode.getFirstToken(importDecl, isLeftCurlyToken.predicate),
            );
            const leftToken = assertToken(
              isCommaToken,
              context.sourceCode.getTokenBefore(leftCurly),
            );

            const rightToken = assertToken(
              isRightCurlyToken,
              context.sourceCode.getFirstToken(importDecl, isRightCurlyToken.predicate),
            );
            return fixer.removeRange([leftToken.range[0], rightToken.range[1]]);
          }

          // in this branch we know there is at least one used named
          // specifier which means we have to remove each unused specifier
          // in isolation.
          //
          // there's 3 possible cases to care about: import { Unused,
          //    Used... } from 'module'; import { ...Used, Unused } from
          //    'module'; import { ...Used, Unused, } from 'module';
          //
          // Note that because of the above usedNamedSpecifiers check we
          // know that we don't have one of these cases: import { Unused }
          // from 'module'; import { Unused, Unused... } from 'module';
          // import { ...Unused, Unused, } from 'module';
          //
          // The result is that we know that there _must_ be a comma that
          // needs cleaning up
          //
          // try to remove the leading comma first as it leads to a nicer
          // fix output in most cases
          //
          // leading preferred: import { Used, Unused, Used } from 'module';
          //   ^^^^^^^^ remove import { Used, Used } from 'module';
          //
          // trailing preferred: import { Used, Unused, Used } from
          //   'module'; ^^^^^^^ remove import { Used,  Used } from
          //   'module'; ^^ ugly double space
          //
          // But we need to still fallback to the trailing comma for cases
          // where the unused specifier is the first in the import eg:
          // import { Unused, Used } from 'module';
          const maybeComma = context.sourceCode.getTokenBefore(def.node);
          const comma =
            maybeComma && isCommaToken.predicate(maybeComma)
              ? maybeComma
              : assertToken(isCommaToken, context.sourceCode.getTokenAfter(def.node));
          return fixer.removeRange([
            Math.min(def.node.range[0], comma.range[0]),
            Math.max(def.node.range[1], comma.range[1]),
          ]);
        },
      };
    }

    case AST_NODE_TYPES.ImportNamespaceSpecifier: {
      // namespace specifiers cannot be used with any other specifier -- so
      // we can just remove entire import declaration
      const importDecl = def.node.parent;
      return {
        messageId: "removeUnusedImportDeclaration",
        fix: (fixer) => removeNodeWithTrailingNewline(state, fixer, importDecl),
      };
    }
  }
}
