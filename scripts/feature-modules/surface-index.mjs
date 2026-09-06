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
  walk(program, (node) => {if (node.source?.type === "Literal") {references.set(node.source.start, node);}});
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
  return { program, imports, exports, locals, typeExports, typeLocals, references, stars };
}

function indexImports(statement, imports) {
  for (const specifier of statement.specifiers) {
    imports.set(specifier.local.name, { node: statement, name: nameOf(specifier.imported) ?? (specifier.type === "ImportDefaultSpecifier" ? "default" : "*") });
  }
}

export function selectedNames(node) {
  if (node?.type === "ImportDeclaration") {
    return node.specifiers.map((specifier) => [nameOf(specifier.imported) ?? (specifier.type === "ImportDefaultSpecifier" ? "default" : "*"), node.importKind === "type" || specifier.importKind === "type"]);
  }
  if (node?.type === "ExportNamedDeclaration") {return node.specifiers.map((specifier) => [nameOf(specifier.local), node.exportKind === "type" || specifier.exportKind === "type"]);}
  if (node?.type === "TSImportType" && node.qualifier?.type === "Identifier") {return [[node.qualifier.name, true]];}
  return [["*", false]];
}
