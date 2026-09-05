import { problem } from "./profile.mjs";
import { walk } from "./surfaces.mjs";
import { primitiveErrorClasses } from "./primitive-errors.mjs";

const member = (node, name) => node?.type === "MemberExpression" && !node.computed && !node.optional && node.property.name === name;
const literal = (node, value) => node?.type === "Literal" && node.value === value;

function hashChain(call, parents) {
  const updateMember = parents.get(call), updateCall = parents.get(updateMember);
  const digestMember = parents.get(updateCall), digestCall = parents.get(digestMember);
  const args = updateCall?.arguments ?? [];
  const explicitBytes = args.length >= 1 && args.length <= 2 && args[0].type !== "SpreadElement" &&
    (args.length === 1 || ["utf8", "utf-8"].some((encoding) => literal(args[1], encoding)));
  return member(updateMember, "update") && updateCall?.type === "CallExpression" && !updateCall.optional && explicitBytes &&
    member(digestMember, "digest") && digestCall?.type === "CallExpression" && !digestCall.optional &&
    digestCall.arguments.length === 1 && literal(digestCall.arguments[0], "hex");
}

// Deliberately one qualified operation, not permission for the crypto module.
// Every createHash binding must be used as a complete, fixed SHA-256 chain.
export function deterministicHashImport(program, start) {
  const declaration = program.body.find((node) => node.type === "ImportDeclaration" && node.source.start === start);
  if (!declaration?.specifiers.length || declaration.specifiers.some((node) => node.type !== "ImportSpecifier" || node.imported.name !== "createHash")) {return false;}
  const names = new Set(declaration.specifiers.map(({ local }) => local.name));
  const parents = new Map();
  walk(program, (node, parent) => parents.set(node, parent));
  let valid = true, calls = 0;
  walk(program, (node, parent) => {
    if (node.type !== "Identifier" || !names.has(node.name) || parent?.type === "ImportSpecifier") {return;}
    if (parent?.type !== "CallExpression" || parent.callee !== node || parent.optional || parent.arguments.length !== 1 || !literal(parent.arguments[0], "sha256")) {valid = false; return;}
    if (!hashChain(parent, parents)) {valid = false;}
    calls += 1;
  });
  return valid && calls > 0;
}

const transparent = new Set(["TSAsExpression", "TSTypeAssertion", "TSSatisfiesExpression", "TSNonNullExpression", "ParenthesizedExpression"]);
const unwrap = (node) => transparent.has(node?.type) ? unwrap(node.expression) : node;
const functionNode = (node) => ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node?.type);
const runtimeTypes = new Set(["TSEnumDeclaration", "TSEnumBody", "TSEnumMember", "TSModuleDeclaration", "TSModuleBlock", "TSParameterProperty", "TSInstantiationExpression", "TSExportAssignment"]);
const staticKey = (node) => node.computed ? node.property?.type === "Literal" ? String(node.property.value) : undefined : node.property?.name;

