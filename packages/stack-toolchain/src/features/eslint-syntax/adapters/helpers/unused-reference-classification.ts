// Retained typescript-eslint 8.59.1 variable-reference classification (MIT).
// Modularized without changing decisions; see eslint-syntax-provenance.json.
import * as Scope from "../scope-runtime.js";
import type { ScopeVariable } from "../scope-runtime.js";
import type * as TSESTree from "../ast.js";
import { AST_NODE_TYPES } from "../ast.js";
import * as ASTUtils from "../source-helpers.js";
import { isTypeImport } from "./isTypeImport.js";
import { referenceContainsTypePredicate } from "./referenceContainsTypePredicate.js";
import { referenceContainsTypeQuery } from "./referenceContainsTypeQuery.js";

const LOGICAL_ASSIGNMENT_OPERATORS = new Set(["??=", "&&=", "||="]);
function isInside(inner: TSESTree.Node, outer: TSESTree.Node): boolean {
  return inner.range[0] >= outer.range[0] && inner.range[1] <= outer.range[1];
}

function isSelfReference(ref: Scope.Reference, nodes: Set<TSESTree.Node>): boolean {
  let scope: Scope.Scope | null = ref.from;

  while (scope) {
    if (nodes.has(scope.block)) {
      return true;
    }

    scope = scope.upper;
  }

  return false;
}

function getFunctionDefinitions(variable: ScopeVariable): Set<TSESTree.Node> {
  const functionDefinitions = new Set<TSESTree.Node>();

  variable.defs.forEach((def) => {
    // FunctionDeclarations
    if (def.type === Scope.DefinitionType.FunctionName) {
      functionDefinitions.add(def.node);
    }

    // FunctionExpressions
    if (
      def.type === Scope.DefinitionType.Variable &&
      (def.node.init?.type === AST_NODE_TYPES.FunctionExpression ||
        def.node.init?.type === AST_NODE_TYPES.ArrowFunctionExpression)
    ) {
      functionDefinitions.add(def.node.init);
    }
  });
  return functionDefinitions;
}

function getTypeDeclarations(variable: ScopeVariable): Set<TSESTree.Node> {
  const nodes = new Set<TSESTree.Node>();

  variable.defs.forEach((def) => {
    if (
      def.node.type === AST_NODE_TYPES.TSInterfaceDeclaration ||
      def.node.type === AST_NODE_TYPES.TSTypeAliasDeclaration
    ) {
      nodes.add(def.node);
    }
  });

  return nodes;
}

function getModuleDeclarations(variable: ScopeVariable): Set<TSESTree.Node> {
  const nodes = new Set<TSESTree.Node>();

  variable.defs.forEach((def) => {
    if (def.node.type === AST_NODE_TYPES.TSModuleDeclaration) {
      nodes.add(def.node);
    }
  });

  return nodes;
}

function getEnumDeclarations(variable: ScopeVariable): Set<TSESTree.Node> {
  const nodes = new Set<TSESTree.Node>();

  variable.defs.forEach((def) => {
    if (def.node.type === AST_NODE_TYPES.TSEnumDeclaration) {
      nodes.add(def.node);
    }
  });

  return nodes;
}

function isInsideOneOf(ref: Scope.Reference, nodes: Set<TSESTree.Node>): boolean {
  for (const node of nodes) {
    if (isInside(ref.identifier, node)) {
      return true;
    }
  }

  return false;
}

function isUnusedExpression(node: TSESTree.Expression): boolean {
  const parent = node.parent;

  if (parent.type === AST_NODE_TYPES.ExpressionStatement) {
    return true;
  }

  if (parent.type === AST_NODE_TYPES.SequenceExpression) {
    const isLastExpression = parent.expressions[parent.expressions.length - 1] === node;

    if (!isLastExpression) {
      return true;
    }
    return isUnusedExpression(parent);
  }

  return false;
}

function getRhsNode(ref: Scope.Reference, prevRhsNode: TSESTree.Node | null): TSESTree.Node | null {
  /**
   * Checks whether the given node is in a loop or not.
   * @param node The node to check.
   * @returns `true` if the node is in a loop.
   */

  const id = ref.identifier;
  const parent = id.parent;
  const refScope = ref.from.variableScope;

  const varScope = ref.resolved!.scope.variableScope;
  const canBeUsedLater = refScope !== varScope || isInLoop(id);

  /*
   * Inherits the previous node if this reference is in the node.
   * This is for `a = a + a`-like code.
   */
  if (prevRhsNode && isInside(id, prevRhsNode)) {
    return prevRhsNode;
  }

  if (
    parent.type === AST_NODE_TYPES.AssignmentExpression &&
    isUnusedExpression(parent) &&
    id === parent.left &&
    !canBeUsedLater
  ) {
    return parent.right;
  }
  return null;
}

function isReadForItself(ref: Scope.Reference, rhsNode: TSESTree.Node | null): boolean {
  /**
   * Checks whether a given Identifier node exists inside of a function node which can be used later.
   *
   * "can be used later" means:
   * - the function is assigned to a variable.
   * - the function is bound to a property and the object can be used later.
   * - the function is bound as an argument of a function call.
   *
   * If a reference exists in a function which can be used later, the reference is read when the function is called.
   * @param id An Identifier node to check.
   * @param rhsNode The RHS node of the previous assignment.
   * @returns `true` if the `id` node exists inside of a function node which can be used later.
   */

  const id = ref.identifier;
  const parent = id.parent;

  return (
    ref.isRead() && // in RHS of an assignment for itself. e.g. `a = a + 1`
    // self update. e.g. `a += 1`, `a++`
    ((parent.type === AST_NODE_TYPES.AssignmentExpression &&
      !LOGICAL_ASSIGNMENT_OPERATORS.has(parent.operator) &&
      isUnusedExpression(parent) &&
      parent.left === id) ||
      (parent.type === AST_NODE_TYPES.UpdateExpression && isUnusedExpression(parent)) ||
      (!!rhsNode && isInside(id, rhsNode) && !isInsideOfStorableFunction(id, rhsNode)))
  );
}

