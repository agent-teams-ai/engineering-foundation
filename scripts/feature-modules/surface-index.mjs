import { flatBindings } from "./factory-origins.mjs";

import { walk, rootSymbol, declarationValue, indexQueryUses } from "./surface-lexical.mjs";
export { walk } from "./surface-lexical.mjs";

const nameOf = (node) => node?.name ?? node?.value;
const declarationNames = (node) => node?.type === "VariableDeclaration"
  ? node.declarations.flatMap(({ id }) => flatBindings(id).map(({ name }) => name)) : [rootSymbol(node?.id) ?? nameOf(node?.id)].filter(Boolean);

// Keep erased declarations independently: neither source order may replace a
// runtime binding, and type ownership must still see the erased declaration.
export function indexProgram(program) {
  const imports = new Map(), exports = new Map(), locals = new Map(), references = new Map(), stars = [];
  const typeExports = new Map(), typeLocals = new Map(), runtimeLocals = new Set();
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
    for (const name of declarationNames(node)) {
      (erased ? typeLocals : locals).set(name, node);
      if (declarationValue(node, true)) {runtimeLocals.add(name);}
    }
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
  const surface = { program, imports, exports, locals, typeExports, typeLocals, references, stars, runtimeLocals };
  indexRuntimeBindings(surface);
  indexQueryUses(surface);
  return surface;
}

function indexRuntimeBindings({ exports, typeExports, locals, typeLocals, imports, runtimeLocals }) {
  for (const binding of [...exports.values(), ...typeExports.values()]) {
    binding.runtimeLocal = binding.local ?? (binding.declaration?.type === "Identifier" ? binding.declaration.name : undefined);
    binding.runtimeAvailable = runtimeBinding(binding, locals, typeLocals, imports, runtimeLocals);
  }
}

function runtimeBinding(binding, locals, typeLocals, imports, runtimeLocals) {
  if (binding.typeOnly) {return false;}
  if (binding.namespace) {return true;}
  if (binding.source) {return;}
  const local = binding.runtimeLocal;
  if (local !== undefined) {
    if (locals.has(local)) {return runtimeLocals.has(local);}
    if (imports.has(local)) {return imports.get(local).runtimeAvailable;}
    if (typeLocals.has(local)) {return false;}
    return;
  }
  return binding.declaration && declarationValue(binding.declaration, true);
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