// Lexical bindings only, with no control-flow or interprocedural inference.
// Unknown/reassigned origins cannot qualify a reflective target.
function bindPattern(node, binding, context) {
  if (!node) {return;}
  if (node.type === "Identifier") {
    context.declarations.add(node);
    const entry = { ...binding, id: node };
    binding.frame.names.set(node.name, entry); context.bindings.set(node, entry);
  } else if (node.type === "ObjectPattern") {
    for (const property of node.properties) {
      const key = property.computed ? property.key?.value : property.key?.name ?? property.key?.value;
      const selected = property.type === "Property" && typeof key === "string" ? [...binding.selection, key] : undefined;
      bindPattern(property.value ?? property.argument, { ...binding, selection: selected ?? [], constant: binding.constant && Boolean(selected) }, context);
    }
  } else if (node.type === "ArrayPattern") {
    for (const element of node.elements) {bindPattern(element, { ...binding, constant: false }, context);}
  } else if (["RestElement", "AssignmentPattern"].includes(node.type)) {
    bindPattern(node.argument ?? node.left, { ...binding, constant: false }, context);
  }
}
function lexicalContext(program) {
  const context = { parents: new Map(), scopes: new Map(), declarations: new Set(), bindings: new Map() };
  walk(program, (node, parent) => {
    context.parents.set(node, parent);
    let frame = context.scopes.get(parent);
    if (node.type === "FunctionDeclaration" && node.id) {bindPattern(node.id, { frame, init: node, selection: [], constant: true }, context);}
    if (node === program || functionNode(node) || ["BlockStatement", "ForStatement", "ForInStatement", "ForOfStatement", "SwitchStatement", "CatchClause"].includes(node.type)) {
      frame = { parent: frame, names: new Map(), invocation: functionNode(node) || node === program ? node : frame.invocation };
    }
    context.scopes.set(node, frame);
    const binding = { frame, selection: [], constant: false };
    if (functionNode(node)) {
      if (node.type === "FunctionExpression" && node.id) {bindPattern(node.id, { ...binding, init: node, constant: true }, context);}
      for (const param of node.params) {bindPattern(param, binding, context);}
    }
    if (node.type === "CatchClause") {bindPattern(node.param, binding, context);}
    if (node.type === "VariableDeclarator") {
      if (parent.kind === "var") {while (frame.parent && frame.parent.invocation === frame.invocation) {frame = frame.parent;}}
      bindPattern(node.id, { frame, init: node.init, selection: [], constant: parent.kind === "const" }, context);
    }
    if (["ImportSpecifier", "ImportDefaultSpecifier", "ImportNamespaceSpecifier"].includes(node.type)) {bindPattern(node.local, binding, context);}
    if (["ClassDeclaration", "TSEnumDeclaration"].includes(node.type)) {bindPattern(node.id, binding, context);}
  });
  context.lookup = (node) => {
    if (context.bindings.has(node)) {return context.bindings.get(node);}
    for (let frame = context.scopes.get(node); frame; frame = frame.parent) {
      if (frame.names.has(node.name)) {return frame.names.get(node.name);}
    }
  };
  return context;
}
function propertyKey(node, parent, context) {
  return (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) ||
    (parent?.type === "Property" && parent.key === node && !parent.computed && (!parent.shorthand || context.parents.get(parent)?.type === "ObjectPattern")) ||
    (["PropertyDefinition", "MethodDefinition"].includes(parent?.type) && parent.key === node && !parent.computed);
}
function runtimeReference(node, context) {
  if (node.type !== "Identifier" || context.declarations.has(node)) {return false;}
  let child = node;
  for (let parent = context.parents.get(child); parent; child = parent, parent = context.parents.get(child)) {
    if (parent.type.startsWith("TS") && !runtimeTypes.has(parent.type) && !(transparent.has(parent.type) && parent.expression === child)) {return false;}
  }
  const parent = context.parents.get(node);
  return !propertyKey(node, parent, context) &&
    !["ImportSpecifier", "ExportSpecifier", "LabeledStatement", "BreakStatement", "ContinueStatement"].includes(parent?.type);
}
function inertData(node) {
  node = unwrap(node);
  if (node?.type === "Literal" && node.regex) {return /[gy]/u.test(node.regex.flags) ? undefined : "regexp";}
  if (node?.type === "Literal" && !node.regex) {return "scalar";}
  if (node?.type === "UnaryExpression" && ["+", "-", "!", "~"].includes(node.operator) && inertData(node.argument) === "scalar") {return "scalar";}
  if (node?.type === "ArrayExpression") {
    const items = node.elements.map(inertData);
    return items.every(Boolean) ? items : undefined;
  }
  if (node?.type === "ObjectExpression") {return inertRecord(node);}
}
function inertRecord(node) {
  const entries = [];
  for (const property of node.properties) {
    if (property.type !== "Property" || property.computed || property.method || property.kind !== "init") {return;}
    const value = inertData(property.value), key = property.key.name ?? String(property.key.value);
    if (!value || key === "__proto__") {return;}
    entries.push([key, value]);
  }
  return new Map(entries);
}
function projection(shape, node) {
  if (shape === "scalar" || node.optional) {return;}
  const key = node.computed ? node.property.type === "Literal" ? String(node.property.value) : undefined : node.property.name;
  if (Array.isArray(shape) && key === "length") {return "scalar";}
  // An unknown property can select a prototype or method rather than table
  // data. Do not infer a runtime key domain from a TypeScript annotation.
  if (key === undefined) {return;}
  return Array.isArray(shape) ? /^(?:0|[1-9]\d*)$/u.test(key) ? shape[Number(key)] : undefined : shape.get(key);
}
function errorConstructorRead(node, parent, parents) {
  return parent?.type === "ExportSpecifier" || (parent?.type === "NewExpression" && parent.callee === node &&
    parent.arguments.length === 1 && parent.arguments[0].type !== "SpreadElement" && parents.get(parent)?.type === "ThrowStatement");
}
function terminalScalarRead(node, shape, parent, parents) {
  if (shape === "function") {return (parent?.type === "CallExpression" && parent.callee === node) || parent?.type === "ExportSpecifier";}
  if (shape !== "scalar") {return false;}
  // Destructuring leaves may be writes. Wrappers are transparent at every step.
  while (["Property", "ObjectPattern", "ArrayPattern", "RestElement"].includes(parent?.type) || transparent.has(parent?.type)) {
    node = parent; parent = parents.get(node);
  }
  return !writesOrCalls(node, parent);
}
function scalarRead(node, shape, parents) {
  let parent = parents.get(node);
  if (shape === "error-constructor") {return errorConstructorRead(node, parent, parents);}
  while (transparent.has(parent?.type) || (parent?.type === "MemberExpression" && parent.object === node)) {
    if (!transparent.has(parent.type)) {
      if (shape === "function") {return false;}
      if (shape === "regexp") {return readOnlyPatternCall(parent, parents);}
      shape = projection(shape, parent);
      if (!shape) {return false;}
    }
    node = parent; parent = parents.get(node);
  }
  return terminalScalarRead(node, shape, parent, parents);
}
function readOnlyPatternCall(node, parents) {
  if (!["test", "exec"].some((name) => member(node, name))) {return false;}
  let parent = parents.get(node);
  while (transparent.has(parent?.type)) {node = parent; parent = parents.get(node);}
  return parent?.type === "CallExpression" && parent.callee === node && !parent.optional &&
    parent.arguments.length === 1 && parent.arguments[0].type !== "SpreadElement";
}
function writesOrCalls(node, parent) {
  if (parent?.type === "UpdateExpression") {return true;}
  if (parent?.type === "UnaryExpression") {return parent.operator === "delete";}
  if (["AssignmentExpression", "AssignmentPattern", "ForOfStatement", "ForInStatement"].includes(parent?.type)) {return parent.left === node;}
  return parent?.type === "CallExpression" && parent.callee === node;
}
function validateModuleData(program, failures, context) {
  const bindings = new Map(), { parents } = context;
  for (const statement of program.body) {
    const declaration = statement.declaration ?? statement;
    if (declaration.type === "FunctionDeclaration" && declaration.id) {bindings.set(context.lookup(declaration.id), "function");}
    if (context.errorClasses.has(declaration)) {bindings.set(context.lookup(declaration.id), "error-constructor");}
    if (declaration.type !== "VariableDeclaration") {continue;}
    for (const { id, init } of declaration.declarations) {
      if (id.type !== "Identifier") {failures.add("unknown module binding"); continue;}
      if (functionNode(unwrap(init))) {bindings.set(context.lookup(id), "function"); continue;}
      const shape = inertData(init);
      if (!shape) {failures.add("unknown module initializer"); continue;}
      bindings.set(context.lookup(id), shape);
      if (statement.type === "ExportNamedDeclaration" && shape !== "scalar") {failures.add("module data escape");}
    }
  }
  walk(program, (node, parent) => {
    const binding = context.lookup(node);
    if (!bindings.has(binding) || context.declarations.has(node)) {return;}
    if (!runtimeReference(node, context) && parent?.type !== "ExportSpecifier") {return;}
    if (!scalarRead(node, bindings.get(binding), parents)) {failures.add("mutable module data or unknown state escape");}
  });
}

