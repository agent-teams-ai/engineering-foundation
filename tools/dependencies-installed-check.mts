import { createRequire } from "node:module";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

interface Manifest {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
  readonly engines?: Readonly<Record<string, string>>;
}

const require = createRequire(import.meta.url);
const semver = (() => {
  try {
    return require("semver") as {
      readonly validRange: (range: string) => string | null;
      readonly satisfies: (version: string, range: string) => boolean;
    };
  } catch {
    return require(resolve(import.meta.dirname, "../node_modules/.pnpm/semver@7.8.5/node_modules/semver")) as {
      readonly validRange: (range: string) => string | null;
      readonly satisfies: (version: string, range: string) => boolean;
    };
  }
})();

function dependencyNames(manifest: Manifest, includeDevelopment: boolean): readonly string[] {
  return [...new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...(includeDevelopment ? Object.keys(manifest.devDependencies ?? {}) : []),
    ...Object.keys(manifest.optionalDependencies ?? {})
  ])].toSorted();
}

async function packageDirectories(root: string, patterns: readonly string[]): Promise<readonly string[]> {
  const directories: string[] = [root];
  for (const pattern of patterns) {
    const match = /^([^/*]+)\/\*$/u.exec(pattern);
    if (match === null) {
      throw new Error(`Unsupported workspace package pattern: ${pattern}`);
    }
    const parent = resolve(root, match[1] ?? "");
    const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        directories.push(join(parent, entry.name));
      }
    }
  }
  return directories.toSorted();
}

async function manifestAt(path: string): Promise<Manifest | undefined> {
  try {
    return JSON.parse(await readFile(join(path, "package.json"), "utf8")) as Manifest;
  } catch {
    return undefined;
  }
}

async function resolveInstalled(issuer: string, name: string): Promise<string | undefined> {
  let current = issuer;
  while (true) {
    const candidate = join(current, "node_modules", ...name.split("/"));
    const manifest = await manifestAt(candidate);
    if (manifest !== undefined) {
      return await realpath(candidate);
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function validRange(range: string, subject: string): string {
  const parsed = semver.validRange(range);
  if (parsed === null) {
    throw new Error(`Malformed SemVer range for ${subject}: ${range}`);
  }
  return parsed;
}

function checkEngine(manifest: Manifest, subject: string, nodeVersion: string, bunVersion: string): void {
  for (const [engine, range] of Object.entries(manifest.engines ?? {})) {
    const version = engine === "node" ? nodeVersion : engine === "bun" ? bunVersion : undefined;
    if (version === undefined) {
      continue;
    }
    const normalized = validRange(range, `${subject} engines.${engine}`);
    if (!semver.satisfies(version, normalized)) {
      throw new Error(`Installed engine mismatch for ${subject}: ${engine} ${version} does not satisfy ${range}.`);
    }
  }
}

export async function inspectInstalledDependencies(
  root: string,
  nodeVersion = "26.11.1",
  bunVersion = "1.4.3"
): Promise<{
  readonly contextCount: number;
  readonly packages: ReadonlySet<string>;
  readonly peerAssignments: ReadonlySet<string>;
}> {
  const rootManifest = await manifestAt(root);
  if (rootManifest === undefined) {
    throw new Error("Installed graph root manifest is missing.");
  }
  const patterns = ["packages/*", "spikes/*"];
  const contexts = new Set<string>();
  const packages = new Set<string>();
  const peerAssignments = new Set<string>();
  const queue: string[] = [...await packageDirectories(root, patterns)];
  const seenIssuers = new Set<string>();
  const workspaceIssuers = new Set(queue.map((path) => resolve(path)));
  while (queue.length > 0) {
    const issuer = await realpath(queue.shift() ?? root);
    if (seenIssuers.has(issuer)) {
      continue;
    }
    seenIssuers.add(issuer);
    const manifest = await manifestAt(issuer);
    if (manifest === undefined) {
      throw new Error(`Installed package manifest is missing at ${issuer}.`);
    }
    checkEngine(manifest, issuer, nodeVersion, bunVersion);
    for (const name of dependencyNames(manifest, workspaceIssuers.has(issuer))) {
      const optional = Object.hasOwn(manifest.optionalDependencies ?? {}, name);
      const installed = await resolveInstalled(issuer, name);
      if (installed === undefined) {
        if (!optional) {
          throw new Error(`Required dependency is unresolved: ${name} from ${issuer}.`);
        }
        continue;
      }
      const installedManifest = await manifestAt(installed);
      if (installedManifest === undefined) {
        throw new Error(`Installed dependency metadata is missing: ${name} at ${installed}.`);
      }
      checkEngine(installedManifest, `${name}@${installedManifest.version ?? "?"}`, nodeVersion, bunVersion);
      contexts.add(`${issuer}\u0000${installed}\u0000${name}\u0000${installedManifest.version ?? ""}`);
      packages.add(`${installedManifest.name ?? name}@${installedManifest.version ?? "?"}`);
      queue.push(installed);
    }
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      const optional = manifest.peerDependenciesMeta?.[name]?.optional === true;
      const installed = await resolveInstalled(issuer, name);
      if (installed === undefined) {
        if (!optional) {
          throw new Error(`Required peer dependency is unresolved: ${name} from ${issuer}.`);
        }
        continue;
      }
      const peerManifest = await manifestAt(installed);
      const version = peerManifest?.version;
      if (version === undefined) {
        throw new Error(`Installed peer metadata is missing: ${name} from ${issuer}.`);
      }
      const normalized = validRange(range, `${name} peer from ${issuer}`);
      if (!semver.satisfies(version, normalized)) {
        throw new Error(`Incompatible installed peer for ${issuer}: ${name}@${version} does not satisfy ${range}.`);
      }
      contexts.add(`${issuer}\u0000${installed}\u0000peer:${name}\u0000${version}`);
      peerAssignments.add(`${manifest.name ?? issuer}@${manifest.version ?? "?"} -> ${peerManifest?.name ?? name}@${version}`);
    }
  }
  return { contextCount: contexts.size, packages, peerAssignments };
}

const root = resolve(process.cwd());
const inventory = await inspectInstalledDependencies(root);
const projection = {
  outcome: "passed",
  packageContexts: inventory.contextCount,
  packages: [...inventory.packages].toSorted(),
  peerAssignments: [...inventory.peerAssignments].toSorted()
};
const inventoryPath = process.env["AGENT_TEAMS_FOUNDATION_INSTALLED_INVENTORY"];
if (inventoryPath !== undefined && inventoryPath.length > 0) {
  const target = resolve(inventoryPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(projection, null, 2)}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify({
  outcome: projection.outcome,
  packageContexts: projection.packageContexts,
  packageCoordinates: projection.packages.length,
  peerAssignments: projection.peerAssignments.length,
  inventory: inventoryPath ?? null
}, null, 2)}\n`);
