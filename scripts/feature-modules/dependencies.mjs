import { classify, consumerIdentity, executableSources, problem, within } from "./profile.mjs";
import { indexSurfaces, surfaceBindings } from "./surfaces.mjs";
import { invalidAssemblyStatements } from "./assembly.mjs";
import { deterministicHashImport, validatePrimitiveSyntax } from "./purity.mjs";

const foundation = "../../packages/engineering-foundation/dist/";
const capability = `${foundation}capabilities/source-dependencies/`;

// Decorate the accepted resolver to retain the exact observations used by the
// existing capability. No second parser/resolver or package dependency catalog.
export async function observeDependencies(repositoryRoot, configPath) {
  const [config, analysis, inventory, source, parser, resolver, topology, exports, schema, configuration, fileSafety] = await Promise.all([
    import(`${capability}adapters/inbound/configuration/load-capability-config.js`),
    import(`${capability}application/use-cases/analyze-source-dependencies.js`),
    import(`${foundation}workspace-inventory/adapters/outbound/pnpm/pnpm-workspace-inventory-reader.js`),
    import(`${foundation}source-inventory/adapters/outbound/filesystem/filesystem-source-tree-reader.js`),
    import(`${capability}adapters/outbound/oxc/oxc-source-dependency-parser.js`),
    import(`${capability}adapters/outbound/node/node-source-dependency-resolver.js`),
    import(`${capability}adapters/outbound/node/pnpm-source-workspace-topology-inspector.js`),
    import(`${foundation}workspace-inventory/application/policies/package-export-matcher.js`),
    import(`${foundation}schema-catalog.js`),
    import(`${foundation}features/configuration-input/node.js`),
    import(`${foundation}source-inventory/node.js`)
  ]);
  const policy = await config.loadCapabilityConfig({ readYaml: configuration.loadStrictYamlFile, assertSchema: schema.assertSchema }, repositoryRoot, configPath);
  const observations = [];
  const sourceSnapshots = new Map();
  const packageExportTargets = new Map();
  const inventoryReader = new inventory.PnpmWorkspaceInventoryReader();
  const nodeResolver = new resolver.NodeSourceDependencyResolver();
  const topologyInspector = new topology.PnpmSourceWorkspaceTopologyInspector({
    inventoryReader, fileReader: { read: fileSafety.readContainedRegularFile },
    workspaceManifestLoader: configuration.loadStrictYamlFile
  });
  const diagnostics = await analysis.analyzeSourceDependencies({ consumerRoot: repositoryRoot, policy }, {
    inventoryReader,
    sourceReader: new source.FilesystemSourceTreeReader(),
    parser: new parser.OxcSourceDependencyParser(),
    topologyInspector: { async inspect(input) {
      const result = await topologyInspector.inspect(input);
      for (const file of result.sourceFiles) {sourceSnapshots.set(file.path, file.source);}
      for (const pkg of result.inventory.packages) {
        packageExportTargets.set(pkg.name, pkg.exportSurface.explicit
          ? pkg.exportSurface.entries.filter((entry) => !entry.subpath.includes("*") && entry.availability === "available")
            .map((entry) => exports.exactPackageExportTargetPaths(pkg.exportSurface.entries, entry.subpath))
          : []);
      }
      return result;
    } },
    resolver: { resolve(input) {
      const result = nodeResolver.resolve(input);
      observations.push({ path: input.file.path, reference: input.reference, result,
        ...(result.kind === "workspace-package" ? { exportTargets: exports.exactPackageExportTargetPaths(result.workspacePackage.exportSurface.entries, result.subpath) } : {}) });
      return result;
    } }
  });
  return { observations, diagnostics, sourceSnapshots, packageExportTargets };
}

