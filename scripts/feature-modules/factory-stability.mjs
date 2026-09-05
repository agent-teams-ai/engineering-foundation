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

function parameterScope(node, hidden) {
  const scope = new Set(hidden);
  for (const param of node.params) {bindingNames(param, scope);}
  if (node.type === "FunctionExpression") {bindingNames(node.id, scope);}
  return scope;
}
function nestedScope(node, hidden) {
  let scope = hidden;
  if (functionNode(node)) {
    scope = parameterScope(node, hidden);
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
    if (key === "id" && node.type !== "VariableDeclarator") {return false;}
    if (["params", "typeAnnotation", "returnType", "typeParameters", "typeArguments"].includes(key)) {return false;}
    return !(node.type === "Property" && key === "key" && !node.computed) && !(node.type === "MemberExpression" && key === "property" && !node.computed);
  }).flatMap(([, value]) => Array.isArray(value) ? value : [value]);
}

/** Track writes and escapes of enclosing bindings without confusing inner shadows. */
export function unstableFactoryBindings(body, bindings) {
  const names = new Set(bindings.keys());
  const unstable = new Map();
  const pending = [];
  function trackBinding(name, hidden, reason) {
    if (name && names.has(name) && !hidden.has(name) && !unstable.get(name)?.[reason]) {
      unstable.set(name, { ...unstable.get(name), [reason]: true });
      pending.push([name, reason]);
    }
  }
  function mark(node, hidden, reason = "contentsUnstable") {
    const name = rootName(node);
    trackBinding(name, hidden, reason);
    // A target or receiver can be a temporary returned by a call rather than a
    // named alias. Carry the mutation context through that value expression.
    if (!name && node && !node.type.endsWith("Pattern") && node.type !== "RestElement") {scan(node, hidden, reason);}
    if (node?.type === "ArrayPattern") {for (const child of node.elements) {mark(child, hidden, reason);}}
    if (node?.type === "ObjectPattern") {for (const child of node.properties) {mark(child.value ?? child.argument, hidden, reason);}}
    if (node?.type === "RestElement") {mark(node.argument, hidden, reason);}
    if (node?.type === "AssignmentPattern") {mark(node.left, hidden, reason);}
  }
  function write(node, hidden) {
    if (node?.type === "ArrayPattern") {for (const child of node.elements) {write(child, hidden);}}
    else if (node?.type === "ObjectPattern") {for (const child of node.properties) {write(child.value ?? child.argument, hidden);}}
    else if (node?.type === "RestElement") {write(node.argument, hidden);}
    else if (node?.type === "AssignmentPattern") {write(node.left, hidden);}
    else {mark(node, hidden, node?.type === "Identifier" ? "unstable" : "contentsUnstable");}
  }
  // Defaults execute outside body var/function declarations. Real parameters
  // and named expression self bindings shadow enclosing names.
  function scanFunction(node, hidden, escaped) {
    // Promise/iterator methods receive a wrapper, not the returned object. That
    // object's contents can escape through then/next callbacks or yielded values.
    if (escaped === "receiverUnstable" && (node.async || node.generator)) {escaped = "contentsUnstable";}
    const parameters = parameterScope(node, hidden);
    for (const param of node.params) {scan(param, parameters);}
    // A declaration in an untracked inner frame can pass its result to inner
    // aliases just like an initializer copied into an untracked binding.
    if (node.type === "FunctionDeclaration" && (hidden.has(node.id?.name) || !names.has(node.id?.name))) {escaped ??= "contentsUnstable";}
    // Escaping a function result exposes its returned values, not each local
    // read. A nested function gets its own return context.
    scan(node.body, nestedScope(node, hidden), node.body?.type === "BlockStatement" ? undefined : escaped, escaped);
  }
  function scanEffects(node, scope) {
    if (["ThrowStatement", "YieldExpression"].includes(node.type)) {scan(node.argument, scope, "contentsUnstable");}
    if (["AssignmentExpression", "AssignmentPattern"].includes(node.type)) {scan(node.right, scope, "contentsUnstable");}
    if (node.type === "VariableDeclarator" && [...bindingNames(node.id)].some((name) => scope.has(name) || !names.has(name))) {
      // A value copied into an untracked inner binding has escaped this finite
      // environment. Do not interpret subsequent inner alias mutations.
      scan(node.init, scope, "contentsUnstable");
    }
    if (node.type === "AssignmentExpression" ||
        (["ForInStatement", "ForOfStatement"].includes(node.type) && node.left.type !== "VariableDeclaration")) {write(node.left, scope);}
    // Iteration hands values to a loop binding outside the tracked frame,
    // including destructured bindings without a VariableDeclarator initializer.
    if (node.type === "ForOfStatement") {scan(node.right, scope, "contentsUnstable");}
    if (node.type === "UpdateExpression" || (node.type === "UnaryExpression" && node.operator === "delete")) {write(node.argument, scope);}
  }
  function scan(node, hidden, escaped, returned) {
    if (!node || typeof node !== "object") {return;}
    if (functionNode(node)) {scanFunction(node, hidden, escaped); return;}
    const scope = nestedScope(node, hidden);
    if (node.type === "SwitchStatement") {
      // Case declarations do not exist in the discriminant's environment.
      scan(node.discriminant, hidden, escaped, returned);
      for (const item of node.cases) {scan(item, scope, escaped, returned);}
      return;
    }
    if (node.type === "ReturnStatement") {
      scan(node.argument, scope, escaped ?? returned);
      return;
    }
    if (escaped && node.type === "Identifier") {mark(node, scope, escaped);}
    scanEffects(node, scope);
    if (["CallExpression", "NewExpression"].includes(node.type)) {
      if (node.callee.type === "MemberExpression") {mark(node.callee.object, scope, "receiverUnstable");}
      scan(node.callee, scope, escaped);
      for (const argument of node.arguments) {scan(argument, scope, "contentsUnstable");}
      return;
    }
    for (const child of children(node)) {scan(child, scope, escaped, returned);}
  }

  // The enclosing declarations are the tracked bindings, not shadows.
  for (const statement of body) {scan(statement, new Set());}
  // Follow alias initializers and escaped closures in their original lexical
  // frame. A supplied argument belongs to its caller, so do not reinterpret it
  // under coincidentally equal parameter names in this factory.
  for (const [name, reason] of pending) {
    const value = bindings.get(name);
    // Reassigning an alias does not replace the source binding; writes through
    // it and escapes do expose the source object's contents.
    if (reason !== "unstable" && value?.locals === bindings) {scan(value.node, new Set(), reason);}
  }
  return unstable;
}
