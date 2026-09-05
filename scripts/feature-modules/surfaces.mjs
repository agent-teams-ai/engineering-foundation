import { parseSync } from "oxc-parser";
import { classify, problem, sourceTarget, within } from "./profile.mjs";

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
  ? node.declarations.map(({ id }) => nameOf(id)).filter(Boolean) : [nameOf(node?.id)].filter(Boolean);
function typeOrigin(node) {
  if (node?.type === "TSArrayType") {return typeOrigin(node.elementType);}
  if (node?.type === "TSTypeOperator") {return typeOrigin(node.typeAnnotation);}
  return node?.typeName ?? node?.exprName;
}

function indexProgram(program) {
  const imports = new Map(), exports = new Map(), locals = new Map(), references = new Map();
  walk(program, (node) => {if (node.source?.type === "Literal") {references.set(node.source.start, node);}});
  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration") {
      for (const specifier of statement.specifiers) {
        imports.set(specifier.local.name, { node: statement, name: nameOf(specifier.imported) ?? (specifier.type === "ImportDefaultSpecifier" ? "default" : "*") });
      }
    }
    const node = statement.declaration ?? statement;
    for (const name of declarationNames(node)) {locals.set(name, node);}
    if (statement.type === "ExportNamedDeclaration") {
      for (const name of declarationNames(node)) {exports.set(name, { local: name });}
      for (const specifier of statement.specifiers) {
        exports.set(nameOf(specifier.exported), { local: nameOf(specifier.local), source: statement.source });
      }
    }
    if (statement.type === "ExportDefaultDeclaration") {exports.set("default", { declaration: node });}
    if (statement.type === "ExportAllDeclaration" && statement.exported) {
      exports.set(nameOf(statement.exported), { source: statement.source, local: "*", namespace: statement });
    }
  }
  return { program, imports, exports, locals, references };
}

export function indexSurfaces(files, problems, snapshots) {
  const sources = new Map();
  for (const path of files) {
    const snapshot = snapshots.get(path);
    if (snapshot === undefined) {
      problem(problems, "source-snapshot", `${path}: source is missing from the accepted observation.`);
      continue;
    }
    const parsed = parseSync(path, snapshot);
    if (parsed.errors.length) {problem(problems, "surface-parse", path);}
    else {sources.set(path, indexProgram(parsed.program));}
  }
  return sources;
}

