import { isNullish } from "../source-helpers.js";
// Adapted from typescript-eslint 8.59.1 (MIT). See THIRD_PARTY_NOTICES.md and eslint-syntax-provenance.json.
import * as Scope from "../scope-runtime.js";
import type { ScopeManager, ScopeVariable } from "../scope-runtime.js";
import type * as TSESTree from "../ast.js";

import { ImplicitLibVariable, ScopeType, Visitor } from "../scope-runtime.js";

import * as ESLintUtils from "../source-helpers.js";
import type * as TSESLint from "../rule-contract.js";
import { AST_NODE_TYPES } from "../ast.js";

import { isUsedVariable } from "./unused-reference-classification.js";

interface VariableAnalysis {
  readonly unusedVariables: ReadonlySet<ScopeVariable>;
  readonly usedVariables: ReadonlySet<ScopeVariable>;
}
interface MutableVariableAnalysis {
  readonly unusedVariables: Set<ScopeVariable>;
  readonly usedVariables: Set<ScopeVariable>;
}

/**
 * This class leverages an AST visitor to mark variables as used via the
 * `eslintUsed` property.
 */
class UnusedVarsVisitor extends Visitor {
  /**
   * We keep a weak cache so that multiple rules can share the calculation
   */
  private static readonly RESULTS_CACHE = new WeakMap<TSESTree.Program, VariableAnalysis>();

  protected ClassDeclaration = this.visitClass.bind(this);

  protected ClassExpression = this.visitClass.bind(this);

  protected ForInStatement = this.visitForInForOf.bind(this);

  protected ForOfStatement = this.visitForInForOf.bind(this);

  //#region HELPERS

  protected FunctionDeclaration = this.visitFunction.bind(this);

  protected FunctionExpression = this.visitFunction.bind(this);
  protected MethodDefinition = this.visitSetter.bind(this);
  protected Property = this.visitSetter.bind(this);

  protected TSCallSignatureDeclaration = this.visitFunctionTypeSignature.bind(this);

  protected TSConstructorType = this.visitFunctionTypeSignature.bind(this);

  protected TSConstructSignatureDeclaration = this.visitFunctionTypeSignature.bind(this);

  protected TSDeclareFunction = this.visitFunctionTypeSignature.bind(this);

  protected TSEmptyBodyFunctionExpression = this.visitFunctionTypeSignature.bind(this);

  //#endregion HELPERS

  //#region VISITORS
  // NOTE - This is a simple visitor - meaning it does not support selectors

  protected TSFunctionType = this.visitFunctionTypeSignature.bind(this);

  protected TSMethodSignature = this.visitFunctionTypeSignature.bind(this);

  readonly #scopeManager: Scope.ScopeManager;

  private constructor(scopeManager: ScopeManager) {
    super({
      visitChildrenEvenIfSelectorExists: true,
    });

    this.#scopeManager = scopeManager;
  }

  public static collectUnusedVariables(
    program: TSESTree.Program,
    scopeManager: ScopeManager,
  ): VariableAnalysis {
    const cached = this.RESULTS_CACHE.get(program);
    if (cached) {
      return cached;
    }

    const visitor = new this(scopeManager);
    visitor.visit(program);

    const unusedVars = visitor.collectUnusedVariables(visitor.getScope(program));
    this.RESULTS_CACHE.set(program, unusedVars);
    return unusedVars;
  }

  protected Identifier(node: TSESTree.Identifier): void {
    const scope = this.getScope(node);
    if (
      scope.type === Scope.ScopeType.function &&
      node.name === "this" &&
      // this parameters should always be considered used as they're pseudo-parameters
      "params" in scope.block &&
      scope.block.params.includes(node)
    ) {
      this.markVariableAsUsed(node);
    }
  }

  protected TSEnumDeclaration(node: TSESTree.TSEnumDeclaration): void {
    // enum members create variables because they can be referenced within the enum,
    // but they obviously aren't unused variables for the purposes of this rule.
    const scope = this.getScope(node);
    for (const variable of scope.variables) {
      this.markVariableAsUsed(variable);
    }
  }

  protected TSMappedType(node: TSESTree.TSMappedType): void {
    // mapped types create a variable for their type name, but it's not necessary to reference it,
    // so we shouldn't consider it as unused for the purpose of this rule.
    this.markVariableAsUsed(node.key);
  }

  protected TSModuleDeclaration(node: TSESTree.TSModuleDeclaration): void {
    // -- global augmentation can be in any file, and they do not need exports
    if (node.kind === "global") {
      this.markVariableAsUsed("global", node.parent);
    }
  }

