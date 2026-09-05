import { unstableFactoryBindings } from "./factory-stability.mjs";
const identifier = (node) => node?.type === "Identifier";
const staticMember = (node) => node?.type === "MemberExpression" && !node.computed && !node.optional && identifier(node.property);
const functions = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const unknown = () => [undefined];
// A terminal selector for runtime identity, distinct from object enumeration.
export const callableSelection = Symbol("callable");
const propertyName = (node) => node?.type === "Identifier" ? node.name : node?.type === "Literal" && ["string", "number"].includes(typeof node.value) ? String(node.value) : undefined;

export function flatBindings(pattern) {
  if (identifier(pattern)) {return [{ name: pattern.name, selection: [] }];}
  if (pattern?.type !== "ObjectPattern") {return [];}
  const names = new Set();
  const result = [];
  for (const property of pattern.properties) {
    const key = propertyName(property.key);
    if (property.type !== "Property" || property.computed || !identifier(property.value) || key === undefined || names.has(key)) {return [];}
    names.add(key);
    result.push({ name: property.value.name, selection: [key] });
  }
  return result;
}

function objectProperties(node) {
  if (node?.type !== "ObjectExpression") {return;}
  const properties = new Map();
  for (const property of node.properties) {
    const name = propertyName(property.key);
    if (property.type !== "Property" || property.computed || property.kind !== "init" || name === undefined || properties.has(name) || (name === "__proto__" && !property.shorthand && !property.method)) {return;}
    properties.set(name, property.value);
  }
  return properties;
}

// Initialization may not hand a newly declared closure to an arbitrary caller,
// which could replace a returned local binding before the final object is read.
function inputValue(node, declared) {
  if (identifier(node)) {return !declared.has(node.name);}
  if (node?.type === "Literal") {return true;}
  if (staticMember(node)) {return inputValue(node.object, declared);}
  const properties = objectProperties(node);
  if (properties) {return [...properties.values()].every((value) => inputValue(value, declared));}
  if (node?.type === "ArrayExpression") {return node.elements.every((value) => inputValue(value, declared));}
  return false;
}
function stableInitializer(node, declared) {
  if (!node) {return false;}
  if (identifier(node) || node.type === "Literal" || functions.has(node.type)) {return true;}
  if (staticMember(node)) {return stableInitializer(node.object, declared);}
  if (["TSAsExpression", "TSSatisfiesExpression"].includes(node.type)) {return stableInitializer(node.expression, declared);}
  if (["CallExpression", "NewExpression"].includes(node.type)) {
    return !node.optional && identifier(node.callee) && !declared.has(node.callee.name) && node.arguments.every((argument) => inputValue(argument, declared));
  }
  const properties = objectProperties(node);
  if (properties) {return [...properties.values()].every((value) => stableInitializer(value, declared));}
  return node.type === "ArrayExpression" && node.elements.every((value) => stableInitializer(value, declared));
}

function functionLocals(origin) {
  const locals = new Map(origin.locals);
  if (origin.node.type === "FunctionExpression" && origin.node.id) {
    locals.set(origin.node.id.name, { ...origin, locals });
  }
  return locals;
}
function factoryFrame(origin, call) {
  const fn = origin.node;
  if (origin.typeOnly || !functions.has(fn?.type) || !fn.body || fn.async || fn.generator || !fn.params.every(identifier) || fn.params.length !== call.node.arguments.length || call.node.arguments.some((argument) => argument.type === "SpreadElement")) {return;}
  const body = fn.body.type === "BlockStatement" ? fn.body.body : [{ type: "ReturnStatement", argument: fn.body }];
  if (body.at(-1)?.type !== "ReturnStatement") {return;}
  const declarations = body.slice(0, -1);
  if (!declarations.every((node) => (node.type === "FunctionDeclaration" && identifier(node.id)) ||
      (node.type === "VariableDeclaration" && node.kind === "const" && node.declarations.every(({ id, init }) => identifier(id) && init)))) {return;}
  const declared = new Set(declarations.flatMap((node) => node.type === "FunctionDeclaration" ? [node.id.name] : node.declarations.map(({ id }) => id.name)));
  if (declarations.some((node) => node.type === "VariableDeclaration" && node.declarations.some(({ init }) => !stableInitializer(init, declared)))) {return;}
  const locals = functionLocals(origin);
  for (const [index, param] of fn.params.entries()) {locals.set(param.name, { ...call, node: call.node.arguments[index] });}
  for (const declaration of declarations) {
    const bindings = declaration.type === "FunctionDeclaration" ? [{ id: declaration.id, init: declaration }] : declaration.declarations;
    for (const { id, init } of bindings) {locals.set(id.name, { path: origin.path, node: init, locals });}
  }
  for (const [name, instability] of unstableFactoryBindings(body, locals)) {
    locals.set(name, { ...locals.get(name), ...instability });
  }
  return { path: origin.path, node: body.at(-1).argument, locals };
}

