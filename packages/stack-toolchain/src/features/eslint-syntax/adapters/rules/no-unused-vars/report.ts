// Adapted from typescript-eslint 8.59.1 (MIT). See THIRD_PARTY_NOTICES.md and eslint-syntax-provenance.json.

import type { ScopeVariable } from "../../scope-runtime.js";
import type * as TSESTree from "../../ast.js";

import type * as TSESLint from "../../rule-contract.js";

import { nullThrows } from "../../helpers/index.js";

import type { RuleState, MessageIds } from "./contracts.js";
import { VariableType } from "./contracts.js";
import { defToVariableType } from "./messages.js";
import { getImportFixer } from "./import-fixes.js";

export function report(
  state: RuleState,
  unusedVar: ScopeVariable,
  opts: {
    data: TSESLint.ReportDescriptorMessageData;
    messageId: MessageIds;
    node?: TSESTree.Node;
  },
) {
  const { context, options, reportedUnusedVariables } = state;

  reportedUnusedVariables.add(unusedVar);

  const writeReferences = unusedVar.references.filter(
    (ref) => ref.isWrite() && ref.from.variableScope === unusedVar.scope.variableScope,
  );

  const id = writeReferences.length
    ? nullThrows(
        writeReferences.at(-1),
        "Nonempty write reference list must have its final reference.",
      ).identifier
    : nullThrows(unusedVar.identifiers[0], "Reported variable must have an identifier.");

  const { start } = id.loc;
  const idLength = id.name.length;

  const loc = {
    start,
    end: {
      column: start.column + idLength,
      line: start.line,
    },
  };

  const fixer = (() => {
    const { messageId, fix, useAutofix } = ((): {
      fix?: TSESLint.ReportFixFunction;
      messageId?: MessageIds;
      useAutofix?: boolean;
    } => {
      if (unusedVar.defs.length !== 1) {
        // If there's multiple definitions then we'd have to clean them all
        // up! That's complicated and messy so for now let's just ignore it.
        return {};
      }

      const { type, def } = defToVariableType(
        state,
        nullThrows(unusedVar.defs[0], "Single-definition variable must contain its definition."),
      );
      switch (type) {
        case VariableType.ArrayDestructure:
          // TODO(bradzacher) -- this would be really easy to implement and
          // is side-effect free!
          return {};

        case VariableType.CatchClause:
          // TODO(bradzacher) -- this would be really easy to implement and
          // is side-effect free!
          return {};

        case VariableType.ClassName:
          // This would be easy to implement -- but classes can have
          // side-effects in static initializers / static blocks. So it's
          // dangerous to ever auto-fix remove them.
          //
          // Perhaps as an always-suggestion fixer...?
          return {};

        case VariableType.FunctionName:
          // TODO(bradzacher) -- this would be really easy to implement and
          // is side-effect free!
          return {};

        case VariableType.ImportBinding:
          return {
            ...getImportFixer(state, def),
            useAutofix: options.enableAutofixRemoval.imports,
          };

        case VariableType.ImplicitGlobalVariable:
          // We don't report these via this code path, so no fixer is possible
          return {};

        case VariableType.Parameter:
          // This is easy to implement -- but we cannot implement it cos it
          // changes the signature of the function which in turn might
          // introduce type errors in consumers.
          //
          // Also parameters can have default values which might have
          // side-effects.
          //
          // Perhaps as an always-suggestion fixer...?
          return {};

        case VariableType.TSEnumMember:
          // We don't report unused enum members so no fixer is ever possible
          return {};

        case VariableType.TSEnumName:
          // TODO(bradzacher) -- this would be really easy to implement and
          // is side-effect free!
          return {};

        case VariableType.TSModuleName:
          // This is easy to implement -- but TS namespaces are eagerly
          // initialized -- meaning that they might have side-effects in
          // the body. So it's dangerous to ever auto-fix remove them.
          //
          // Perhaps as an always-suggestion fixer...?
          return {};

        case VariableType.Type:
          // TODO(bradzacher) -- this would be really easy to implement and
          // is side-effect free!
          return {};

        case VariableType.Variable:
          // TODO(bradzacher) -- this would be really easy to implement
          return {};
      }
    })();

    if (!fix) {
      return {};
    }

    if (useAutofix === true) {
      return { fix };
    }

    const data = {
      varName: unusedVar.name,
    };
    return {
      suggest: [
        {
          messageId: messageId ?? ("removeUnusedVar" as const),
          data,
          fix,
        },
      ],
    };
  })();
  context.report({
    ...opts,
    ...fixer,
    loc,
    node: id,
  });
}
