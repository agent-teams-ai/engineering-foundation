// Adapted from typescript-eslint 8.59.1 (MIT). See THIRD_PARTY_NOTICES.md and eslint-syntax-provenance.json.

import type * as TSESTree from "../../ast.js";

import { DefinitionType } from "../../scope-runtime.js";

import { getNameLocationInGlobalDirectiveComment, nullThrows } from "../../helpers/index.js";
import { referenceContainsTypePredicate } from "../../helpers/referenceContainsTypePredicate.js";
import { referenceContainsTypeQuery } from "../../helpers/referenceContainsTypeQuery.js";

import type { RuleState } from "./contracts.js";

import { collectUnusedVariables } from "./selection.js";
import { report } from "./report.js";
import { getAssignedMessageData, getDefinedMessageData } from "./messages.js";

export function programExit(state: RuleState, programNode: TSESTree.Program): void {
  const { context } = state;

  const unusedVars = collectUnusedVariables(state);

  for (const unusedVar of unusedVars) {
    // Report the first declaration.
    if (unusedVar.defs.length > 0) {
      const usedOnlyAsType = unusedVar.references.some(
        (ref) =>
          referenceContainsTypeQuery(ref.identifier) ||
          referenceContainsTypePredicate(ref.identifier),
      );
      const messageId = usedOnlyAsType ? "usedOnlyAsType" : "unusedVar";

      const isImportUsedOnlyAsType =
        usedOnlyAsType && unusedVar.defs.some((def) => def.type === DefinitionType.ImportBinding);
      if (isImportUsedOnlyAsType) {
        continue;
      }

      report(state, unusedVar, {
        messageId,
        data: unusedVar.references.some((ref) => ref.isWrite())
          ? getAssignedMessageData(state, unusedVar)
          : getDefinedMessageData(state, unusedVar),
      });

      // If there are no regular declaration, report the first `/*globals*/` comment directive.
    } else if (
      "eslintExplicitGlobalComments" in unusedVar &&
      unusedVar.eslintExplicitGlobalComments
    ) {
      const directiveComment = nullThrows(
        unusedVar.eslintExplicitGlobalComments[0],
        "Explicit global must have a defining comment.",
      );

      context.report({
        loc: getNameLocationInGlobalDirectiveComment(
          context.sourceCode,
          directiveComment,
          unusedVar.name,
        ),
        node: programNode,
        messageId: "unusedVar",
        data: getDefinedMessageData(state, unusedVar),
      });
    }
  }
}