export function forwardingParameters(params) {
  const names = params.map((param, index) => identifier(param) ? param.name :
    param.type === "RestElement" && index === params.length - 1 && identifier(param.argument) ? param.argument.name : undefined);
  return names.every((name) => name !== undefined) ? names : undefined;
}
export function forwardedArguments(params, args) {
  const names = forwardingParameters(params);
  return names !== undefined && args.length === params.length && args.every((argument, index) =>
    params[index].type === "RestElement" ? argument.type === "SpreadElement" && identifier(argument.argument) && argument.argument.name === names[index] :
      identifier(argument) && argument.name === names[index]);
}
export function synchronousVoidStatement(fn, body) {
  return !fn.async && fn.returnType?.typeAnnotation?.type === "TSVoidKeyword" && body.length === 1 && body[0].type === "ExpressionStatement"
    ? body[0].expression : undefined;
}

function forwardsArguments(fn, call) {
  if (staticMember(call?.callee) && call.callee.property.name !== fn.id?.name) {return false;}
  return call?.type === "CallExpression" && !call.optional && (identifier(call.callee) || staticMember(call.callee)) &&
    forwardedArguments(fn.params, call.arguments);
}
function forwardedCall(value) {
  const fn = value.node;
  const names = forwardingParameters(fn.params);
  if (!names || fn.generator || !fn.body) {return;}
  const body = fn.body.type === "BlockStatement" ? fn.body.body : [{ type: "ReturnStatement", argument: fn.body }];
  if (body.length !== 1) {return;}
  const returned = body[0].type === "ReturnStatement" ? body[0].argument : synchronousVoidStatement(fn, body);
  const call = returned?.type === "AwaitExpression" ? returned.argument : returned;
  if (!forwardsArguments(fn, call)) {return;}
  const locals = functionLocals(value);
  for (const name of names) {locals.set(name, { path: value.path, node: undefined });}
  return { ...value, node: call.callee, locals };
}

// A receiver can be handed to its methods without changing the object only
// when every possible method is known and cannot observe dynamic `this` or
// evaluate code in the receiver environment. Dynamic evaluation stays unknown.
function receiverIndependent(node) {
  if (!node || typeof node !== "object") {return true;}
  if (["ThisExpression", "Super"].includes(node.type) || (identifier(node) && node.name === "eval")) {return false;}
  return Object.values(node).every((value) => (Array.isArray(value) ? value : [value]).every(receiverIndependent));
}
export function inheritStability(value, source) {
  return { ...value, unstable: value.unstable || source.unstable,
    contentsUnstable: value.contentsUnstable || source.contentsUnstable,
    receiverUnstable: value.receiverUnstable || source.receiverUnstable };
}

/** Resolve a finite value projection; unsupported execution never establishes ownership. */
export function factoryOrigins(hooks) {
  function projectObject(value, selection, active) {
    const properties = objectProperties(value.node);
    if (!properties?.size) {return unknown();}
    if (!selection.length) {return [...properties.values()].flatMap((property) => resolve({ ...value, node: property }, [], active));}
    return resolve({ ...value, node: properties.get(selection[0]) }, selection.slice(1), active);
  }
  function resolve(value, selection, active) {
    const node = value?.node;
    value = { ...value, selection: undefined };
    if (!node || value.unstable) {return unknown();}
    const key = `${value.path}:value:${node.start}:${node.type}:${selection.map(String).join("/")}`;
    const next = hooks.enter(active, key);
    if (!next) {return unknown();}
    if (identifier(node)) {return hooks.identifier(value, selection, next);}
    if (["TSAsExpression", "TSSatisfiesExpression"].includes(node.type)) {return resolve({ ...value, node: node.expression }, selection, next);}
    if (staticMember(node)) {return resolve({ ...value, node: node.object }, [node.property.name, ...selection], next);}
    if (value.contentsUnstable && !functions.has(node.type)) {return unknown();}
    if (value.receiverUnstable && !functions.has(node.type)) {
      const stable = { ...value, receiverUnstable: false };
      const members = resolve(stable, [], active);
      if (!members.length || members.some((member) => !member || !functions.has(member.node.type) || !receiverIndependent(member.node))) {return unknown();}
      return resolve(stable, selection, active);
    }
    return project(value, selection, next);
  }
  function project(value, selection, next) {
    const node = value.node;
    if (node.type === "CallExpression" && !node.optional && identifier(node.callee)) {
      const callees = resolve({ ...value, node: node.callee }, [callableSelection], next);
      return callees.flatMap((callee) => {
        const frame = callee && factoryFrame(callee, value);
        return frame ? resolve(frame, selection, next) : unknown();
      });
    }
    if (node.type === "ObjectExpression") {return projectObject(value, selection, next);}
    if (selection.length) {return selection.length === 1 && selection[0] === callableSelection && functions.has(node.type) ? hooks.owned(value) : unknown();}
    if (functions.has(node.type) && hooks.isComposition(value.path)) {
      const forwarded = forwardedCall(value);
      if (forwarded) {return resolve(forwarded, [], next);}
    }
    return functions.has(node.type) || ["Literal", "ClassDeclaration", "TSInterfaceDeclaration", "TSTypeAliasDeclaration", "TSEnumDeclaration", "TSDeclareFunction"].includes(node.type)
      ? hooks.owned(value) : unknown();
  }
  return resolve;
}
