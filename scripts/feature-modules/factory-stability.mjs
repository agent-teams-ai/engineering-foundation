const functionNode = (node) => ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type);
function bindingNames(node, names = new Set()) {
  if (!node) {return names;}
  if (node.type === "Identifier") {names.add(node.name);}
  else if (node.type === "RestElement") {bindingNames(node.argument, names);}
  else if (node.type === "AssignmentPattern") {bindingNames(node.left, names);}
  else if (node.type === "ArrayPattern") {for (const value of node.elements) {bindingNames(value, names);}}
  else if (node.type === "ObjectPattern") {for (const property of node.properties) {bindingNames(property.value ?? property.argument, names);}}
  return names;
}
function nestedVarNames(node, names) {
  if (!node || typeof node !== "object" || functionNode(node)) {return;}
  if (node.type === "VariableDeclaration" && node.kind === "var") {
    for (const item of node.declarations) {bindingNames(item.id, names);}
  }
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {nestedVarNames(child, names);}
  }
}
function declarations(body, includeNestedVar = false, names = new Set()) {
  for (const node of body) {
    if (node.type === "VariableDeclaration") {
      for (const item of node.declarations) {bindingNames(item.id, names);}
    } else if (["FunctionDeclaration", "ClassDeclaration"].includes(node.type)) {bindingNames(node.id, names);}
    if (includeNestedVar) {nestedVarNames(node, names);}
  }
  return names;
}
function rootName(node) {
  if (node?.type === "Identifier") {return node.name;}
  if (node?.type === "MemberExpression") {return rootName(node.object);}
  return ["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression"].includes(node?.type) ? rootName(node.expression) : undefined;
}

function nestedScope(node, hidden) {
  let scope = hidden;
  if (functionNode(node)) {
    scope = new Set(hidden);
    for (const param of node.params) {bindingNames(param, scope);}
    if (node.type === "FunctionExpression") {bindingNames(node.id, scope);}
    declarations(node.body?.body ?? [], true, scope);
  } else if (node.type === "BlockStatement") {scope = declarations(node.body, false, new Set(hidden));}
  else if (node.type === "CatchClause") {scope = bindingNames(node.param, new Set(hidden));}
  else if (["ForStatement", "ForInStatement", "ForOfStatement"].includes(node.type)) {
    const declaration = node.init ?? node.left;
    if (declaration?.type === "VariableDeclaration" && declaration.kind !== "var") {scope = declarations([declaration], false, new Set(hidden));}
  } else if (node.type === "SwitchStatement") {scope = declarations(node.cases.flatMap((item) => item.consequent), false, new Set(hidden));}
  return scope;
}
function children(node) {
  return Object.entries(node).filter(([key]) => {
    if (["id", "params", "typeAnnotation", "returnType", "typeParameters", "typeArguments"].includes(key)) {return false;}
    return !(node.type === "Property" && key === "key" && !node.computed) && !(node.type === "MemberExpression" && key === "property" && !node.computed);
  }).flatMap(([, value]) => Array.isArray(value) ? value : [value]);
}

/** Track writes and escapes of enclosing bindings without confusing inner shadows. */
export function unstableFactoryBindings(body, bindings) {
  const names = new Set(bindings.keys());
  const unstable = new Set();
  function mark(node, hidden) {
    const name = rootName(node);
    if (name && names.has(name) && !hidden.has(name)) {unstable.add(name);}
    if (node?.type === "ArrayPattern") {for (const child of node.elements) {mark(child, hidden);}}
    if (node?.type === "ObjectPattern") {for (const child of node.properties) {mark(child.value ?? child.argument, hidden);}}
    if (node?.type === "RestElement") {mark(node.argument, hidden);}
    if (node?.type === "AssignmentPattern") {mark(node.left, hidden);}
  }
  function scan(node, hidden, escaped = false) {
    if (!node || typeof node !== "object") {return;}
    const scope = nestedScope(node, hidden);
    if (escaped && node.type === "Identifier") {mark(node, scope);}
    if (node.type === "AssignmentExpression") {mark(node.left, scope);}
    if (node.type === "UpdateExpression" || (node.type === "UnaryExpression" && node.operator === "delete")) {mark(node.argument, scope);}
    if (["CallExpression", "NewExpression"].includes(node.type)) {
      if (node.callee.type === "MemberExpression") {mark(node.callee.object, scope);}
      scan(node.callee, scope, escaped);
      for (const argument of node.arguments) {scan(argument, scope, true);}
      return;
    }
    for (const child of children(node)) {scan(child, scope, escaped);}
  }

  // The enclosing declarations are the tracked bindings, not shadows.
  for (const statement of body) {scan(statement, new Set());}
  // Follow alias initializers and escaped closures in their original lexical
  // frame. A supplied argument belongs to its caller, so do not reinterpret it
  // under coincidentally equal parameter names in this factory.
  for (const name of unstable) {
    const value = bindings.get(name);
    if (value?.locals === bindings) {scan(value.node, new Set(), true);}
  }
  return unstable;
}
