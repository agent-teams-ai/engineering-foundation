import { visitorKeys, type BindingPattern, type Expression, type Node } from "oxc-parser";

/** Private Oxc vocabulary. It never crosses the source-dependency parser port. */
export interface LoaderOrigin {
  readonly kind: "loader" | "factory" | "module" | "commonjs-module" | "process" | "builtin-getter" | "bound-loader-factory";
  readonly opaque?: boolean;
}

export interface BindingInput {
  readonly expression: Expression;
  readonly properties: readonly string[];
}

export interface LexicalBinding {
  readonly inputs: BindingInput[];
  readonly declaredOrigin?: LoaderOrigin;
  readonly initialBinding?: LexicalBinding;
  mutable: boolean;
}

export interface LexicalScope {
  readonly bindings: Map<string, LexicalBinding>;
  readonly kind: "block" | "function" | "program";
  readonly parent?: LexicalScope;
  readonly varInitialBindings?: ReadonlyMap<string, LexicalBinding>;
}

export function childNodes(node: Node): readonly Node[] {
  const record = node as unknown as Record<string, unknown>;
  return (visitorKeys[node.type] ?? []).flatMap((key) => {
    const value = record[key];
    const values: unknown[] = Array.isArray(value) ? value : [value];
    return values.filter((item): item is Node =>
      typeof item === "object" && item !== null && "type" in item
    );
  });
}

/** Type-only module declarations are erased and cannot establish runtime ESM. */
export function hasRuntimeModuleSyntax(node: Node, insideFunction = false): boolean {
  if (node.type === "ImportDeclaration") {
    return node.importKind !== "type";
  }
  if (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") {
    return node.exportKind !== "type";
  }
  if (node.type === "ExportDefaultDeclaration") {
    return node.declaration.type !== "TSInterfaceDeclaration" && node.declaration.type !== "TSDeclareFunction";
  }
  if (node.type === "MetaProperty" && node.meta.name === "import") {
    return true;
  }
  if (!insideFunction && (node.type === "AwaitExpression" ||
      (node.type === "ForOfStatement" && node.await))) {
    return true;
  }
  const nestedFunction = insideFunction || node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression";
  return childNodes(node).some((child) => hasRuntimeModuleSyntax(child, nestedFunction));
}

export function propertyName(node: Node, computed: boolean): string | undefined {
  if (!computed && node.type === "Identifier") {
    return node.name;
  }
  return node.type === "Literal" && typeof node.value === "string" ? node.value : undefined;
}

function projectDefaults(inputs: readonly BindingInput[], property: string): readonly BindingInput[] {
  return inputs.map((input) => ({ ...input, properties: [...input.properties, property] }));
}

export function patternBindings(
  pattern: BindingPattern,
  properties: readonly string[] = [],
  defaults: readonly BindingInput[] = []
): readonly { readonly name: string; readonly properties: readonly string[]; readonly defaults: readonly BindingInput[] }[] {
  switch (pattern.type) {
    case "Identifier":
      return [{ name: pattern.name, properties, defaults }];
    case "AssignmentPattern":
      return patternBindings(pattern.left, properties, [...defaults, { expression: pattern.right, properties: [] }]);
    case "ArrayPattern":
      return pattern.elements.flatMap((element, index) => element === null ? [] :
        patternBindings(element.type === "RestElement" ? element.argument : element,
          [...properties, String(index)], projectDefaults(defaults, String(index))));
    case "ObjectPattern":
      return pattern.properties.flatMap((property) => property.type === "RestElement"
        ? patternBindings(property.argument, [...properties, "<rest>"], projectDefaults(defaults, "<rest>"))
        : patternBindings(property.value,
          [...properties, propertyName(property.key, property.computed) ?? "<computed>"],
          projectDefaults(defaults, propertyName(property.key, property.computed) ?? "<computed>")));
  }
}

export function unwrapExpression(expression: Expression): Expression {
  if (expression.type === "ParenthesizedExpression" || expression.type === "TSAsExpression" ||
      expression.type === "TSSatisfiesExpression" || expression.type === "TSTypeAssertion" ||
      expression.type === "TSNonNullExpression" || expression.type === "ChainExpression") {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

const MEMBER_ORIGINS = new Map<string, LoaderOrigin>([
  ["commonjs-module:require", { kind: "loader", opaque: true }],
  ["module:createRequire", { kind: "factory" }],
  ["module:default", { kind: "module" }],
  ["process:default", { kind: "process" }],
  ["process:getBuiltinModule", { kind: "builtin-getter" }],
  ["loader:call", { kind: "loader", opaque: true }],
  ["loader:apply", { kind: "loader", opaque: true }],
  ["loader:bind", { kind: "bound-loader-factory" }]
]);

export function memberOrigin(
  object: LoaderOrigin | undefined,
  property: string | undefined,
  retainsReceiver = false
): LoaderOrigin | undefined {
  if (object === undefined || property === undefined) {
    return undefined;
  }
  // Module.prototype.require depends on its receiver. Reading the method alone
  // cannot preserve an importer-relative base, even through a const alias.
  const member = retainsReceiver && object.kind === "commonjs-module" && property === "require"
    ? { kind: "loader" as const } : MEMBER_ORIGINS.get(`${object.kind}:${property}`);
  return member === undefined ? undefined : { ...member, ...(object.opaque === true ? { opaque: true } : {}) };
}

export function builtinOrigin(name: string): LoaderOrigin | undefined {
  if (name === "node:module" || name === "module") {
    return { kind: "module" };
  }
  if (name === "node:process" || name === "process") {
    return { kind: "process" };
  }
  return undefined;
}