  protected TSParameterProperty(node: TSESTree.TSParameterProperty): void {
    let identifier: TSESTree.Identifier;
    switch (node.parameter.type) {
      case AST_NODE_TYPES.AssignmentPattern:
        identifier = node.parameter.left;
        break;

      case AST_NODE_TYPES.Identifier:
        identifier = node.parameter;
        break;
    }

    this.markVariableAsUsed(identifier);
  }

  private collectUnusedVariables(
    scope: Scope.Scope,
    variables: MutableVariableAnalysis = {
      unusedVariables: new Set(),
      usedVariables: new Set(),
    },
  ): VariableAnalysis {
    if (
      // skip function expression names
      // this scope is created just to house the variable that allows a function
      // expression to self-reference if it has a name defined
      !scope.functionExpressionScope
    ) {
      for (const variable of scope.variables) {
        // cases that we don't want to treat as used or unused
        if (
          // implicit lib variables (from @typescript-eslint/scope-manager)
          // these aren't variables that should be checked ever
          variable instanceof ImplicitLibVariable
        ) {
          continue;
        }

        if (
          // variables marked with markVariableAsUsed()
          variable.eslintUsed ||
          // basic exported variables
          isExported(variable) ||
          // variables implicitly exported via a merged declaration
          isMergeableExported(variable) ||
          // used variables
          isUsedVariable(variable)
        ) {
          variables.usedVariables.add(variable);
        } else {
          variables.unusedVariables.add(variable);
        }
      }
    }

    for (const childScope of scope.childScopes) {
      this.collectUnusedVariables(childScope, variables);
    }

    return variables;
  }

  private getScope(currentNode: TSESTree.Node): Scope.Scope {
    // On Program node, get the outermost scope to avoid return Node.js special function scope or ES modules scope.
    const inner = currentNode.type !== AST_NODE_TYPES.Program;

    let node: TSESTree.Node | undefined = currentNode;
    while (node) {
      const scope = this.#scopeManager.acquire(node, inner);

      if (scope) {
        if (scope.type === ScopeType.functionExpressionName) {
          return ESLintUtils.nullThrows(
            scope.childScopes[0],
            "Function-expression scope must contain its function scope.",
          );
        }
        return scope;
      }

      node = node.parent;
    }

    return ESLintUtils.nullThrows(
      this.#scopeManager.scopes[0],
      "Parsed source must have a global scope.",
    );
  }

  private markVariableAsUsed(variableOrIdentifier: ScopeVariable | TSESTree.Identifier): void;
  private markVariableAsUsed(name: string, parent: TSESTree.Node): void;
  private markVariableAsUsed(
    variableOrIdentifierOrName: string | ScopeVariable | TSESTree.Identifier,
    parent?: TSESTree.Node,
  ): void {
    if (typeof variableOrIdentifierOrName !== "string" && !("type" in variableOrIdentifierOrName)) {
      variableOrIdentifierOrName.eslintUsed = true;
      return;
    }

    let name: string;
    let node: TSESTree.Node;
    if (typeof variableOrIdentifierOrName === "string") {
      name = variableOrIdentifierOrName;

      node = parent!;
    } else {
      name = variableOrIdentifierOrName.name;
      node = variableOrIdentifierOrName;
    }

    let currentScope: Scope.Scope | null = this.getScope(node);
    while (currentScope) {
      const variable = currentScope.variables.find((scopeVar) => scopeVar.name === name);

      if (variable) {
        variable.eslintUsed = true;
        return;
      }

      currentScope = currentScope.upper;
    }
  }

  private visitClass(node: TSESTree.ClassDeclaration | TSESTree.ClassExpression): void {
    // skip a variable of class itself name in the class scope
    const scope = this.getScope(node) as Scope.ClassScope;
    for (const variable of scope.variables) {
      if (variable.identifiers[0] === scope.block.id) {
        this.markVariableAsUsed(variable);
        return;
      }
    }
  }

  private visitForInForOf(node: TSESTree.ForInStatement | TSESTree.ForOfStatement): void {
    /**
     * (Brad Zacher): I hate that this has to exist.
     * But it is required for compat with the base ESLint rule.
     *
     * In 2015, ESLint decided to add an exception for these two specific cases
     * ```
     * for (var key in object) return;
     *
     * var key;
     * for (key in object) return;
     * ```
     *
     * I disagree with it, but what are you going to do...
     *
     * https://github.com/eslint/eslint/issues/2342
     */

    let idOrVariable;
    if (node.left.type === AST_NODE_TYPES.VariableDeclaration) {
      const variable = this.#scopeManager.getDeclaredVariables(node.left).at(0);
      if (!variable) {
        return;
      }
      idOrVariable = variable;
    }
    if (node.left.type === AST_NODE_TYPES.Identifier) {
      idOrVariable = node.left;
    }

    if (isNullish(idOrVariable)) {
      return;
    }

    let body = node.body;
    if (node.body.type === AST_NODE_TYPES.BlockStatement) {
      if (node.body.body.length !== 1) {
        return;
      }
      body = ESLintUtils.nullThrows(
        node.body.body[0],
        "Single-statement body must contain its statement.",
      );
    }

    if (body.type !== AST_NODE_TYPES.ReturnStatement) {
      return;
    }

    this.markVariableAsUsed(idOrVariable);
  }

