import { sourceDependencyAdapters, sourceTopologyAdapters, schemaConfigurationDependencies } from "../support/capability-adapters.mjs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const foundationPackageRoot = join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
);
const distRoot = process.env.FOUNDATION_DIST_ROOT ?? join(
  foundationPackageRoot,
  "dist",
);
const fixtureRoot = join(repositoryRoot, "tests", "fixtures", "source-dependencies");
const [
  { loadCapabilityConfig: loadSourceDependencyCapabilityConfig },
  { createSourceDependenciesCapability },
  { PnpmSourceWorkspaceTopologyInspector },
  { PnpmWorkspaceInventoryReader },
  { revalidateStableRepositoryPath },
] = await Promise.all([
  import(
    pathToFileURL(
      join(distRoot, "capabilities/source-dependencies/adapters/inbound/configuration/load-capability-config.js"),
    ).href
  ),
  import(
    pathToFileURL(join(distRoot, "capabilities/source-dependencies/module.js")).href
  ),
  import(
    pathToFileURL(
      join(
        distRoot,
        "capabilities/source-dependencies/adapters/outbound/node/pnpm-source-workspace-topology-inspector.js",
      ),
    ).href
  ),
  import(
    pathToFileURL(
      join(
        distRoot,
        "workspace-inventory/adapters/outbound/pnpm/pnpm-workspace-inventory-reader.js",
      ),
    ).href
  ),
  import(
    pathToFileURL(
      join(
        distRoot,
        "capabilities/source-dependencies/adapters/outbound/node/source-workspace-filesystem.js",
      ),
    ).href
  ),
]);

export const loadCapabilityConfig = (root, path, signal, observeSchemaVersion) => loadSourceDependencyCapabilityConfig(
  schemaConfigurationDependencies(), root, path, signal, observeSchemaVersion
);
export { PnpmWorkspaceInventoryReader };
export { revalidateStableRepositoryPath };

export function ruleIds(values) {
  return values.map(({ ruleId }) => ruleId).toSorted();
}

export async function withTemporaryDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "foundation-source-v2-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

export async function withCopiedFixture(name, callback) {
  return withTemporaryDirectory(async (consumerRoot) => {
    await cp(join(fixtureRoot, name), consumerRoot, { recursive: true });
    return callback(consumerRoot);
  });
}

export async function runSourceCapability(consumerRoot, signal) {
  return createSourceDependenciesCapability(sourceDependencyAdapters()).run({
    consumerRoot,
    configPath: "architecture/foundation/source-dependencies.yaml",
    ...(signal === undefined ? {} : { signal }),
  });
}

export async function inspectV2Topology(consumerRoot, dependencies = {}, signal) {
  const policy = await loadCapabilityConfig(
    consumerRoot,
    "architecture/foundation/source-dependencies.yaml",
  );
  const inspector = new PnpmSourceWorkspaceTopologyInspector({
    inventoryReader: new PnpmWorkspaceInventoryReader(),
    ...sourceTopologyAdapters(),
    ...dependencies,
  });
  return inspector.inspect({
    consumerRoot,
    workspaceManifestPath: policy.workspaceManifestPath,
    packageRoots: policy.packageRoots,
    governedRoots: policy.governedRoots,
    boundaryRoots: policy.boundaries.flatMap((boundaryPolicy) =>
      boundaryPolicy.roots.map((path) => ({
        boundaryId: boundaryPolicy.id,
        path,
      })),
    ),
    ...(signal === undefined ? {} : { signal }),
  });
}

export function signalThatFailsAfterConfiguration() {
  let observations = 0;
  return new Proxy(new AbortController().signal, {
    get(target, property) {
      if (property === "aborted") {
        observations += 1;
        if (observations > 1) {
          throw new Error("deterministic execution failure");
        }
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function sourceConfigPath(consumerRoot) {
  return join(consumerRoot, "architecture", "foundation", "source-dependencies.yaml");
}

export async function addWorkspacePackage(consumerRoot, packageName) {
  const workspacePackageRoot = join(consumerRoot, "packages", packageName);
  await mkdir(join(workspacePackageRoot, "src"), { recursive: true });
  await Promise.all([
    writeFile(
      join(workspacePackageRoot, "package.json"),
      `${JSON.stringify({
        name: `@fixture/${packageName}`,
        version: "0.0.0",
        private: true,
        type: "module",
        exports: { ".": "./dist/index.js" },
      }, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      join(workspacePackageRoot, "src", "index.ts"),
      "export const value = true;\n",
      "utf8",
    ),
  ]);
}

export function sourceArchitectureConfig(schemaVersion) {
  const packageRoots = schemaVersion === 2 ? "packageRoots:\n  - packages\n" : "";
  return `schemaVersion: ${schemaVersion}\nworkspace:\n  kind: pnpm\n  manifest: pnpm-workspace.yaml\n${packageRoots}governedRoots:\n  - packages/app/src\nboundaries:\n  - id: app.surface\n    roots:\n      - packages/app/src\n    entrypoints:\n      - packages/app/src/index.ts\n    allow:\n      boundaries: []\n      packages: []\n      builtins: []\n      runtimeReferences: []\n`;
}

export async function configProblem(consumerRoot, name, source) {
  await writeFile(join(consumerRoot, name), source, "utf8");
  try {
    await loadCapabilityConfig(consumerRoot, name);
  } catch (error) {
    return error?.problem;
  }
}