// Follow only curated names/aliases over observations from the accepted
// resolver. We never resolve a new specifier or infer ownership from dist bytes.
export function surfaceBindings(profile, policy, observations, sources, packageExportTargets = new Map()) {
  const byReference = new Map(observations.map((entry) => [`${entry.path}:${entry.reference.start}`, entry]));
  const namespaceCache = new Map();
  function publishedTarget(module, target) {
    return (packageExportTargets.get(module.packageName) ?? []).some((manifestTargets) => {
      const paths = manifestTargets.map((value) => sourceTarget(module, value));
      return paths.includes(target) && paths.every((path) => path && sources.has(path) && module.publicEntrypoints.includes(path));
    });
  }
  function curatedNamespace(path, node, active = new Set()) {
    if (node.type !== "ExportAllDeclaration" || node.exported?.type !== "Identifier") {return false;}
    const key = `${path}:${node.start}`;
    if (active.has(key) || active.size >= 128) {return false;}
    if (namespaceCache.has(key)) {return namespaceCache.get(key);}
    const owner = classify(path, profile);
    const observation = byReference.get(`${path}:${node.source.start}`);
    const target = observation?.result.kind === "local-file" ? observation.result.path : undefined;
    const surface = sources.get(target);
    const next = new Set([...active, key]);
    // A namespace preserves a separately published, explicitly curated API.
    // Exact manifest targets come from the accepted topology and export matcher.
    const valid = owner?.kind === "assembly" && owner.module.publicEntrypoints.includes(path) &&
      target !== path && surface?.exports.size > 0 && publishedTarget(owner.module, target) &&
      surface.program.body.every((statement) => statement.type !== "ExportAllDeclaration" || curatedNamespace(target, statement, next));
    namespaceCache.set(key, Boolean(valid));
    return Boolean(valid);
  }
  function targets(observation) {
    if (observation.result.kind === "local-file") {return [observation.result.path];}
    if (observation.result.kind !== "workspace-package" || !observation.result.exported) {return [];}
    const { workspacePackage, subpath } = observation.result;
    const module = profile.modules.find(({ packageName }) => packageName === workspacePackage.name);
    if (!module) {return [];}
    const paths = [...new Set((observation.exportTargets ?? []).map((target) => sourceTarget(module, target)))];
    const claims = policy.boundaries.filter((boundary) => boundary.roots.some((root) => within(root, module.sourceRoot)) && boundary.packageExports?.includes(subpath));
    if (claims.length > 1 || !paths.length || paths.some((path) => !path || !sources.has(path) || !module.publicEntrypoints.includes(path))) {return [];}
    if (claims.length === 1 && paths.some((path) => !claims[0].roots.some((root) => within(path, root)))) {return [];}
    return paths;
  }
  function imported(path, source, name, active) {
    const observation = byReference.get(`${path}:${source.start}`);
    const paths = observation && targets(observation);
    return paths?.length ? paths.flatMap((target) => exported(target, name, active)) : [undefined];
  }
  function local(path, name, active) {
    const surface = sources.get(path);
    const binding = surface?.imports.get(name);
    if (binding) {return imported(path, binding.node.source, binding.name, active);}
    const declaration = surface?.locals.get(name);
    if (!declaration) {return [undefined];}
    const alias = declaration.type === "VariableDeclaration"
      ? declaration.declarations.find(({ id }) => nameOf(id) === name)?.init : typeOrigin(declaration.typeAnnotation);
    if (alias?.type === "Identifier" && alias.name !== name &&
        (surface.imports.has(alias.name) || surface.locals.has(alias.name))) {return localAlias(path, alias.name, active);}
    return [{ path, owner: classify(path, profile) }];
  }
  function localAlias(path, name, active) {
    const key = `${path}:local:${name}`;
    if (active.has(key) || active.size > 128) {return [undefined];}
    return local(path, name, new Set([...active, key]));
  }
  function exported(path, name, active = new Set()) {
    const key = `${path}:export:${name}`, surface = sources.get(path);
    if (!surface || active.has(key) || active.size > 128) {return [undefined];}
    const next = new Set([...active, key]);
    if (name === "*") {
      return surface.exports.size ? [...surface.exports.keys()].flatMap((item) => exported(path, item, next)) : [undefined];
    }
    const binding = surface.exports.get(name);
    if (!binding) {return [undefined];}
    if (binding.namespace && !curatedNamespace(path, binding.namespace)) {return [undefined];}
    if (binding.source) {return imported(path, binding.source, binding.local, next);}
    if (binding.declaration?.type === "Identifier") {return localAlias(path, binding.declaration.name, next);}
    if (binding.declaration) {return [{ path, owner: classify(path, profile) }];}
    return localAlias(path, binding.local, next);
  }
  function selected(observation) {
    const node = sources.get(observation.path)?.references.get(observation.reference.start);
    if (node?.type === "ImportDeclaration") {
      return node.specifiers.map((specifier) => nameOf(specifier.imported) ?? (specifier.type === "ImportDefaultSpecifier" ? "default" : "*"));
    }
    if (node?.type === "ExportNamedDeclaration") {return node.specifiers.map(({ local: id }) => nameOf(id));}
    if (node?.type === "TSImportType" && node.qualifier?.type === "Identifier") {return [node.qualifier.name];}
    return ["*"];
  }
  return {
    targets,
    curatedNamespace,
    owners(observation) {
      const paths = targets(observation), names = selected(observation);
      return paths.length && names.length ? paths.flatMap((path) => names.flatMap((name) => exported(path, name))) : [undefined];
    },
    observation(path, start) {return byReference.get(`${path}:${start}`);}
  };
}
