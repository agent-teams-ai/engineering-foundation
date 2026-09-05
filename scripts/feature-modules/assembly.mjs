import { isPublicAssemblyFacade } from "./assembly-facade.mjs";

const lifecycle = new Set(["start", "ready", "stop", "dispose", "close"]);
const identifier = (node) => node?.type === "Identifier";
const staticMember = (node) => node?.type === "MemberExpression" && !node.computed && !node.optional;
const callable = (node, context) => identifier(node) && context.names.get(node.name) === "factory";

function inertType(node, context) {
  if (!node) {return false;}
  if (node.type === "TSTypeQuery") {return identifier(node.exprName) && context.names.has(node.exprName.name);}
  if (node.type === "TSTypeReference") {return identifier(node.typeName) && context.names.has(node.typeName.name) && !node.typeArguments;}
  if (node.type === "TSArrayType") {return inertType(node.elementType, context);}
  if (node.type === "TSTypeOperator" && node.operator === "readonly") {return inertType(node.typeAnnotation, context);}
  return false;
}
function processValue(node, context) {
  return context.executable && staticMember(node) && node.object.name === "process" &&
    ["argv", "stdin", "stdout", "stderr"].includes(node.property.name) && !context.names.has("process");
}
function resourceMethod(node, context) {
  return context.executable && staticMember(node) && identifier(node.object) &&
    context.names.get(node.object.name) === "resource" && lifecycle.has(node.property.name);
}
function wiring(node, context) {
  if (!node) {return false;}
  switch (node.type) {
    case "Identifier": return context.names.has(node.name) && context.names.get(node.name) !== "type";
    case "Literal": return !node.regex;
    case "CallExpression": case "NewExpression": return factoryCall(node, context);
    case "AwaitExpression": return context.executable && factoryCall(node.argument, context);
    case "TSAsExpression": case "TSSatisfiesExpression": return wiring(node.expression, context);
    case "MemberExpression": return processValue(node, context) || resourceMethod(node, context) ||
      (staticMember(node) && identifier(node.object) && ["input", "data", "resource"].includes(context.names.get(node.object.name)));
    case "ObjectExpression": return node.properties.every((property) => property.type === "Property" && !property.computed &&
      !property.method && property.kind === "init" && wiring(property.value, context));
    case "ArrayExpression": return node.elements.every((element) => wiring(element, context));
    default: return false;
  }
}
function lifecycleCall(node, context) {
  if (!context.executable || node.type !== "CallExpression" || !staticMember(node.callee)) {return false;}
  const callee = node.callee;
  if (resourceMethod(callee, context)) {return node.arguments.every((arg) => wiring(arg, context));}
  if (callee.object.name === "process" && !context.names.has("process") && ["on", "once"].includes(callee.property.name)) {
    const [event, handler] = node.arguments;
    return node.arguments.length === 2 && event?.type === "Literal" && ["SIGINT", "SIGTERM", "beforeExit"].includes(event.value) &&
      (callable(handler, context) || resourceMethod(handler, context));
  }
  return ["then", "catch", "finally"].includes(callee.property.name) && factoryCall(callee.object, context) &&
    node.arguments.length === 1 && callable(node.arguments[0], context);
}
function factoryCall(node, context) {
  if (!node || !["CallExpression", "NewExpression"].includes(node.type) || node.optional) {return false;}
  return (callable(node.callee, context) && node.arguments.every((argument) => wiring(argument, context))) || lifecycleCall(node, context);
}
function resourceDelegation(node, context) {
  if (node?.type !== "CallExpression" || node.optional) {return false;}
  const target = staticMember(node.callee) ? node.callee.object : undefined;
  return identifier(target) && context.names.get(target.name) === "resource" &&
    node.callee.property.name === context.wrapperName && node.arguments.length === context.wrapperParameters.length &&
    node.arguments.every((argument, index) => identifier(argument) && argument.name === context.wrapperParameters[index].name);
}
function delegation(node, context, returnPosition = false) {
  if (returnPosition && resourceDelegation(node, context)) {return true;}
  if (callable(node, context) || factoryCall(node, context)) {return true;}
  if (identifier(node) && context.names.get(node.name) === "resource") {return true;}
  if (staticMember(node) && identifier(node.object) && context.names.get(node.object.name) === "resource") {return true;}
  if (node?.type === "AwaitExpression") {return factoryCall(node.argument, context) || (returnPosition && resourceDelegation(node.argument, context));}
  if (["ObjectExpression", "ArrayExpression"].includes(node?.type)) {return wiring(node, context) && containsOrigin(node, context);}
  return false;
}
function containsOrigin(node, context) {
  if (identifier(node)) {return context.names.has(node.name);}
  if (["CallExpression", "NewExpression", "MemberExpression"].includes(node?.type)) {return true;}
  if (node?.type === "ObjectExpression") {return node.properties.some((property) => containsOrigin(property.value, context));}
  if (node?.type === "ArrayExpression") {return node.elements.some((element) => containsOrigin(element, context));}
  return false;
}
function wrapper(node, context) {
  const nested = { ...context, names: new Map(context.names), wrapperName: node.id?.name, wrapperParameters: node.params };
  if (!node.params.every(identifier) || node.declare || !node.body) {return false;}
  if (node.type === "FunctionExpression" && node.id) {nested.names.set(node.id.name, "input");}
  for (const param of node.params) {nested.names.set(param.name, "input");}
  if (node.body.type !== "BlockStatement") {return delegation(node.body, nested, true);}
  if (!node.body.body.length) {return false;}
  if (!nested.executable && node.body.body.at(-1).type !== "ReturnStatement") {return false;}
  return node.body.body.every((statement) => statement.type === "ReturnStatement"
    ? delegation(statement.argument, nested, true) : statement.type === "VariableDeclaration"
      ? variables(statement, nested) : nested.executable && executableStatement(statement, nested));
}
function variables(node, context) {
  if (node.kind !== "const") {return false;}
  return node.declarations.every(({ id, init }) => {
    if (!identifier(id) || !init) {return false;}
    // A local binding must not inherit a shadowed import's origin.
    const previous = context.names.get(id.name);
    context.names.delete(id.name);
    const isWrapper = ["ArrowFunctionExpression", "FunctionExpression"].includes(init.type);
    const valid = isWrapper ? wrapper(init, context) : delegation(init, context);
    if (valid) {context.names.set(id.name, isWrapper || callable(init, context) ? "factory" : "resource");}
    else if (previous) {context.names.set(id.name, previous);}
    return valid;
  });
}
function executableStatement(node, context) {
  if (node.type === "TryStatement") {
    return !node.handler && Boolean(node.finalizer) && [...node.block.body, ...node.finalizer.body].every((child) => executableStatement(child, context));
  }
  if (node.type !== "ExpressionStatement") {return false;}
  let expression = node.expression;
  if (expression.type === "UnaryExpression" && expression.operator === "void") {expression = expression.argument;}
  if (expression.type === "AwaitExpression") {expression = expression.argument;}
  if (expression.type === "AssignmentExpression") {
    const left = expression.left;
    if (expression.operator !== "=" || !staticMember(left) || left.object.name !== "process" || left.property.name !== "exitCode" || context.names.has("process")) {return false;}
    return delegation(expression.right, context);
  }
  return factoryCall(expression, context);
}
function assemblyStatement(node, context) {
  if (["ImportDeclaration", "EmptyStatement"].includes(node.type)) {return true;}
  if (node.type === "ExportNamedDeclaration") {
    return node.declaration ? assemblyStatement(node.declaration, context) : Boolean(node.source) || node.specifiers.every(({ local }) => context.names.has(local.name));
  }
  if (node.type === "TSTypeAliasDeclaration" && !node.typeParameters && inertType(node.typeAnnotation, context)) {context.names.set(node.id.name, "type"); return true;}
  if (node.type === "ClassDeclaration") {
    const valid = isPublicAssemblyFacade(node, context, wiring);
    if (valid) {context.names.set(node.id.name, "factory");}
    return valid;
  }
  if (node.type === "VariableDeclaration") {return variables(node, context);}
  if (node.type === "FunctionDeclaration") {
    const valid = wrapper(node, context);
    if (valid) {context.names.set(node.id.name, "factory");}
    return valid;
  }
  return context.executable && executableStatement(node, context);
}
export function invalidAssemblyStatements(path, surface, bindings, executable) {
  const names = new Map();
  for (const [name, binding] of surface.imports) {
    const observation = bindings.observation(path, binding.node.source.start);
    const typeOnly = binding.node.importKind === "type" || binding.node.specifiers.find((item) => item.local.name === name)?.importKind === "type";
    if (typeOnly) {names.set(name, "type");}
    else if (binding.name !== "*" && observation && ["local-file", "workspace-package"].includes(observation.result.kind)) {names.set(name, "factory");}
  }
  const context = { names, executable };
  return surface.program.body.filter((node) => !assemblyStatement(node, context));
}
