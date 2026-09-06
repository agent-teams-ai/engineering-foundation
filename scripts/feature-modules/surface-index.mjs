import { flatBindings } from "./factory-origins.mjs";

export function walk(node, visit, parent) {
  if (!node || typeof node !== "object") {return;}
  if (typeof node.type === "string") {visit(node, parent);}
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {for (const child of value) {walk(child, visit, node);}}
    else if (value && typeof value === "object") {walk(value, visit, node);}
  }
}
const nameOf = (node) => node?.name ?? node?.value;
const declarationNames = (node) => node?.type === "VariableDeclaration"
  ? node.declarations.flatMap(({ id }) => flatBindings(id).map(({ name }) => name)) : [nameOf(node?.id)].filter(Boolean);

// Keep erased declarations independently: neither source order may replace a
// runtime binding, and type ownership must still see the erased declaration.
export function indexProgram(program) {
  const imports = new Map(), exports = new Map(), locals = new Map(), references = new Map(), stars = [];
  const typeExports = new Map(), typeLocals = new Map();
  const addExport = (name, binding) => (binding.typeOnly ? typeExports : exports).set(name, binding);
  walk(program, (node, parent) => {
    if (node.source?.type === "Literal") {
      references.set(node.source.start, node.type === "TSImportType" && parent?.type === "TSTypeQuery"
        ? { ...node, selectedNamespace: "value" } : node);
    }
  });
  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration") {indexImports(statement, imports);}
    if (statement.type === "ExportAllDeclaration" && !statement.exported && statement.exportKind !== "type") {stars.push(statement.source);}
    const node = statement.declaration ?? statement;
    const erased = ["TSTypeAliasDeclaration", "TSInterfaceDeclaration"].includes(node.type);
    for (const name of declarationNames(node)) {(erased ? typeLocals : locals).set(name, node);}
    if (statement.type === "ExportNamedDeclaration") {
      for (const name of declarationNames(node)) {addExport(name, { local: name, typeOnly: erased || statement.exportKind === "type" });}
      for (const specifier of statement.specifiers) {
        addExport(nameOf(specifier.exported), { local: nameOf(specifier.local), source: statement.source, typeOnly: statement.exportKind === "type" || specifier.exportKind === "type" });
      }
    }
    if (statement.type === "ExportDefaultDeclaration") {
      addExport("default", ["FunctionDeclaration", "ClassDeclaration"].includes(node.type) && node.id ? { local: node.id.name } : { declaration: node });
    }
    if (statement.type === "ExportAllDeclaration" && statement.exported) {
      addExport(nameOf(statement.exported), { source: statement.source, local: "*", namespace: statement, typeOnly: statement.exportKind === "type" });
    }
  }
  // Runtime presence is independent of which symbol a type query selects.
  // Resolve local syntax after indexing both declaration orders. Imported and
  // re-exported aliases are closed over accepted targets by the effect pass.
  const surface = { program, imports, exports, locals, typeExports, typeLocals, references, stars };
  indexRuntimeBindings(surface);
  indexQueryUses(surface);
  return surface;
}