// Exact ambient operations, never a blanket Object/Reflect/Math permission.
// Calls that mutate or expose object internals need a proven invocation-local
// literal target. Other reflection and callable/container escapes fail closed.
const calls = new Set([
  "Number", "String", "Boolean", "BigInt", "parseInt", "parseFloat", "isFinite", "isNaN",
  "Number.isFinite", "Number.isInteger", "Number.isNaN", "Number.isSafeInteger", "Number.parseFloat", "Number.parseInt",
  "String.fromCharCode", "String.fromCodePoint", "Array.isArray", "Array.of",
  "Object.is", "Object.keys", "Object.values", "Object.entries", "Object.hasOwn",
  "JSON.parse", "JSON.stringify",
  ...["abs", "acos", "acosh", "asin", "asinh", "atan", "atanh", "atan2", "cbrt", "ceil", "clz32", "cos", "cosh", "exp", "expm1", "floor", "fround", "hypot", "imul", "log", "log1p", "log2", "log10", "max", "min", "pow", "round", "sign", "sin", "sinh", "sqrt", "tan", "tanh", "trunc"].map((name) => `Math.${name}`)
]);
const targetCalls = new Map([
  ["Object.assign", [2, Infinity]], ["Object.defineProperty", [3, 3]], ["Object.defineProperties", [2, 2]],
  ["Object.freeze", [1, 1]], ["Object.seal", [1, 1]], ["Object.preventExtensions", [1, 1]],
  ["Reflect.set", [3, 3]], ["Reflect.deleteProperty", [2, 2]], ["Reflect.defineProperty", [3, 3]], ["Reflect.preventExtensions", [1, 1]]
]);
const inspectionCalls = new Map([
  ["Object.getPrototypeOf", 1], ["Object.getOwnPropertyDescriptor", 2], ["Reflect.ownKeys", 1]
]);
const intrinsicPrototypes = new Set(["Object.prototype", "Array.prototype"]);
const scalarGlobals = new Set([
  "undefined", "NaN", "Infinity", "Number.EPSILON", "Number.MAX_SAFE_INTEGER", "Number.MIN_SAFE_INTEGER", "Number.MAX_VALUE", "Number.MIN_VALUE", "Number.NaN", "Number.POSITIVE_INFINITY", "Number.NEGATIVE_INFINITY",
  ...["E", "LN10", "LN2", "LOG10E", "LOG2E", "PI", "SQRT1_2", "SQRT2"].map((name) => `Math.${name}`)
]);
const containers = new Set(["Object", "Reflect", "Math", "Number", "String", "Boolean", "BigInt", "Array", "JSON"]);
const aliasOrigins = [containers, calls, targetCalls, inspectionCalls];
function origin(node, context, active = new Set()) {
  node = unwrap(node);
  if (node?.type === "Identifier") {
    const binding = context.lookup(node);
    if (!binding) {return { ambient: node.name };}
    if (!binding.constant) {return {};}
    if (active.has(binding) || active.size >= 64) {return { ambient: "unknown bounded origin" };}
    if (binding.frame.invocation.type === "Program") {return {};}
    const value = origin(binding.init, context, new Set([...active, binding]));
    if (binding.selection.length) {return value.ambient ? { ambient: [value.ambient, ...binding.selection].join(".") } : {};}
    return value;
  }
  if (node?.type === "MemberExpression") {
    const value = origin(node.object, context, active), key = staticKey(node);
    return value.ambient ? { ambient: `${value.ambient}.${node.optional || key === undefined ? "?" : key}` } : {};
  }
  if (["ObjectExpression", "ArrayExpression"].includes(node?.type)) {return { local: context.scopes.get(node).invocation };}
  return {};
}
function supportedAlias(pattern) {
  if (pattern.type === "Identifier") {return true;}
  return pattern.type === "ObjectPattern" && pattern.properties.length > 0 && pattern.properties.every((property) =>
    property.type === "Property" && (!property.computed || property.key.type === "Literal") && supportedAlias(property.value));
}
function expressionParent(node, context) {
  let parent = context.parents.get(node);
  while (transparent.has(parent?.type)) {node = parent; parent = context.parents.get(node);}
  return { node, parent };
}
function equalityOperand(node, context) {
  const expression = expressionParent(node, context), parent = expression.parent;
  if (parent?.type !== "BinaryExpression" || !["===", "!=="].includes(parent.operator)) {return;}
  return parent.left === expression.node ? parent.right : parent.left;
}
function prototypeResultComparison(node, context) {
  const other = unwrap(equalityOperand(node, context));
  return literal(other, null) || intrinsicPrototypes.has(origin(other, context).ambient);
}
function prototypeObservation(node, context) {
  node = unwrap(node);
  if (node?.type === "Identifier") {
    const binding = context.lookup(node);
    if (!binding?.constant || binding.selection.length || binding.frame.invocation.type === "Program" ||
        binding.frame.invocation !== context.scopes.get(node).invocation) {return false;}
    node = unwrap(binding.init);
  }
  return node?.type === "CallExpression" && !node.optional && node.arguments.length === 1 &&
    node.arguments[0].type !== "SpreadElement" && origin(node.callee, context).ambient === "Object.getPrototypeOf";
}
function boundedPrototypeResult(call, context) {
  if (prototypeResultComparison(call, context)) {return true;}
  const { node, parent } = expressionParent(call, context);
  if (parent?.type !== "VariableDeclarator" || parent.init !== node || parent.id.type !== "Identifier" ||
      context.parents.get(parent).kind !== "const") {return false;}
  const binding = context.lookup(parent.id), invocation = context.scopes.get(call).invocation;
  let uses = 0;
  for (const reference of context.parents.keys()) {
    if (!runtimeReference(reference, context) || context.lookup(reference) !== binding) {continue;}
    if (context.scopes.get(reference).invocation !== invocation || !prototypeResultComparison(reference, context)) {return false;}
    uses += 1;
  }
  return uses > 0;
}
function localCollectionConstruction(name, callee, expression, context) {
  return ["Set", "WeakSet"].includes(name) && unwrap(callee)?.type === "Identifier" &&
    expression.callee === callee && expression.arguments.length === 0 &&
    context.scopes.get(expression).invocation.type !== "Program";
}
function supportedCall(name, call, context) {
  if (call.optional || call.arguments.some((arg) => arg.type === "SpreadElement")) {return false;}
  if (calls.has(name)) {return true;}
  if (inspectionCalls.has(name)) {
    return call.arguments.length === inspectionCalls.get(name) && context.scopes.get(call).invocation.type !== "Program" &&
      (name !== "Object.getPrototypeOf" || boundedPrototypeResult(call, context));
  }
  const bounds = targetCalls.get(name), invocation = context.scopes.get(call).invocation;
  return Boolean(bounds && call.arguments.length >= bounds[0] && call.arguments.length <= bounds[1] &&
    origin(call.arguments[0], context).local === invocation && invocation.type !== "Program");
}
function thrownTypeError(name, callee, expression, parents) {
  if (name !== "TypeError" || expression.callee !== callee || expression.arguments.length !== 1 || expression.arguments[0].type === "SpreadElement") {return false;}
  let owner = parents.get(expression);
  while (transparent.has(owner?.type)) {expression = owner; owner = parents.get(expression);}
  return owner?.type === "ThrowStatement" && owner.argument === expression;
}
function ambientAlias(node, parent, context) {
  return parent?.type === "VariableDeclarator" && parent.init === node && context.parents.get(parent).kind === "const" && supportedAlias(parent.id);
}
function ambientUse(node, context) {
  let parent = context.parents.get(node);
  while (transparent.has(parent?.type) || (parent?.type === "MemberExpression" && parent.object === node)) {
    node = parent; parent = context.parents.get(node);
  }
  const name = origin(node, context).ambient;
  if (!name) {return true;}
  if (name === "Error" && context.errorClasses.has(parent) && parent.superClass === node) {return true;}
  if (parent?.type === "NewExpression") {return thrownTypeError(name, node, parent, context.parents) || localCollectionConstruction(name, node, parent, context);}
  if (parent?.type === "CallExpression" && parent.callee === node) {return supportedCall(name, parent, context);}
  if (intrinsicPrototypes.has(name)) {return prototypeObservation(equalityOperand(node, context), context);}
  if (scalarGlobals.has(name)) {return scalarRead(node, "scalar", context.parents);}
  if (!ambientAlias(node, parent, context)) {return false;}
  return aliasOrigins.some((origins) => origins.has(name));
}
function validateAmbientOrigins(program, failures, context) {
  walk(program, (node) => {
    if (!runtimeReference(node, context)) {return;}
    if (origin(node, context).ambient && !ambientUse(node, context)) {failures.add("ambient origin or unsupported reflective escape");}
  });
}

export function validatePrimitiveSyntax(path, program, problems) {
  const failures = new Set(), context = lexicalContext(program);
  context.errorClasses = new Set([...primitiveErrorClasses(program)].filter((node) => !context.lookup(node.superClass)));
  validateModuleData(program, failures, context);
  validateAmbientOrigins(program, failures, context);
  for (const statement of program.body) {
    const node = statement.declaration ?? statement;
    if (node.type === "VariableDeclaration" && node.kind !== "const") {failures.add("mutable module state");}
    if (node.type === "ExpressionStatement") {failures.add("module side effect");}
    if (node.type === "ClassDeclaration" && !context.errorClasses.has(node)) {failures.add("module class state");}
    if (!["VariableDeclaration", "FunctionDeclaration", "ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "EmptyStatement", "TSTypeAliasDeclaration", "TSInterfaceDeclaration"].includes(node.type) && !context.errorClasses.has(node)) {
      failures.add("unknown module initialization");
    }
  }
  for (const failure of failures) {problem(problems, "impure-primitive", `${path}: ${failure} is outside the pure primitive contract.`);}
}
