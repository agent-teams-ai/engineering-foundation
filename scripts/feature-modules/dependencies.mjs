import { findCycles, layerDirectionAllowed } from "../../packages/feature-module-standard/dist/index.js";
import { classify, consumerIdentity, executableSources, problem, within } from "./profile.mjs";
import { indexSurfaces, surfaceBindings } from "./surfaces.mjs";
import { invalidAssemblyStatements } from "./assembly.mjs";
import { deterministicHashImport, validatePrimitiveSyntax } from "./purity.mjs";
import { kernelProblems } from "./kernel.mjs";

const foundation = "../../packages/engineering-foundation/dist/";
const capability = `${foundation}capabilities/source-dependencies/`;

// Decorate the accepted resolver to retain the exact observations used by the
// existing capability. No second parser/resolver or package dependency catalog.
export async function observeDependencies(repositoryRoot, configPath) {
  const [config, analysis, inventory, source, parser, resolver, topology, exports, schema, configuration, fileSafety] = await Promise.all([
    import(`${capability}adapters/inbound/configuration/load-capability-config.js`),
    import(`${capability}application/use-cases/analyze-source-dependencies.js`),
    import(`${foundation}workspace-inventory/module.js`),
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
  const inventoryReader = inventory.createWorkspaceInventoryReader();
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
// Layer direction and cycle search are Feature Module Standard kernel semantics. EF keeps two local strengthenings
// on top of the standard: contracts never import another feature, and another module's exported API is judged
// with the inside-one-feature table.
function allowedDirection(from, to) {
  const role = from.layer.role;
  const target = to.layer?.role;
  if (to.kind === "primitive") {return target === "domain";}
  if (to.kind !== "feature") {return false;}
  if (from.module.id !== to.module.id) {return layerDirectionAllowed(role, target, "same-feature");}
  if (!sameFeature(from, to)) {return role !== "contracts" && layerDirectionAllowed(role, target, "other-feature");}
  return layerDirectionAllowed(role, target, "same-feature");
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
  for (const cycle of findCycles(edges)) {problem(problems, "feature-cycle", `Declared feature graph: ${cycle.join(" -> ")}`);}
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
function workspaceOwners(from, observation, bindings, problems) {
  const owners = bindings.owners(observation);
  if (owners.some((entry) => !entry?.owner)) {
    problem(problems, "surface-ownership", `${observation.path} -> ${observation.reference.specifier}: unknown or ambiguous exported binding ownership.`);
  }
  for (const entry of owners.filter((item) => item?.owner)) {
    validateDirection(from, entry.owner, observation.path, entry.path, problems);
  }
}
export function validateObservations(profile, policy, observations, problems, surfaces) {
  const { sources, bindings } = surfaces;
  for (const observation of observations) {
    const { path, result } = observation;
    const from = classify(path, profile);
    if (!from) {continue;}
    if (result.kind === "workspace-package") {
      workspaceOwners(from, observation, bindings, problems);
      continue;
    }
    if (result.kind !== "local-file") {
      validateExternal(from, observation, problems, sources);
      continue;
    }
    const to = classify(result.path, profile);
    if (!to) { problem(problems, "unowned-edge", `${path} -> ${result.path}`); continue; }
    if (from.kind === "feature" && to.kind === "feature" && from.module.id === to.module.id) {
      // The kernel judges this edge; a contracts layer never reaching another feature is the one local strengthening.
      if (from.layer.role === "contracts" && !sameFeature(from, to)) {
        problem(problems, "layer-direction", `${path} -> ${result.path}: contracts cannot import another feature.`);
      }
      continue;
    }
    validateDirection(from, to, path, result.path, problems);
    if (to.kind === "feature" && (!sameFeature(from, to) || from.kind !== to.kind)) {
      const boundary = boundaryFor(result.path, policy);
      if (!boundary?.entrypoints?.includes(result.path)) {problem(problems, "cross-feature-deep-import", `${path} -> ${result.path}`);}
    }
  }
  kernelProblems(profile, policy, [...sources.keys()], observations, problems);
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
