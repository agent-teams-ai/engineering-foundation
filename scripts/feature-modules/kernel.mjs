import { dirname } from "node:path/posix";
import { checkFeatureModule } from "../../packages/feature-module-standard/dist/index.js";
import { classify, problem, within } from "./profile.mjs";

// Feature Module Standard kernel adapter. The kernel owns feature-to-feature deep imports, layer direction and
// cycles inside one module; this file only translates the repository profile and the observed source graph into the
// kernel input and the kernel diagnostics back into repository problem codes. Feature identity, role mapping and
// entrypoints stay profile data: nothing here widens them.
const codes = new Map([["deep-import", "cross-feature-deep-import"], ["layer-direction", "layer-direction"], ["feature-cycle", "feature-cycle"]]);
const observedCycle = "Observed feature graph: ";

// A feature root is the deepest directory above every directory its layer roots sit in (a layer root is a directory
// named for its role or a single file).
export function featureRoot(feature) {
  const parents = feature.layers.flatMap((layer) => layer.roots.map((root) => dirname(root).split("/")));
  let common = parents[0] ?? [];
  for (const parts of parents) {
    let length = 0;
    while (length < common.length && length < parts.length && common[length] === parts[length]) {length += 1;}
    common = common.slice(0, length);
  }
  return common.join("/");
}
const arrowOf = (message) => message.slice(0, message.indexOf(":"));

function moduleInput(module, files, edges, policy, profile) {
  const roots = module.features.map((feature) => ({ feature, root: featureRoot(feature) }));
  const isFeature = (owner) => owner?.kind === "feature" && owner.module.id === module.id;
  const entrypoints = policy.boundaries.flatMap((boundary) => boundary.entrypoints ?? []);
  const imports = [];
  for (const { path, reference, result, from, to } of edges) {
    const kind = reference?.kind ?? "static";
    if (!isFeature(from) || !isFeature(to)) {continue;}
    imports.push({ from: path, to: result.path, line: 1, mode: /type/u.test(kind) ? "type-only" : "runtime", ...(kind.startsWith("export") ? { reexport: true } : {}) });
  }
  return {
    roots,
    input: {
      featureRoots: roots.map(({ root }) => root),
      roleRoots: module.features.flatMap((feature) => feature.layers.flatMap((layer) => layer.roots.map((root) => ({ root, role: layer.role })))),
      files: files.filter((file) => within(file, module.sourceRoot)),
      surfaces: { public: entrypoints.filter((path) => isFeature(classify(path, profile))) },
      imports
    }
  };
}

// The kernel names a feature by the last segment of its root, so two features of one module may not share it.
const basename = (root) => root.slice(root.lastIndexOf("/") + 1);

function translate(module, roots, report, problems) {
  const names = new Map(roots.map(({ feature, root }) => [report.features.find((node) => node.root === root)?.id, feature.id]));
  // Fail closed: an error the adapter does not translate is a mapping the repository profile cannot express.
  for (const { code, message, severity } of report.diagnostics) {
    if (severity === "error" && !codes.has(code)) {problem(problems, "feature-root", `${module.id}: kernel ${code}: ${message}`);}
  }
  return report.diagnostics.filter(({ code }) => codes.has(code)).map((diagnostic) => {
    if (diagnostic.code === "feature-cycle") {
      const path = diagnostic.message.slice(observedCycle.length).split(" -> ").map((name) => `${module.id}/${names.get(name) ?? name}`);
      return { code: "feature-cycle", message: `${observedCycle}${path.join(" -> ")}` };
    }
    return { code: codes.get(diagnostic.code), message: diagnostic.code === "deep-import" ? arrowOf(diagnostic.message) : diagnostic.message };
  });
}

// Runs the kernel once per module over the module's feature-owned local edges and reports its overlapping rules.
export function kernelProblems(profile, policy, files, observations, problems) {
  // Each observation is classified once, not once per module.
  const edges = observations.filter(({ result }) => result.kind === "local-file")
    .map((observation) => ({ ...observation, from: classify(observation.path, profile), to: classify(observation.result.path, profile) }));
  for (const module of profile.modules) {
    const { roots, input } = moduleInput(module, files, edges, policy, profile);
    const distinct = new Set(roots.map(({ root }) => root));
    if (distinct.size !== roots.length || new Set(roots.map(({ root }) => basename(root))).size !== roots.length || roots.some(({ root }) => roots.some((other) => other.root !== root && within(root, other.root)))) {
      problem(problems, "feature-root", `${module.id}: feature layer roots do not resolve to distinct, non-nested feature roots with distinct names.`);
      continue;
    }
    for (const found of translate(module, roots, checkFeatureModule(input), problems)) {problem(problems, found.code, found.message);}
  }
}
