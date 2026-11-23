import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import type * as TSESTree from "./ast.js";
import { ScopeType, type Definition } from "./scope-contract.js";

export { DefinitionType, ScopeType } from "./scope-contract.js";
export type { Definition, ImportBindingDefinition } from "./scope-contract.js";

export interface ScopeVariable {
  readonly defs: Definition[];
  eslintUsed: boolean;
  readonly identifiers: TSESTree.Identifier[];
  readonly name: string;
  readonly references: Reference[];
  readonly scope: Scope;
  readonly isTypeVariable?: boolean;
  readonly isValueVariable?: boolean;
  eslintExplicitGlobalComments?: TSESTree.Comment[] | undefined;
}

export interface Reference {
  readonly from: Scope;
  readonly identifier: TSESTree.Identifier | TSESTree.JSXIdentifier;
  readonly init?: boolean;
  resolved: ScopeVariable | null;
  readonly writeExpr?: TSESTree.Node | null;
  readonly isTypeReference: boolean;
  readonly isValueReference: boolean;
  isWrite(): boolean;
  isRead(): boolean;
  isReadOnly(): boolean;
  isWriteOnly(): boolean;
  isReadWrite(): boolean;
}

interface ScopeBase {
  readonly upper: Scope | null;
  readonly variableScope: Scope;
  readonly childScopes: Scope[];
  readonly functionExpressionScope: boolean;
  readonly set: Map<string, ScopeVariable>;
  readonly variables: ScopeVariable[];
  readonly references: Reference[];
}

export type Scope = ScopeBase &
  (
    | {
        readonly type: ScopeType.function;
        readonly block:
          | TSESTree.ArrowFunctionExpression
          | TSESTree.FunctionDeclaration
          | TSESTree.FunctionExpression
          | TSESTree.Program
          | TSESTree.TSDeclareFunction
          | TSESTree.TSEmptyBodyFunctionExpression;
      }
    | {
        readonly type: Exclude<ScopeType, ScopeType.function>;
        readonly block: TSESTree.Node;
      }
  );

export interface ClassScope extends ScopeBase {
  readonly type: ScopeType.class;
  readonly block: TSESTree.ClassDeclaration | TSESTree.ClassExpression;
}

export interface ScopeManager {
  readonly scopes: Scope[];
  acquire(node: TSESTree.Node, inner?: boolean): Scope | null;
  getDeclaredVariables(node: TSESTree.Node): ScopeVariable[];
}

interface VisitorOptions {
  visitChildrenEvenIfSelectorExists?: boolean;
}
type PatternCallback = (node: TSESTree.Identifier) => void;
interface VisitorInstance {
  visit(node: TSESTree.Node | null | undefined): void;
  visitPattern(node: TSESTree.Node, callback: PatternCallback): void;
}
interface VisitorConstructor {
  new (options: VisitorOptions): VisitorInstance;
}
interface PatternVisitorConstructor {
  new (
    options: VisitorOptions,
    rootPattern: TSESTree.Node,
    callback: PatternCallback,
  ): Pick<VisitorInstance, "visit">;
}
interface InstanceIdentity {
  [Symbol.hasInstance](value: unknown): boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasPrototypeMethods(value: unknown, methods: readonly string[]): boolean {
  if (typeof value !== "function") {
    return false;
  }
  const prototype: unknown = Reflect.get(value, "prototype");
  return isRecord(prototype) && methods.every((method) => typeof prototype[method] === "function");
}
function isVisitorConstructor(value: unknown): value is VisitorConstructor {
  return hasPrototypeMethods(value, ["visit", "visitPattern"]);
}
function isPatternVisitorConstructor(value: unknown): value is PatternVisitorConstructor {
  return hasPrototypeMethods(value, ["visit"]);
}
function isInstanceIdentity(value: unknown): value is InstanceIdentity {
  return typeof value === "function" && typeof value[Symbol.hasInstance] === "function";
}

const require = createRequire(import.meta.url);
const scopeManifest: unknown = JSON.parse(
  readFileSync(require.resolve("@typescript-eslint/scope-manager/package.json"), "utf8"),
);
if (
  !isRecord(scopeManifest) ||
  scopeManifest["name"] !== "@typescript-eslint/scope-manager" ||
  scopeManifest["version"] !== "8.73.0"
) {
  throw new Error(
    "stack-toolchain/eslint-syntax requires the qualified scope-manager 8.73.0 package.",
  );
}
const scopeEntry = realpathSync(require.resolve("@typescript-eslint/scope-manager"));
const scopeModule: unknown = require("@typescript-eslint/scope-manager");
if (!isRecord(scopeModule)) {
  throw new Error("The qualified scope-manager public exports are missing.");
}
const visitor = scopeModule["Visitor"];
const patternVisitor = scopeModule["PatternVisitor"];
const implicitLibVariable = scopeModule["ImplicitLibVariable"];
const scopeManager = scopeModule["ScopeManager"];
if (
  !isVisitorConstructor(visitor) ||
  !isPatternVisitorConstructor(patternVisitor) ||
  !isInstanceIdentity(implicitLibVariable) ||
  !isInstanceIdentity(scopeManager) ||
  !hasPrototypeMethods(scopeManager, ["acquire", "getDeclaredVariables"])
) {
  throw new Error("The qualified scope-manager constructor contract is missing.");
}

/** Original constructors: never substituted, wrapped, subclass-copied or synthesized. */
export const Visitor = visitor;
export const PatternVisitor = patternVisitor;
export const ImplicitLibVariable = implicitLibVariable;
const admittedScopeManager = scopeManager;

/** Checks the actual native result without loading a second issuer's module. */
export function isAdmittedScopeManager(value: unknown): value is ScopeManager {
  return value instanceof admittedScopeManager;
}

export function assertScopeResolution(candidateRequire: NodeJS.Require): void {
  const candidateManifest: unknown = JSON.parse(
    readFileSync(candidateRequire.resolve("@typescript-eslint/scope-manager/package.json"), "utf8"),
  );
  if (
    !isRecord(candidateManifest) ||
    candidateManifest["name"] !== "@typescript-eslint/scope-manager" ||
    candidateManifest["version"] !== "8.73.0" ||
    realpathSync(candidateRequire.resolve("@typescript-eslint/scope-manager")) !== scopeEntry
  ) {
    throw new Error(
      "The parser must resolve the same qualified scope-manager before initialization.",
    );
  }
}
