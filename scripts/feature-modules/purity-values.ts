import { walk } from "./surface-lexical.mjs";
import type {
  Node,
  Program,
  ImportDeclaration,
  ObjectExpression,
  MemberExpression,
} from "oxc-parser";
type Syntax = Node | null | undefined;
type Parents = ReadonlyMap<Node, Node | null | undefined>;
export type ValueShape =
  | "scalar"
  | "regexp"
  | "function"
  | "error-constructor"
  | (ValueShape | undefined)[]
  | Map<string, ValueShape>;
export const member = (node: Syntax, name: string) =>
  node?.type === "MemberExpression" &&
  !node.computed &&
  !node.optional &&
  node.property.name === name;
export const literal = (node: Syntax, value: unknown) =>
  node?.type === "Literal" && node.value === value;

export const transparent: ReadonlySet<string | undefined> = new Set([
  "TSAsExpression",
  "TSTypeAssertion",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "ParenthesizedExpression",
]);
export const unwrap = (node: Syntax): Syntax =>
  transparent.has(node?.type) ? unwrap((node as Node & { expression: Node }).expression) : node;
export function inertData(node: Syntax): ValueShape | undefined {
  node = unwrap(node);
  if (node?.type === "Literal" && (node as Node & { regex?: { flags: string } }).regex) {
    return /[gy]/u.test((node as Node & { regex?: { flags: string } }).regex!.flags)
      ? undefined
      : "regexp";
  }
  if (node?.type === "Literal" && !(node as Node & { regex?: { flags: string } }).regex) {
    return "scalar";
  }
  if (
    node?.type === "UnaryExpression" &&
    ["+", "-", "!", "~"].includes(node.operator) &&
    inertData(node.argument) === "scalar"
  ) {
    return "scalar";
  }
  if (node?.type === "ArrayExpression") {
    const items = node.elements.map(inertData);
    return items.every(Boolean) ? items : undefined;
  }
  if (node?.type === "ObjectExpression") {
    return inertRecord(node);
  }
}
function inertRecord(node: ObjectExpression): ValueShape | undefined {
  const entries: [string, ValueShape][] = [];
  for (const property of node.properties) {
    if (
      property.type !== "Property" ||
      property.computed ||
      property.method ||
      property.kind !== "init"
    ) {
      return;
    }
    const value = inertData(property.value),
      key =
        (property.key as { name?: string; value?: unknown }).name ??
        String((property.key as { value?: unknown }).value);
    if (value === undefined || key === "__proto__") {
      return;
    }
    entries.push([key, value]);
  }
  return new Map(entries);
}
function projection(shape: ValueShape | undefined, node: MemberExpression): ValueShape | undefined {
  if (shape === "scalar" || node.optional) {
    return;
  }
  const key = node.computed
    ? node.property.type === "Literal"
      ? String(node.property.value)
      : undefined
    : (node.property as { name?: string }).name;
  if (Array.isArray(shape) && key === "length") {
    return "scalar";
  }
  // An unknown property can select a prototype or method rather than table
  // data. Do not infer a runtime key domain from a TypeScript annotation.
  if (key === undefined) {
    return;
  }
  return Array.isArray(shape)
    ? /^(?:0|[1-9]\d*)$/u.test(key)
      ? shape[Number(key)]
      : undefined
    : (shape as Map<string, ValueShape>).get(key);
}
function errorConstructorRead(node: Node, parent: Syntax, parents: Parents): boolean {
  return (
    parent?.type === "ExportSpecifier" ||
    (parent?.type === "NewExpression" &&
      parent.callee === node &&
      parent.arguments.length === 1 &&
      parent.arguments.at(0)!.type !== "SpreadElement" &&
      parents.get(parent)?.type === "ThrowStatement")
  );
}
function terminalScalarRead(
  node: Node,
  shape: ValueShape | undefined,
  parent: Syntax,
  parents: Parents,
): boolean {
  if (shape === "function") {
    return (
      (parent?.type === "CallExpression" && parent.callee === node) ||
      parent?.type === "ExportSpecifier"
    );
  }
  if (shape !== "scalar") {
    return false;
  }
  // Destructuring leaves may be writes. Wrappers are transparent at every step.
  while (
    ["Property", "ObjectPattern", "ArrayPattern", "RestElement"].includes(parent?.type as string) ||
    transparent.has(parent?.type)
  ) {
    node = parent!;
    parent = parents.get(node);
  }
  return !writesOrCalls(node, parent);
}
export function scalarRead(node: Node, shape: ValueShape | undefined, parents: Parents): boolean {
  let parent = parents.get(node);
  if (shape === "error-constructor") {
    return errorConstructorRead(node, parent, parents);
  }
  while (
    transparent.has(parent?.type) ||
    (parent?.type === "MemberExpression" && parent.object === node)
  ) {
    if (!transparent.has(parent!.type)) {
      if (shape === "function") {
        return false;
      }
      if (shape === "regexp") {
        return readOnlyPatternCall(parent!, parents);
      }
      shape = projection(shape, parent as MemberExpression);
      if (shape === undefined) {
        return false;
      }
    }
    node = parent!;
    parent = parents.get(node);
  }
  return terminalScalarRead(node, shape, parent, parents);
}
function readOnlyPatternCall(node: Node, parents: Parents): boolean {
  if (!["test", "exec"].some((name) => member(node, name))) {
    return false;
  }
  let parent = parents.get(node);
  while (transparent.has(parent?.type)) {
    node = parent!;
    parent = parents.get(node);
  }
  return (
    parent?.type === "CallExpression" &&
    parent.callee === node &&
    !parent.optional &&
    parent.arguments.length === 1 &&
    parent.arguments.at(0)!.type !== "SpreadElement"
  );
}
function writesOrCalls(node: Node, parent: Syntax): boolean {
  if (parent?.type === "UpdateExpression") {
    return true;
  }
  if (parent?.type === "UnaryExpression") {
    return parent.operator === "delete";
  }
  if (
    ["AssignmentExpression", "AssignmentPattern", "ForOfStatement", "ForInStatement"].includes(
      parent?.type as string,
    )
  ) {
    return (parent as Node & { left: Node }).left === node;
  }
  return parent?.type === "CallExpression" && parent.callee === node;
}