function indexRuntimeBindings({ exports, typeExports, locals, typeLocals, imports }) {
  for (const binding of [...exports.values(), ...typeExports.values()]) {
    binding.runtimeLocal = binding.local ?? (binding.declaration?.type === "Identifier" ? binding.declaration.name : undefined);
    binding.runtimeAvailable = runtimeBinding(binding, locals, typeLocals, imports);
  }
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
function valueDeclarations(body, names) {
  for (const statement of body) {
    const node = statement.declaration ?? statement;
    if (node.type === "VariableDeclaration") {for (const item of node.declarations) {patternNames(item.id, names);}}
    else if (["FunctionDeclaration", "ClassDeclaration", "TSDeclareFunction", "TSEnumDeclaration", "TSModuleDeclaration"].includes(node.type)) {patternNames(node.id, names);}
  }
}
function varDeclarations(node, names) {
  if (!node || typeof node !== "object" || functionScope(node) || ["TSModuleDeclaration", "TSModuleBlock", "StaticBlock"].includes(node.type)) {return;}
  if (node.type === "VariableDeclaration" && node.kind === "var") {valueDeclarations([node], names);}
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {varDeclarations(child, names);}
  }
}
function scopeNames(node) {
  const names = new Set();
  if (functionScope(node)) {
    for (const param of node.params) {patternNames(param, names);}
    if (node.type === "FunctionExpression") {patternNames(node.id, names);}
  }
  if (["Program", "BlockStatement", "TSModuleBlock", "StaticBlock"].includes(node.type)) {valueDeclarations(node.body, names); for (const item of node.body) {varDeclarations(item, names);}}
  if (node.type === "CatchClause") {patternNames(node.param, names);}
  if (["ClassDeclaration", "ClassExpression"].includes(node.type)) {patternNames(node.id, names);}
  if (["ForStatement", "ForInStatement", "ForOfStatement"].includes(node.type)) {valueDeclarations([node.init ?? node.left].filter(Boolean), names);}
  if (node.type === "SwitchStatement") {valueDeclarations(node.cases.flatMap((item) => item.consequent), names);}
  return names;
}
function rootSymbol(node) {
  if (node?.type === "Identifier") {return node.name;}
  if (node?.type === "TSQualifiedName") {return rootSymbol(node.left);}
  if (node?.type === "MemberExpression") {return rootSymbol(node.object);}
}
// Type-only import syntax erases transport, not the value symbol requested by
// typeof. Summarize uses for the import observation itself as well as aliases.
// This is lexical name transport; it neither evaluates types nor projects calls.
function indexQueryUses({ program, imports, references }) {
  const candidates = [];
  walk(program, (node) => {if (node.type === "TSTypeQuery" && imports.has(rootSymbol(node.exprName))) {candidates.push(node);}});
  if (!candidates.length) {return;}
  const parents = new Map(), scopes = new Map(), queries = new Set(), types = new Set();
  walk(program, (node, parent) => {
    parents.set(node, parent);
    const names = scopeNames(node);
    if (names.size) {scopes.set(node, names);}
  });
  walk(program, (node) => {
    if (node.type === "TSTypeReference") {types.add(rootSymbol(node.typeName));}
    if (["TSInterfaceHeritage", "TSClassImplements"].includes(node.type)) {types.add(rootSymbol(node.expression));}
    if (node.type === "ExportNamedDeclaration") {for (const item of node.specifiers) {types.add(nameOf(item.local));}}
    if (node.type !== "TSTypeQuery" || !imports.has(rootSymbol(node.exprName))) {return;}
    const name = rootSymbol(node.exprName);
    let scope = node, child;
    while (scope) {
      if (scopes.get(scope)?.has(name) && !(scope.type === "SwitchStatement" && scope.discriminant === child)) {return;}
      child = scope;
      scope = parents.get(scope);
    }
    queries.add(name);
  });
  for (const binding of imports.values()) {
    const node = binding.node;
    references.set(node.source.start, { ...node, queryNames: queries, typeNames: types });
  }
}

function runtimeBinding(binding, locals, typeLocals, imports) {
  if (binding.typeOnly) {return false;}
  if (binding.namespace) {return true;}
  if (binding.source) {return;}
  const local = binding.runtimeLocal;
  if (local !== undefined) {
    if (locals.has(local)) {return true;}
    if (imports.has(local)) {return imports.get(local).runtimeAvailable;}
    if (typeLocals.has(local)) {return false;}
    return;
  }
  return binding.declaration && !["TSInterfaceDeclaration", "TSTypeAliasDeclaration"].includes(binding.declaration.type);
}

function indexImports(statement, imports) {
  for (const specifier of statement.specifiers) {
    imports.set(specifier.local.name, { runtimeAvailable: statement.importKind === "type" || specifier.importKind === "type" ? false : specifier.type === "ImportNamespaceSpecifier" ? true : undefined, node: statement, name: nameOf(specifier.imported) ?? (specifier.type === "ImportDefaultSpecifier" ? "default" : "*") });
  }
}

export function selectedNames(node) {
  if (node?.type === "ImportDeclaration") {
    return node.specifiers.flatMap((specifier) => {
      const name = nameOf(specifier.imported) ?? (specifier.type === "ImportDefaultSpecifier" ? "default" : "*");
      const erased = node.importKind === "type" || specifier.importKind === "type";
      if (!erased || !node.queryNames?.has(specifier.local.name)) {return [[name, erased ? "type" : undefined]];}
      return node.typeNames.has(specifier.local.name) ? [[name, "type"], [name, "value"]] : [[name, "value"]];
    });
  }
  if (node?.type === "ExportNamedDeclaration") {return node.specifiers.map((specifier) => [nameOf(specifier.local), (node.exportKind === "type" || specifier.exportKind === "type") ? "type" : undefined]);}
  if (node?.type === "TSImportType" && node.qualifier?.type === "Identifier") {return [[node.qualifier.name, node.selectedNamespace ?? "type"]];}
  return [["*", undefined]];
}
