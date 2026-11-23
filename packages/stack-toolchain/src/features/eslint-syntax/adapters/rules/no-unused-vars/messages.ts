// Adapted from typescript-eslint 8.59.1 (MIT). See THIRD_PARTY_NOTICES.md and eslint-syntax-provenance.json.

import type { Definition, ScopeVariable } from "../../scope-runtime.js";

import { DefinitionType } from "../../scope-runtime.js";
import type * as TSESLint from "../../rule-contract.js";
import { AST_NODE_TYPES } from "../../ast.js";

import type { RuleState, DefToVariableType } from "./contracts.js";
import { VariableType } from "./contracts.js";

export function defToVariableType(state: RuleState, def: Definition): DefToVariableType {
  const { options } = state;

  /*
   * This `destructuredArrayIgnorePattern` error report works differently from the catch
   * clause and parameter error reports. _Both_ the `varsIgnorePattern` and the
   * `destructuredArrayIgnorePattern` will be checked for array destructuring. However,
   * for the purposes of the report, the currently defined behavior is to only inform the
   * user of the `destructuredArrayIgnorePattern` if it's present (regardless of the fact
   * that the `varsIgnorePattern` would also apply). If it's not present, the user will be
   * informed of the `varsIgnorePattern`, assuming that's present.
   */
  if (
    options.destructuredArrayIgnorePattern &&
    def.name.parent.type === AST_NODE_TYPES.ArrayPattern
  ) {
    return { type: VariableType.ArrayDestructure, def };
  }

  switch (def.type) {
    case DefinitionType.CatchClause:
      return { type: VariableType.CatchClause, def };
    case DefinitionType.ClassName:
      return { type: VariableType.ClassName, def };
    case DefinitionType.FunctionName:
      return { type: VariableType.FunctionName, def };
    case DefinitionType.ImplicitGlobalVariable:
      return { type: VariableType.ImplicitGlobalVariable, def };
    case DefinitionType.ImportBinding:
      return { type: VariableType.ImportBinding, def };
    case DefinitionType.Parameter:
      return { type: VariableType.Parameter, def };
    case DefinitionType.TSEnumName:
      return { type: VariableType.TSEnumName, def };
    case DefinitionType.TSEnumMember:
      return { type: VariableType.TSEnumMember, def };
    case DefinitionType.TSModuleName:
      return { type: VariableType.TSModuleName, def };
    case DefinitionType.Type:
      return { type: VariableType.Type, def };
    case DefinitionType.Variable:
      return { type: VariableType.Variable, def };
  }
}

function getVariableDescription(
  state: RuleState,
  variableType: VariableType,
): {
  pattern: string | undefined;
  variableDescription: string;
} {
  const { options } = state;

  if (variableType === VariableType.ArrayDestructure) {
    return {
      pattern: options.destructuredArrayIgnorePattern?.toString(),
      variableDescription: "elements of array destructuring",
    };
  }
  if (variableType === VariableType.CatchClause) {
    return {
      pattern: options.caughtErrorsIgnorePattern?.toString(),
      variableDescription: "caught errors",
    };
  }
  if (variableType === VariableType.Parameter) {
    return {
      pattern: options.argsIgnorePattern?.toString(),
      variableDescription: "args",
    };
  }
  return {
    pattern: options.varsIgnorePattern?.toString(),
    variableDescription: "vars",
  };
}

export function getDefinedMessageData(
  state: RuleState,
  unusedVar: ScopeVariable,
): TSESLint.ReportDescriptorMessageData {
  const def = unusedVar.defs.at(0);
  let additionalMessageData = "";

  if (def) {
    const { pattern, variableDescription } = getVariableDescription(
      state,
      defToVariableType(state, def).type,
    );

    if (pattern !== undefined && pattern.length > 0 && variableDescription.length > 0) {
      additionalMessageData = `. Allowed unused ${variableDescription} must match ${pattern}`;
    }
  }

  return {
    action: "defined",
    additional: additionalMessageData,
    varName: unusedVar.name,
  };
}

export function getAssignedMessageData(
  state: RuleState,
  unusedVar: ScopeVariable,
): TSESLint.ReportDescriptorMessageData {
  const def = unusedVar.defs.at(0);
  let additionalMessageData = "";

  if (def) {
    const { pattern, variableDescription } = getVariableDescription(
      state,
      defToVariableType(state, def).type,
    );

    if (pattern !== undefined && pattern.length > 0 && variableDescription.length > 0) {
      additionalMessageData = `. Allowed unused ${variableDescription} must match ${pattern}`;
    }
  }

  return {
    action: "assigned a value",
    additional: additionalMessageData,
    varName: unusedVar.name,
  };
}

export function getUsedIgnoredMessageData(
  state: RuleState,
  variable: ScopeVariable,
  variableType: VariableType,
): TSESLint.ReportDescriptorMessageData {
  const { pattern, variableDescription } = getVariableDescription(state, variableType);

  let additionalMessageData = "";

  if (pattern !== undefined && pattern.length > 0 && variableDescription.length > 0) {
    additionalMessageData = `. Used ${variableDescription} must not match ${pattern}`;
  }

  return {
    additional: additionalMessageData,
    varName: variable.name,
  };
}