export function isUsedVariable(variable: ScopeVariable): boolean {
  /**
   * Gets a list of function definitions for a specified variable.
   * @param variable eslint-scope variable object.
   * @returns Function nodes.
   */

  /**
   * Checks if the ref is contained within one of the given nodes
   */

  /**
   * Checks whether a given node is unused expression or not.
   * @param node The node itself
   * @returns The node is an unused expression.
   */

  /**
   * If a given reference is left-hand side of an assignment, this gets
   * the right-hand side node of the assignment.
   *
   * In the following cases, this returns null.
   *
   * - The reference is not the LHS of an assignment expression.
   * - The reference is inside of a loop.
   * - The reference is inside of a function scope which is different from
   *   the declaration.
   * @param ref A reference to check.
   * @param prevRhsNode The previous RHS node.
   * @returns The RHS node or null.
   */

  /**
   * Checks whether a given reference is a read to update itself or not.
   * @param ref A reference to check.
   * @param rhsNode The RHS node of the previous assignment.
   * @returns The reference is a read to update itself.
   */

  const functionNodes = getFunctionDefinitions(variable);
  const isFunctionDefinition = functionNodes.size > 0;

  const typeDeclNodes = getTypeDeclarations(variable);
  const isTypeDecl = typeDeclNodes.size > 0;

  const moduleDeclNodes = getModuleDeclarations(variable);
  const isModuleDecl = moduleDeclNodes.size > 0;

  const enumDeclNodes = getEnumDeclarations(variable);
  const isEnumDecl = enumDeclNodes.size > 0;

  const isImportedAsType = variable.defs.every(isTypeImport);

  let rhsNode: TSESTree.Node | null = null;

  return variable.references.some((ref) => {
    const forItself = isReadForItself(ref, rhsNode);

    rhsNode = getRhsNode(ref, rhsNode);

    return (
      ref.isRead() &&
      !forItself &&
      !(
        !isImportedAsType &&
        (referenceContainsTypeQuery(ref.identifier) ||
          referenceContainsTypePredicate(ref.identifier))
      ) &&
      !(isFunctionDefinition && isSelfReference(ref, functionNodes)) &&
      !(isTypeDecl && isInsideOneOf(ref, typeDeclNodes)) &&
      !(isModuleDecl && isSelfReference(ref, moduleDeclNodes)) &&
      !(isEnumDecl && isSelfReference(ref, enumDeclNodes))
    );
  });
}

function isInLoop(node: TSESTree.Node): boolean {
  let currentNode: TSESTree.Node | undefined = node;
  while (currentNode) {
    if (ASTUtils.isFunction(currentNode)) {
      break;
    }

    if (ASTUtils.isLoop(currentNode)) {
      return true;
    }

    currentNode = currentNode.parent;
  }

  return false;
}

function getUpperFunction(node: TSESTree.Node): TSESTree.Node | null {
  let currentNode: TSESTree.Node | undefined = node;
  while (currentNode) {
    if (ASTUtils.isFunction(currentNode)) {
      return currentNode;
    }
    currentNode = currentNode.parent;
  }

  return null;
}

function isInsideOfStorableFunction(id: TSESTree.Node, rhsNode: TSESTree.Node): boolean {
  /**
   * Finds a function node from ancestors of a node.
   * @param node A start node to find.
   * @returns A found function node.
   */

  /**
   * Checks whether a given function node is stored to somewhere or not.
   * If the function node is stored, the function can be used later.
   * @param funcNode A function node to check.
   * @param rhsNode The RHS node of the previous assignment.
   * @returns `true` if under the following conditions:
   *      - the funcNode is assigned to a variable.
   *      - the funcNode is bound as an argument of a function call.
   *      - the function is bound to a property and the object satisfies above conditions.
   */

  const funcNode = getUpperFunction(id);

  return !!funcNode && isInside(funcNode, rhsNode) && isStorableFunction(funcNode, rhsNode);
}

function isStorableFunction(funcNode: TSESTree.Node, rhsNode: TSESTree.Node): boolean {
  let node = funcNode;
  let parent = funcNode.parent;

  while (parent && isInside(parent, rhsNode)) {
    if (parent.type === AST_NODE_TYPES.SequenceExpression) {
      if (parent.expressions[parent.expressions.length - 1] !== node) {
        return false;
      }
    } else if (
      parent.type === AST_NODE_TYPES.CallExpression ||
      parent.type === AST_NODE_TYPES.NewExpression
    ) {
      return parent.callee !== node;
    } else if (
      parent.type === AST_NODE_TYPES.AssignmentExpression ||
      parent.type === AST_NODE_TYPES.TaggedTemplateExpression ||
      parent.type === AST_NODE_TYPES.YieldExpression
    ) {
      return true;
    } else if (parent.type.endsWith("Statement") || parent.type.endsWith("Declaration")) {
      /*
       * If it encountered statements, this is a complex pattern.
       * Since analyzing complex patterns is hard, this returns `true` to avoid false positive.
       */
      return true;
    }

    node = parent;
    parent = parent.parent;
  }

  return false;
}