function boundaryFor(path, policy) {
  const matches = policy.boundaries.filter(({ roots }) => roots.some((root) => within(path, root)));
  return matches.length === 1 ? matches[0] : undefined;
}
const sameFeature = (a, b) => a.module.id === b.module.id && a.feature?.id === b.feature?.id;
const layerTargets = {
  domain: ["domain"], application: ["domain", "application"],
  contracts: ["contracts"], adapters: ["adapters", "application", "domain", "contracts"],
  composition: ["domain", "application", "contracts", "adapters", "composition"],
  testing: ["domain", "application", "contracts", "adapters", "composition", "testing"]
};
function allowedDirection(from, to) {
  const role = from.layer.role;
  const target = to.layer?.role;
  if (to.kind === "primitive") {return target === "domain";}
  if (to.kind !== "feature") {return false;}
  // The sibling-feature restriction does not prohibit a module's integration
  // adapter from consuming another module's explicitly exported API.
  if (from.module.id !== to.module.id) {return layerTargets[role]?.includes(target) ?? false;}
  if (!sameFeature(from, to)) {
    if (role === "domain") {return target === "domain";}
    if (role === "application") {return ["domain", "application"].includes(target);}
    return ["composition", "testing"].includes(role);
  }
  return layerTargets[role]?.includes(target) ?? false;
}
export function cycles(edges) {
  const graph = new Map();
  for (const [from, to] of edges) {
    if (from === to) {continue;}
    if (!graph.has(from)) {graph.set(from, new Set());}
    graph.get(from).add(to);
  }
  const active = [], complete = new Set(), found = [];
  function visit(node) {
    if (active.includes(node)) { found.push([...active.slice(active.indexOf(node)), node]); return; }
    if (complete.has(node)) {return;}
    active.push(node);
    for (const target of [...(graph.get(node) ?? [])].toSorted()) {visit(target);}
    active.pop();
    complete.add(node);
  }
  for (const node of [...graph.keys()].toSorted()) {visit(node);}
  return found;
}
const key = (owner) => `${owner?.module.id}/${owner?.feature?.id}/${owner?.layer?.role}/${owner?.kind}`;
export function validateTopology(profile, policy, problems) {
  if (policy.schemaVersion !== 2) {problem(problems, "source-policy-version", "Feature topology requires explicit source-dependencies v2.");}
  const edges = [];
  for (const boundary of policy.boundaries) {
    const owners = boundary.roots.map((root) => classify(root, profile));
    const production = boundary.roots.some((root) => profile.modules.some((module) => within(root, module.sourceRoot)));
    if (!production) {continue;}
    if (owners.some((owner) => !owner) || new Set(owners.map(key)).size !== 1) {
      problem(problems, "boundary-ownership", `${boundary.id}: ${boundary.roots.join(", ")} spans or lacks one feature/layer owner.`);
    }
    for (const entry of boundary.entrypoints ?? []) {
      if (!boundary.roots.some((root) => within(entry, root))) {problem(problems, "deep-entrypoint", `${boundary.id}: ${entry} escapes its roots.`);}
    }
    const from = owners[0];
    for (const id of boundary.allow.boundaries) {
      const target = policy.boundaries.find((candidate) => candidate.id === id);
      if (!target) { problem(problems, "undeclared-edge", `${boundary.id} -> ${id}`); continue; }
      const to = classify(target.roots[0], profile);
      if (from?.kind === "feature" && to?.kind === "feature" && !sameFeature(from, to)) {
        edges.push([`${from.module.id}/${from.feature.id}`, `${to.module.id}/${to.feature.id}`]);
      }
    }
  }
  for (const cycle of cycles(edges)) {problem(problems, "feature-cycle", `Declared feature graph: ${cycle.join(" -> ")}`);}
}
function validateExternal(from, { path, result, reference }, problems, sources) {
      const pureHash = result.kind === "builtin" && result.specifier === "node:crypto" &&
        sources.has(path) && deterministicHashImport(sources.get(path).program, reference.start);
      if (["feature", "primitive"].includes(from.kind) && ["domain", "application", "contracts"].includes(from.layer.role) &&
          (result.kind === "external-package" || (result.kind === "builtin" && !pureHash && !["node:path", "node:url", "node:buffer", "node:assert", "node:util"].includes(result.specifier)))) {
        problem(problems, "inner-infrastructure", `${path} -> ${reference.specifier}: move observation/parser/SDK behind an owned port.`);
      }
}
function validateDirection(from, to, path, target, problems) {
  if (to.kind === "primitive" && !to.primitive.consumers?.some((caller) => caller?.path === path && caller.owner === consumerIdentity(from))) {
    problem(problems, "primitive-consumer", `${path} -> ${target}: consumer is not admitted by the exact primitive decision.`);
  }
  if (["feature", "primitive"].includes(from.kind) && !allowedDirection(from, to)) {
    problem(problems, "layer-direction", `${path} -> ${target}: ${from.layer.role} cannot import ${to.layer?.role ?? to.kind}.`);
  }
}
function workspaceOwners(from, observation, bindings, problems, edges) {
  const owners = bindings.owners(observation);
  if (owners.some((entry) => !entry?.owner)) {
    problem(problems, "surface-ownership", `${observation.path} -> ${observation.reference.specifier}: unknown or ambiguous exported binding ownership.`);
  }
  for (const entry of owners.filter((item) => item?.owner)) {
    validateDirection(from, entry.owner, observation.path, entry.path, problems);
    if (from.kind === "feature" && entry.owner.kind === "feature" && !sameFeature(from, entry.owner)) {
      edges.push([`${from.module.id}/${from.feature.id}`, `${entry.owner.module.id}/${entry.owner.feature.id}`]);
    }
  }
}
export function validateObservations(profile, policy, observations, problems, surfaces) {
  const { sources, bindings } = surfaces;
  const edges = [];
  for (const observation of observations) {
    const { path, result } = observation;
    const from = classify(path, profile);
    if (!from) {continue;}
    if (result.kind === "workspace-package") {
      workspaceOwners(from, observation, bindings, problems, edges);
      continue;
    }
    if (result.kind !== "local-file") {
      validateExternal(from, observation, problems, sources);
      continue;
    }
    const to = classify(result.path, profile);
    if (!to) { problem(problems, "unowned-edge", `${path} -> ${result.path}`); continue; }
    validateDirection(from, to, path, result.path, problems);
    const crossesFeature = !sameFeature(from, to) || from.kind !== to.kind;
    if (crossesFeature && to.kind === "feature") {
      const boundary = boundaryFor(result.path, policy);
      if (!boundary?.entrypoints?.includes(result.path)) {problem(problems, "cross-feature-deep-import", `${path} -> ${result.path}`);}
    }
    if (from.kind === "feature" && to.kind === "feature" && !sameFeature(from, to)) {edges.push([`${from.module.id}/${from.feature.id}`, `${to.module.id}/${to.feature.id}`]);}
  }
  for (const cycle of cycles(edges)) {problem(problems, "feature-cycle", `Observed feature graph: ${cycle.join(" -> ")}`);}
  validatePrimitiveConsumers(profile, observations, bindings, problems);
}
function validatePrimitiveConsumers(profile, observations, bindings, problems) {
  const consumers = new Map();
  for (const observation of observations) {
    const targets = observation.result.kind === "workspace-package" ? bindings.owners(observation)
      : observation.result.kind === "local-file" ? [{ path: observation.result.path, owner: classify(observation.result.path, profile) }] : [];
    for (const target of targets) {
      if (target?.owner?.kind !== "primitive") {continue;}
      if (!consumers.has(target.path)) {consumers.set(target.path, new Set());}
      consumers.get(target.path).add(observation.path);
    }
  }
  for (const record of profile.modules.flatMap((module) => module.exceptions)) {
    for (const consumer of record.consumers ?? []) {
      if (!consumers.get(record.path)?.has(consumer?.path)) {problem(problems, "primitive-consumer", `${record.path}: declared consumer ${consumer?.path} has no observed use.`);}
    }
  }
}
export async function validateSurfaces({ repositoryRoot, profile, policy, files, observations, sourceSnapshots, packageExportTargets }, problems) {
  for (const path of sourceSnapshots.keys()) {
    if (!files.includes(path) && profile.modules.some((module) => within(path, module.sourceRoot))) {
      problem(problems, "source-snapshot", `${path}: observed source is absent from the module inventory.`);
    }
  }
  const sources = indexSurfaces(files, problems, sourceSnapshots);
  const bindings = surfaceBindings(profile, policy, observations, sources, packageExportTargets);
  const executables = new Set();
  for (const module of profile.modules) {for (const path of await executableSources(repositoryRoot, module)) {executables.add(path);}}
  const entrypoints = new Set([...profile.modules.flatMap((module) => module.publicEntrypoints), ...policy.boundaries.flatMap((boundary) => boundary.entrypoints ?? [])]);
  for (const [file, surface] of sources) {
    const owner = classify(file, profile);
    const assembly = owner?.kind === "assembly";
    if (owner?.kind === "primitive") {validatePrimitiveSyntax(file, surface.program, problems);}
    for (const node of surface.program.body) {
      if (entrypoints.has(file) && node.type === "ExportAllDeclaration" && !bindings.curatedNamespace(file, node)) {
        problem(problems, "uncurated-entrypoint", `${file}: export-star is not a curated surface.`);
      }
    }
    if (!assembly) {continue;}
    for (const node of invalidAssemblyStatements(file, surface, bindings, executables.has(file))) {
      problem(problems, "assembly-behavior", `${file}:${node.start}: ${node.type} is outside bounded imported-factory wiring, inert derived types and designated CLI lifecycle.`);
    }
  }
  return { sources, bindings };
}
