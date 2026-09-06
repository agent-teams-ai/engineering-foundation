// Syntax-only lexical facts. Value-symbol lookup and emitted runtime presence
// deliberately differ (ambient declarations and const enums still have symbols).
export function walk(node, visit, parent) {
  if (!node || typeof node !== "object") {return;}
  if (typeof node.type === "string") {visit(node, parent);}
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {walk(child, visit, node);}
  }
}
export function rootSymbol(node) {
  if (node?.type === "Identifier") {return node.name;}
  if (node?.type === "TSQualifiedName") {return rootSymbol(node.left);}
  if (node?.type === "MemberExpression") {return rootSymbol(node.object);}
}
export function declarationValue(node, runtime = false, namespaceMember = false) {
  if (!node || (runtime && node.declare && !namespaceMember)) {return false;}
  if (["TSInterfaceDeclaration", "TSTypeAliasDeclaration"].includes(node.type)) {return false;}
  if (node.type === "TSEnumDeclaration") {return !runtime || !node.const;}
  if (node.type === "TSDeclareFunction") {return !runtime || namespaceMember;}
  if (node.type === "TSModuleDeclaration") {
    return (node.body?.body ?? []).some((statement) => {
      // An unused private import alias does not instantiate a namespace.
      if (statement.type === "TSImportEqualsDeclaration") {return false;}
      const child = statement.declaration ?? statement;
      if (child.type === "TSImportEqualsDeclaration") {return child.importKind !== "type";}
      // A declared member can instantiate its non-ambient container even
      // though the member itself emits no statement.
      return declarationValue(child, runtime, true);
    });
  }
  if (node.type === "TSImportEqualsDeclaration") {return node.importKind !== "type" && !runtime;}
  if (node.type === "ExportNamedDeclaration") {return false;}
  return true;
}
const functionScope = (node) => ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "TSDeclareFunction", "TSFunctionType", "TSConstructorType", "TSMethodSignature", "TSCallSignatureDeclaration", "TSConstructSignatureDeclaration"].includes(node.type);
function patternNames(node, names) {
  if (!node) {return;}
  if (node.type === "Identifier") {names.add(node.name);}
  else if (node.type === "TSParameterProperty") {patternNames(node.parameter, names);}
  else if (node.type === "RestElement") {patternNames(node.argument, names);}
  else if (node.type === "AssignmentPattern") {patternNames(node.left, names);}
  else if (node.type === "ArrayPattern") {for (const item of node.elements) {patternNames(item, names);}}
  else if (node.type === "ObjectPattern") {for (const item of node.properties) {patternNames(item.value ?? item.argument, names);}}
}
function aliasValueFacts(node, scope) {
  if (declarationValue(node, true, true)) {
    if (node.type === "VariableDeclaration") {for (const item of node.declarations) {patternNames(item.id, scope.aliasValue);}}
    else {const name = rootSymbol(node.id); if (name) {scope.aliasValue.add(name);}}
  }
  if (node.type === "TSEnumDeclaration") {
    const name = rootSymbol(node.id);
    if (!scope.modules.has(name)) {scope.modules.set(name, emptyScope());}
    const members = scope.modules.get(name);
    for (const member of node.body.members) {
      const key = member.id.name ?? member.id.value;
      if (member.computed || typeof key !== "string") {continue;}
      members.value.add(key);
      members.aliasValue.add(key);
    }
  }
}
function declarations(body, scope) {
  for (const statement of body) {
    const node = statement.declaration ?? statement;
    if (node.type === "VariableDeclaration") {for (const item of node.declarations) {patternNames(item.id, scope.value);}}
    else if (["FunctionDeclaration", "ClassDeclaration", "TSDeclareFunction", "TSEnumDeclaration", "TSModuleDeclaration"].includes(node.type) && declarationValue(node)) {
      const name = rootSymbol(node.id); if (name) {scope.value.add(name);}
    }
    aliasValueFacts(node, scope);
    if (node.type === "TSImportEqualsDeclaration") {scope.aliases.set(node.id.name, node);}
    if (["TSModuleDeclaration", "TSEnumDeclaration"].includes(node.type)) {scope.namespace.add(rootSymbol(node.id));}
    if (["TSInterfaceDeclaration", "TSTypeAliasDeclaration", "ClassDeclaration", "TSEnumDeclaration"].includes(node.type)) {
      const name = rootSymbol(node.id); if (name) {scope.type.add(name);}
    }
  }
}
function varDeclarations(node, scope) {
  if (!node || typeof node !== "object" || functionScope(node) || ["TSModuleDeclaration", "TSModuleBlock", "StaticBlock"].includes(node.type)) {return;}
  if (node.type === "VariableDeclaration" && node.kind === "var") {declarations([node], scope);}
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {varDeclarations(child, scope);}
  }
}
const emptyScope = () => ({ aliasValue: new Set(), value: new Set(), type: new Set(), namespace: new Set(), modules: new Map(), aliases: new Map() });
function scopeNames(node) {
  const scope = emptyScope();
  if (functionScope(node)) {
    for (const param of node.params ?? []) {patternNames(param, scope.value);}
    if (node.type === "FunctionExpression") {patternNames(node.id, scope.value);}
  }
  for (const param of node.typeParameters?.params ?? []) {patternNames(param.name, scope.type);}
  if (node.type === "TSMappedType") {patternNames(node.key, scope.type);}
  if (["Program", "BlockStatement", "TSModuleBlock", "StaticBlock"].includes(node.type)) {declarations(node.body, scope); for (const item of node.body) {varDeclarations(item, scope);}}
  if (node.type === "CatchClause") {patternNames(node.param, scope.value);}
  if (["ClassDeclaration", "ClassExpression"].includes(node.type)) {patternNames(node.id, scope.value); patternNames(node.id, scope.type);}
  if (["ForStatement", "ForInStatement", "ForOfStatement"].includes(node.type)) {declarations([node.init ?? node.left].filter(Boolean), scope);}
  if (node.type === "SwitchStatement") {declarations(node.cases.flatMap((item) => item.consequent), scope);}
  return scope;
}
function moduleParts(node) {
  return node.type === "TSQualifiedName" ? [...moduleParts(node.left), node.right.name] : [node.name ?? node.value];
}
function ambientContext(node, parents) {
  while (node) {
    if (node.declare) {return true;}
    node = parents.get(node);
  }
  return false;
}
function implicitExports(body, parents) {
  return ambientContext(body, parents) && !body.body.some((statement) =>
    (statement.type === "ExportNamedDeclaration" && !statement.declaration) || statement.type === "TSExportAssignment");
}
function namespaceScopes(nodes, parents, scopes) {
  const groups = new Map();
  for (const node of nodes) {
    if (node.type !== "TSModuleDeclaration" || !node.body) {continue;}
    let container = parents.get(node);
    const exported = container?.type === "ExportNamedDeclaration" || (container?.type === "TSModuleBlock" && implicitExports(container, parents));
    while (container && !["Program", "BlockStatement", "TSModuleBlock"].includes(container.type)) {container = parents.get(container);}
    let scope = (exported && groups.get(container)) || scopes.get(container);
    if (!scope) {continue;}
    for (const name of moduleParts(node.id)) {
      if (!scope.modules.has(name)) {scope.modules.set(name, emptyScope());}
      scope = scope.modules.get(name);
    }
    groups.set(node.body, scope);
    declarations(node.body.body.filter((statement) => statement.type === "ExportNamedDeclaration" || implicitExports(node.body, parents)), scope);
  }
  shareExportLists(groups, scopes);
  return groups;
}
function shareSymbol(local, shared, from, to) {
  for (const kind of ["value", "type", "namespace", "aliasValue"]) {
    if (local[kind].has(from)) {shared[kind].add(to);}
  }
  for (const kind of ["modules", "aliases"]) {
    if (local[kind].has(from)) {shared[kind].set(to, local[kind].get(from));}
  }
}
function shareExportLists(groups, scopes) {
  // An ambient export list disables implicit exports, but its explicitly
  // selected local symbols remain shared. Keep original alias nodes so their
  // targets still use the declaration environment.
  for (const [body, shared] of groups) {
    const local = scopes.get(body);
    for (const statement of body.body) {
      if (statement.type !== "ExportNamedDeclaration" || statement.source) {continue;}
      for (const item of statement.specifiers) {
        const from = item.local.name ?? item.local.value, to = item.exported.name ?? item.exported.value;
        shareSymbol(local, shared, from, to);
      }
    }
  }
}
// Alias targets are looked up in their declaration's lexical environment, not
// the query's. Resolving a value-only alias cannot hide an outer type (or vice
// versa). Cycles and targets without local evidence never prove a shadow.
function aliasTarget(alias, context, active) {
  if (active.has(alias) || active.size >= 128 || !["Identifier", "TSQualifiedName"].includes(alias.moduleReference.type)) {return;}
  const next = new Set([...active, alias]);
  const parts = moduleParts(alias.moduleReference), name = parts.pop();
  if (!parts.length) {return lookupScopes(alias, context).map((scope) => ({ scope, name, active: next }));}
  let scope = findModule(parts.shift(), alias, context, next);
  for (const part of parts) {scope = scope && moduleInScope(scope, part, context, next);}
  return scope ? [{ scope, name, active: next }] : [];
}
function lookupScopes(node, context) {
  const result = [];
  let child;
  while (node) {
    const excluded = (node.type === "SwitchStatement" && node.discriminant === child) ||
      (node.type === "TSMappedType" && node.constraint === child);
    if (!excluded) {result.push(context.scopes.get(node), context.groups.get(node));}
    child = node;
    node = context.parents.get(node);
  }
  return result.filter(Boolean);
}
function moduleInScope(scope, name, context, active) {
  if (scope.modules.has(name)) {return scope.modules.get(name);}
  const alias = scope.aliases.get(name);
  for (const target of alias ? aliasTarget(alias, context, active) ?? [] : []) {
    const found = moduleInScope(target.scope, target.name, context, target.active);
    if (found) {return found;}
  }
}
function findModule(name, node, context, active) {
  for (const scope of lookupScopes(node, context)) {
    const found = moduleInScope(scope, name, context, active);
    if (found) {return found;}
  }
}
function scopeHas(scope, name, namespace, context, active) {
  if (scope[namespace].has(name)) {return true;}
  const alias = scope.aliases.get(name);
  if (!alias || (namespace === "aliasValue" && alias.importKind === "type")) {return false;}
  return (aliasTarget(alias, context, active) ?? []).some((target) => scopeHas(target.scope, target.name, namespace, context, target.active));
}
function shadowed(node, name, namespace, context) {
  return lookupScopes(node, context).some((scope) => scopeHas(scope, name, namespace, context, new Set()));
}
function inferNames(node, names) {
  if (!node || typeof node !== "object" || node.type === "TSConditionalType") {return;}
  if (node.type === "TSInferType") {patternNames(node.typeParameter.name, names);}
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {inferNames(child, names);}
  }
}
function lexicalContext(program) {
  const parents = new Map(), scopes = new Map(), nodes = [];
  walk(program, (node, parent) => {
    nodes.push(node); parents.set(node, parent);
    scopes.set(node, scopeNames(node));
  });
  return { nodes, parents, scopes, groups: namespaceScopes(nodes, parents, scopes) };
}
// Top-level local import-equals aliases emit only when their local target admits
// an emitted reference (even to an ambient host value). Whole const enums and
// erased namespaces do not; enum-member references do. This shares bounded
// lexical lookup, never source resolution.
export function indexRuntimeAliases({ program, runtimeLocals }) {
  const aliases = program.body.map((statement) => statement.declaration ?? statement)
    .filter((node) => node.type === "TSImportEqualsDeclaration");
  if (!aliases.length) {return;}
  const context = lexicalContext(program), scope = context.scopes.get(program);
  for (const alias of aliases) {
    if (scopeHas(scope, alias.id.name, "aliasValue", context, new Set())) {runtimeLocals.add(alias.id.name);}
  }
}
// Resolve both namespaces before summarizing import observations. Reopened
// bodies share exports only; private declarations keep their own lexical frame.
export function indexQueryUses({ program, imports, references }) {
  let candidate = false;
  walk(program, (node) => {if (node.type === "TSTypeQuery" && imports.has(rootSymbol(node.exprName))) {candidate = true;}});
  if (!candidate) {return;}
  const context = lexicalContext(program), { nodes, scopes } = context;
  const queries = new Set(), types = new Set();
  for (const node of nodes) {
    if (node.type === "TSConditionalType") {
      inferNames(node.extendsType, scopes.get(node.trueType).type);
    }
  }
  function use(node, name, namespace, names) {
    if (imports.has(name) && !shadowed(node, name, namespace, context)) {names.add(name);}
  }
  for (const node of nodes) {
    if (node.type === "TSTypeQuery") {use(node, rootSymbol(node.exprName), "value", queries);}
    if (node.type === "TSTypeReference") {use(node, rootSymbol(node.typeName), node.typeName.type === "TSQualifiedName" ? "namespace" : "type", types);}
    if (["TSInterfaceHeritage", "TSClassImplements"].includes(node.type)) {use(node, rootSymbol(node.expression), node.expression.type === "Identifier" ? "type" : "namespace", types);}
    if (node.type === "ExportNamedDeclaration" && !node.source) {
      for (const item of node.specifiers) {use(node, item.local.name ?? item.local.value, "type", types);}
    }
  }
  if (!queries.size) {return;}
  for (const binding of imports.values()) {
    const node = binding.node;
    references.set(node.source.start, { ...node, queryNames: queries, typeNames: types });
  }
}