function hashChain(call: Node, parents: Parents): boolean {
  const updateMember = parents.get(call),
    updateCall = parents.get(updateMember as Node);
  const digestMember = parents.get(updateCall as Node),
    digestCall = parents.get(digestMember as Node);
  const args =
    (updateCall !== null && updateCall !== undefined && "arguments" in updateCall
      ? updateCall.arguments
      : undefined) ?? [];
  const explicitBytes =
    args.length >= 1 &&
    args.length <= 2 &&
    args.at(0)!.type !== "SpreadElement" &&
    (args.length === 1 || ["utf8", "utf-8"].some((encoding) => literal(args[1], encoding)));
  return (
    member(updateMember, "update") &&
    updateCall?.type === "CallExpression" &&
    !updateCall.optional &&
    explicitBytes &&
    member(digestMember, "digest") &&
    digestCall?.type === "CallExpression" &&
    !digestCall.optional &&
    digestCall.arguments.length === 1 &&
    literal(digestCall.arguments[0], "hex")
  );
}

// Deliberately one qualified operation, not permission for the crypto module.
// Every createHash binding must be used as a complete, fixed SHA-256 chain.
export function deterministicHashImport(program: Program, start: number): boolean {
  const declaration = program.body.find(
    (node): node is ImportDeclaration =>
      node.type === "ImportDeclaration" && node.source.start === start,
  );
  if (
    declaration?.specifiers.length === undefined ||
    declaration.specifiers.length === 0 ||
    declaration.specifiers.some(
      (node) =>
        node.type !== "ImportSpecifier" ||
        (node.imported as { name?: string }).name !== "createHash",
    )
  ) {
    return false;
  }
  const names = new Set(declaration.specifiers.map(({ local }) => local.name));
  const parents = new Map<Node, Node | null | undefined>();
  walk(program, (node: Node, parent: Node | null | undefined) => parents.set(node, parent));
  const validation: { valid: boolean; calls: number } = { valid: true, calls: 0 };
  walk(program, (node: Node, parent: Node | null | undefined) => {
    if (node.type !== "Identifier" || !names.has(node.name) || parent?.type === "ImportSpecifier") {
      return;
    }
    if (
      parent?.type !== "CallExpression" ||
      parent.callee !== node ||
      parent.optional ||
      parent.arguments.length !== 1 ||
      !literal(parent.arguments[0], "sha256")
    ) {
      validation.valid = false;
      return;
    }
    if (!hashChain(parent, parents)) {
      validation.valid = false;
    }
    validation.calls += 1;
  });
  return validation.valid && validation.calls > 0;
}