  private visitFunction(node: TSESTree.FunctionDeclaration | TSESTree.FunctionExpression): void {
    const scope = this.getScope(node);
    // skip implicit "arguments" variable
    const variable = scope.set.get("arguments");
    if (variable?.defs.length === 0) {
      this.markVariableAsUsed(variable);
    }
  }

  private visitFunctionTypeSignature(
    node:
      | TSESTree.TSCallSignatureDeclaration
      | TSESTree.TSConstructorType
      | TSESTree.TSConstructSignatureDeclaration
      | TSESTree.TSDeclareFunction
      | TSESTree.TSEmptyBodyFunctionExpression
      | TSESTree.TSFunctionType
      | TSESTree.TSMethodSignature,
  ): void {
    // function type signature params create variables because they can be referenced within the signature,
    // but they obviously aren't unused variables for the purposes of this rule.
    for (const param of node.params) {
      this.visitPattern(param, (name) => {
        this.markVariableAsUsed(name);
      });
    }
  }

  private visitSetter(node: TSESTree.MethodDefinition | TSESTree.Property): void {
    if (node.kind === "set") {
      // ignore setter parameters because they're syntactically required to exist
      for (const param of (node.value as TSESTree.FunctionLike).params) {
        this.visitPattern(param, (id) => {
          this.markVariableAsUsed(id);
        });
      }
    }
  }

  //#endregion VISITORS
}

//#region private helpers

/**
 * Checks the position of given nodes.
 * @param inner A node which is expected as inside.
 * @param outer A node which is expected as outside.
 * @returns `true` if the `inner` node exists in the `outer` node.
 */

/**
 * Determine if an identifier is referencing an enclosing name.
 * This only applies to declarations that create their own scope (modules, functions, classes)
 * @param ref The reference to check.
 * @param nodes The candidate function nodes.
 * @returns True if it's a self-reference, false if not.
 */

const MERGEABLE_TYPES = new Set([
  AST_NODE_TYPES.ClassDeclaration,
  AST_NODE_TYPES.FunctionDeclaration,
  AST_NODE_TYPES.TSInterfaceDeclaration,
  AST_NODE_TYPES.TSModuleDeclaration,
  AST_NODE_TYPES.TSTypeAliasDeclaration,
]);
/**
 * Determine if the variable is directly exported
 * @param variable the variable to check
 */
function isMergeableExported(variable: ScopeVariable): boolean {
  // If all of the merged things are of the same type, TS will error if not all of them are exported - so we only need to find one
  for (const def of variable.defs) {
    // parameters can never be exported.
    // their `node` prop points to the function decl, which can be exported
    // so we need to special case them
    if (def.type === Scope.DefinitionType.Parameter) {
      continue;
    }

    if (
      (MERGEABLE_TYPES.has(def.node.type) &&
        def.node.parent.type === AST_NODE_TYPES.ExportNamedDeclaration) ||
      def.node.parent.type === AST_NODE_TYPES.ExportDefaultDeclaration
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Determines if a given variable is being exported from a module.
 * @param variable eslint-scope variable object.
 * @returns True if the variable is exported, false if not.
 */
function isExported(variable: ScopeVariable): boolean {
  return variable.defs.some((definition) => {
    let node = definition.node;

    if (node.type === AST_NODE_TYPES.VariableDeclarator) {
      node = node.parent;
    } else if (definition.type === Scope.DefinitionType.Parameter) {
      return false;
    }

    return node.parent.type.startsWith("Export");
  });
}

/**
 * Determines if the variable is used.
 * @param variable The variable to check.
 * @returns True if the variable is used
 */

//#endregion private helpers

/**
 * Collects the set of unused variables for a given context.
 *
 * Due to complexity, this does not take into consideration:
 * - variables within declaration files
 * - variables within ambient module declarations
 */
export function collectVariables<MessageIds extends string, Options extends readonly unknown[]>(
  context: Readonly<TSESLint.RuleContext<MessageIds, Options>>,
): VariableAnalysis {
  return UnusedVarsVisitor.collectUnusedVariables(
    context.sourceCode.ast,
    ESLintUtils.nullThrows(context.sourceCode.scopeManager, "Missing required scope manager"),
  );
}
