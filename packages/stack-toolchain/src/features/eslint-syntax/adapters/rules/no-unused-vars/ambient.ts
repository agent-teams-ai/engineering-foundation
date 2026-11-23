import { isNullish } from "../../source-helpers.js";
// Adapted from typescript-eslint 8.59.1 (MIT). See THIRD_PARTY_NOTICES.md and eslint-syntax-provenance.json.

import type * as TSESTree from "../../ast.js";

import { PatternVisitor } from "../../scope-runtime.js";
import type * as TSESLint from "../../rule-contract.js";
import { AST_NODE_TYPES } from "../../ast.js";

import { isDefinitionFile, nullThrows, NullThrowsReasons } from "../../helpers/index.js";

import type { RuleState, ModuleDeclarationWithBody, DeclarationSelectorNode } from "./contracts.js";

export function ambientListeners(state: RuleState): TSESLint.RuleListener {
  const { context } = state;
  return {
    [ambientDeclarationSelector(AST_NODE_TYPES.Program)](node: DeclarationSelectorNode): void {
      if (!isDefinitionFile(context.filename)) {
        return;
      }

      const moduleDecl = nullThrows(
        node.parent,
        NullThrowsReasons.MissingParent,
      ) as TSESTree.Program;

      if (checkForOverridingExportStatements(state, moduleDecl)) {
        return;
      }

      markDeclarationChildAsUsed(state, node);
    },
    [ambientDeclarationSelector(
      "TSModuleDeclaration[declare = true] > TSModuleBlock TSModuleDeclaration > TSModuleBlock",
    )](node: DeclarationSelectorNode): void {
      const moduleDecl = nullThrows(
        node.parent.parent,
        NullThrowsReasons.MissingParent,
      ) as ModuleDeclarationWithBody;

      if (checkForOverridingExportStatements(state, moduleDecl)) {
        return;
      }

      markDeclarationChildAsUsed(state, node);
    },
    [ambientDeclarationSelector("TSModuleDeclaration[declare = true] > TSModuleBlock")](
      node: DeclarationSelectorNode,
    ): void {
      const moduleDecl = nullThrows(
        node.parent.parent,
        NullThrowsReasons.MissingParent,
      ) as ModuleDeclarationWithBody;

      if (checkForOverridingExportStatements(state, moduleDecl)) {
        return;
      }

      markDeclarationChildAsUsed(state, node);
    },
    [ambientDeclarationSelector("TSModuleDeclaration > TSModuleBlock")](
      node: DeclarationSelectorNode,
    ): void {
      if (!isDefinitionFile(context.filename)) {
        return;
      }
      const moduleDecl = nullThrows(
        node.parent.parent,
        NullThrowsReasons.MissingParent,
      ) as ModuleDeclarationWithBody;

      if (checkForOverridingExportStatements(state, moduleDecl)) {
        return;
      }

      markDeclarationChildAsUsed(state, node);
    },
  };
}

export function checkForOverridingExportStatements(
  state: RuleState,
  node: ModuleDeclarationWithBody | TSESTree.Program,
): boolean {
  const { MODULE_DECL_CACHE } = state;

  const cached = MODULE_DECL_CACHE.get(node);
  if (!isNullish(cached)) {
    return cached;
  }

  const body = getStatementsOfNode(node);

  if (hasOverridingExportStatement(body)) {
    MODULE_DECL_CACHE.set(node, true);
    return true;
  }

  MODULE_DECL_CACHE.set(node, false);
  return false;
}

export function ambientDeclarationSelector(parent: string): string {
  return [
    // Types are ambiently exported
    `${parent} > :matches(${[
      AST_NODE_TYPES.TSInterfaceDeclaration,
      AST_NODE_TYPES.TSTypeAliasDeclaration,
    ].join(", ")})`,
    // Value things are ambiently exported if they are "declare"d
    `${parent} > :matches(${[
      AST_NODE_TYPES.ClassDeclaration,
      AST_NODE_TYPES.TSDeclareFunction,
      AST_NODE_TYPES.TSEnumDeclaration,
      AST_NODE_TYPES.TSModuleDeclaration,
      AST_NODE_TYPES.VariableDeclaration,
    ].join(", ")})`,
  ].join(", ");
}

export function markDeclarationChildAsUsed(state: RuleState, node: DeclarationSelectorNode): void {
  const { context } = state;

  const identifiers: TSESTree.Identifier[] = [];
  switch (node.type) {
    case AST_NODE_TYPES.TSInterfaceDeclaration:
    case AST_NODE_TYPES.TSTypeAliasDeclaration:
    case AST_NODE_TYPES.ClassDeclaration:
    case AST_NODE_TYPES.FunctionDeclaration:
    case AST_NODE_TYPES.TSDeclareFunction:
    case AST_NODE_TYPES.TSEnumDeclaration:
    case AST_NODE_TYPES.TSModuleDeclaration:
      if (node.id?.type === AST_NODE_TYPES.Identifier) {
        identifiers.push(node.id);
      }
      break;

    case AST_NODE_TYPES.VariableDeclaration:
      for (const declaration of node.declarations) {
        visitPattern(declaration, (pattern) => {
          identifiers.push(pattern);
        });
      }
      break;
  }

  let scope = context.sourceCode.getScope(node);
  const shouldUseUpperScope = [
    AST_NODE_TYPES.TSDeclareFunction,
    AST_NODE_TYPES.TSModuleDeclaration,
  ].includes(node.type);

  if (scope.variableScope !== scope) {
    scope = scope.variableScope;
  } else if (shouldUseUpperScope && scope.upper) {
    scope = scope.upper;
  }

  for (const id of identifiers) {
    const superVar = scope.set.get(id.name);
    if (superVar) {
      superVar.eslintUsed = true;
    }
  }
}

export function visitPattern(node: TSESTree.Node, cb: (node: TSESTree.Identifier) => void): void {
  const visitor = new PatternVisitor({}, node, cb);
  visitor.visit(node);
}

export function hasOverridingExportStatement(body: TSESTree.ProgramStatement[]): boolean {
  for (const statement of body) {
    if (
      (statement.type === AST_NODE_TYPES.ExportNamedDeclaration &&
        isNullish(statement.declaration)) ||
      statement.type === AST_NODE_TYPES.ExportAllDeclaration ||
      statement.type === AST_NODE_TYPES.TSExportAssignment
    ) {
      return true;
    }

    if (
      statement.type === AST_NODE_TYPES.ExportDefaultDeclaration &&
      statement.declaration.type === AST_NODE_TYPES.Identifier
    ) {
      return true;
    }
  }

  return false;
}

export function getStatementsOfNode(
  block: ModuleDeclarationWithBody | TSESTree.Program,
): TSESTree.ProgramStatement[] {
  if (block.type === AST_NODE_TYPES.Program) {
    return block.body;
  }

  return block.body.body;
}
