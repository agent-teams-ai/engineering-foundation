import type { QualityTopology, QualitySourceAuthority } from "./profile.js";
import type { QualitySource } from "./model.js";

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

export function classifyQualityCensus(input: {
  readonly sourcePaths: readonly string[];
  readonly filePaths: readonly string[];
  readonly manifestPaths: readonly string[];
  readonly compilerProjects?: readonly string[];
  readonly topology: QualityTopology;
  readonly authority: QualitySourceAuthority;
  readonly suppressionRoots: readonly string[];
}): { readonly sources: readonly QualitySource[]; readonly compilerConfigPaths: readonly string[]; readonly testPaths: readonly string[]; readonly unclassifiedPackages: readonly string[] } {
  const productionRoots = input.topology.productionSourceRoots ?? [...input.topology.modules.map(({ sourceRoot }) => sourceRoot), ...input.topology.applicationRoots];
  const censusRoots = [...input.topology.productionRoots, ...input.topology.applicationRoots];
  const testRoots = input.topology.modules.flatMap((module) => module.testRoots);
  const nonProductionRoots = [...testRoots, ...input.topology.excludedRoots];
  const unclassifiedPackages = input.manifestPaths.filter((path) =>
    path !== "package.json" &&
    censusRoots.some((root) => inside(path, root)) &&
    !input.topology.excludedRoots.some((root) => inside(path, root)) &&
    !input.topology.modules.some(({ root }) => path === `${root}/package.json`) &&
    !testRoots.some((root) => inside(path, root))
  );
  const compilerConfigs = new Set((input.compilerProjects ?? []).filter((path) => path.endsWith(".json")));
  const candidates = [...new Set([...input.sourcePaths, ...input.filePaths.filter((path) =>
    /\.(?:c|h)$/u.test(path) || (!path.endsWith("/package.json") && !path.endsWith(".md") && !compilerConfigs.has(path) && productionRoots.some((root) => inside(path, root)))
  )])].toSorted();
  const isDevelopmentTooling = (path: string): boolean => {
    if (qualitySourceLanguage(path) === "native") { return false; }
    const owners = input.authority.boundaries.filter(({ roots }) => roots.some((root) => inside(path, root)));
    return owners.length === 1 && owners[0]?.dependencyMode === "development";
  };
  const isRuntimeOwned = (path: string): boolean => input.authority.boundaries.some(({ roots, dependencyMode }) =>
    dependencyMode === "runtime" && roots.some((root) => inside(path, root)));
  const sources = candidates.filter((path) =>
    !nonProductionRoots.some((root) => inside(path, root)) &&
    (productionRoots.some((root) => inside(path, root)) ||
      (input.topology.toolingFiles?.includes(path) !== true &&
        ((censusRoots.some((root) => inside(path, root)) && !isDevelopmentTooling(path)) || isRuntimeOwned(path))))
  ).map((path) => ({
    path,
    owners: (productionRoots.some((root) => inside(path, root)) || /\.(?:c|h)$/u.test(path) || isRuntimeOwned(path))
      ? input.authority.boundaries.filter(({ roots }) => roots.some((root) => inside(path, root))).map(({ id }) => id)
      : [],
    suppressionCovered: input.suppressionRoots.some((root) => inside(path, root))
  }));
  const testPaths = input.filePaths.filter((path) => testRoots.some((root) => inside(path, root)) &&
    !input.topology.excludedRoots.some((root) => inside(path, root)));
  const compilerConfigPaths = input.filePaths.filter((path) => compilerConfigs.has(path) && !input.sourcePaths.includes(path));
  return { sources, compilerConfigPaths, testPaths, unclassifiedPackages };
}

/** Technical tool applicability is independent of consumer semantic ownership. */
export function qualitySourceLanguage(path: string): "typescript" | "javascript" | "native" | "unsupported" {
  if (path.endsWith(".ts") || path.endsWith(".d.mts")) { return "typescript"; }
  if (path.endsWith(".mjs")) { return "javascript"; }
  if (/\.(?:c|h)$/u.test(path)) { return "native"; }
  return "unsupported";
}

/** Select lint-applicable sources from the authoritative production census. */
export function qualitySourceTargets(paths: readonly string[], topology: QualityTopology, authority: QualitySourceAuthority): readonly string[] {
  return [...new Set(paths)].toSorted().filter((path) => {
    if (qualitySourceLanguage(path) !== "typescript" && qualitySourceLanguage(path) !== "javascript") { return false; }
    if (topology.excludedRoots.some((root) => inside(path, root))) { return false; }
    const production = (topology.productionSourceRoots ?? [...topology.modules.map(({ sourceRoot }) => sourceRoot), ...topology.applicationRoots])
      .some((root) => inside(path, root));
    if (!production && topology.toolingFiles?.includes(path) === true) { return false; }
    const runtimeOwned = authority.boundaries.some(({ roots, dependencyMode }) => dependencyMode === "runtime" && roots.some((root) => inside(path, root)));
    return production || runtimeOwned;
  });
}
