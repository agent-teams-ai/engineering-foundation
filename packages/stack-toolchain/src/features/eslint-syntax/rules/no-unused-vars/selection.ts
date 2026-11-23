// Retained typescript-eslint 8.59.1 unused-variable selection (MIT).
// Original branch order and report behavior are preserved; see the provenance ledger.
import {
  DefinitionType,
  ScopeType,
  type Definition,
  type ScopeVariable,
} from "../../scope-runtime.js";
import type * as TSESTree from "../../ast.js";
import { AST_NODE_TYPES } from "../../ast.js";
import { collectVariables, isFunction, nullThrows } from "../../helpers/index.js";
import { VariableType, type RuleState } from "./contracts.js";
import { report } from "./report.js";
import { getUsedIgnoredMessageData } from "./messages.js";

function reportIgnored(
  state: RuleState,
  variable: ScopeVariable,
  used: boolean,
  type: VariableType,
): void {
  if (state.options.reportUsedIgnorePattern && used) {
    report(state, variable, {
      messageId: "usedIgnoredVar",
      data: getUsedIgnoredMessageData(state, variable, type),
    });
  }
}

function hasRestSibling(node: TSESTree.Node): boolean {
  return (
    node.type === AST_NODE_TYPES.Property &&
    node.parent.type === AST_NODE_TYPES.ObjectPattern &&
    nullThrows(node.parent.properties.at(-1), "Pattern with a property must not be empty.").type ===
      AST_NODE_TYPES.RestElement
  );
}

function hasRestSpreadSibling(state: RuleState, variable: ScopeVariable): boolean {
  if (!state.options.ignoreRestSiblings) {
    return false;
  }
  const definition = variable.defs.some((def) => hasRestSibling(def.name.parent));
  const reference = variable.references.some((ref) => hasRestSibling(ref.identifier.parent));
  return definition || reference;
}

function isAfterLastUsedArg(state: RuleState, variable: ScopeVariable): boolean {
  const def = nullThrows(variable.defs[0], "Defined variable must contain its definition.");
  const params = state.context.sourceCode.getDeclaredVariables(def.node);
  const posteriorParams = params.slice(params.indexOf(variable) + 1);
  return !posteriorParams.some(
    (parameter) => parameter.references.length > 0 || parameter.eslintUsed,
  );
}

function ignoredArrayElement(
  state: RuleState,
  def: Definition,
  variable: ScopeVariable,
  used: boolean,
): boolean {
  const refUsedInArrayPatterns = variable.references.some(
    (ref) => ref.identifier.parent.type === AST_NODE_TYPES.ArrayPattern,
  );
  if (
    (def.name.parent.type === AST_NODE_TYPES.ArrayPattern || refUsedInArrayPatterns) &&
    def.name.type === AST_NODE_TYPES.Identifier &&
    state.options.destructuredArrayIgnorePattern?.test(def.name.name)
  ) {
    reportIgnored(state, variable, used, VariableType.ArrayDestructure);
    return true;
  }
  return false;
}

function ignoredParameter(
  state: RuleState,
  def: Definition & { type: DefinitionType.Parameter },
  variable: ScopeVariable,
  used: boolean,
): boolean {
  const { options } = state;
  if (options.args === "none") {
    return true;
  }
  if (
    def.name.type === AST_NODE_TYPES.Identifier &&
    options.argsIgnorePattern?.test(def.name.name)
  ) {
    reportIgnored(state, variable, used, VariableType.Parameter);
    return true;
  }
  return (
    options.args === "after-used" &&
    isFunction(def.name.parent) &&
    !isAfterLastUsedArg(state, variable)
  );
}

function ignoredDefinition(
  state: RuleState,
  def: Definition,
  variable: ScopeVariable,
  used: boolean,
): boolean {
  const { options } = state;
  if (def.type === DefinitionType.CatchClause) {
    if (options.caughtErrors === "none") {
      return true;
    }
    if (options.caughtErrorsIgnorePattern?.test(def.name.name)) {
      reportIgnored(state, variable, used, VariableType.CatchClause);
      return true;
    }
  } else if (def.type === DefinitionType.Parameter) {
    return ignoredParameter(state, def, variable, used);
  } else if (
    def.name.type === AST_NODE_TYPES.Identifier &&
    options.varsIgnorePattern?.test(def.name.name)
  ) {
    // Enum members are intrinsically marked used, so their names must not produce this report.
    if (def.type !== DefinitionType.TSEnumMember) {
      reportIgnored(state, variable, used, VariableType.Variable);
    }
    return true;
  }
  return false;
}

function skipDefinedVariable(
  state: RuleState,
  def: Definition,
  variable: ScopeVariable,
  used: boolean,
): boolean {
  const { options } = state;
  if (variable.scope.type === ScopeType.global && options.vars === "local") {
    return true;
  }
  if (ignoredArrayElement(state, def, variable, used)) {
    return true;
  }
  if (def.type === DefinitionType.ClassName) {
    const hasStaticBlock = def.node.body.body.some(
      (node) => node.type === AST_NODE_TYPES.StaticBlock,
    );
    if (options.ignoreClassWithStaticInitBlock && hasStaticBlock) {
      return true;
    }
  }
  if (ignoredDefinition(state, def, variable, used)) {
    return true;
  }
  if (
    def.type === DefinitionType.Variable &&
    options.ignoreUsingDeclarations &&
    (def.parent.kind === "await using" || def.parent.kind === "using")
  ) {
    return true;
  }
  if (hasRestSpreadSibling(state, variable)) {
    return true;
  }
  // Re-read marks after other selectors/rules may have used the cached analysis.
  return variable.eslintUsed;
}

export function collectUnusedVariables(state: RuleState): ScopeVariable[] {
  const analysis = collectVariables(state.context);
  const variables = [
    ...Array.from(analysis.unusedVariables, (variable) => ({ used: false, variable })),
    ...Array.from(analysis.usedVariables, (variable) => ({ used: true, variable })),
  ];
  const unused: ScopeVariable[] = [];
  for (const { used, variable } of variables) {
    // Explicit globals retain their original distinct path with no ordinary definition.
    if (variable.defs.length === 0) {
      if (!used) {
        unused.push(variable);
      }
      continue;
    }
    const def = nullThrows(variable.defs[0], "Defined variable must contain its definition.");
    if (skipDefinedVariable(state, def, variable, used)) {
      continue;
    }
    if (!used) {
      unused.push(variable);
    }
  }
  return unused;
}
