import { createRequire } from "node:module";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePnpmWorkspaceAuthority } from "./runtime-policy.mts";

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

interface PeerAssignment {
  readonly name: string;
  readonly range: string;
  readonly optional: boolean;
  readonly resolution: string;
}

interface Inventory {
  readonly outcome: "passed";
  readonly packageContexts: readonly string[];
  readonly packages: readonly string[];
  readonly peerAssignments: readonly string[];
}

const require = createRequire(import.meta.url);
const semver = require("semver") as {
  readonly validRange: (range: string) => string | null;
  readonly satisfies: (version: string, range: string) => boolean;
};

function dependencyNames(manifest: Manifest, includeDevelopment: boolean): readonly string[] {
  return [...new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...(includeDevelopment ? Object.keys(manifest.devDependencies ?? {}) : []),
    ...Object.keys(manifest.optionalDependencies ?? {})
  ])].toSorted();
}

async function packageDirectories(
  root: string,
  patterns: readonly string[]
): Promise<readonly string[]> {
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

function belongsToCanonicalRoot(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return relativePath === "" || (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

async function resolveInstalled(
  canonicalRoot: string,
  issuer: string,
  name: string
): Promise<string | undefined> {
  let current = issuer;
  while (true) {
    const candidate = join(current, "node_modules", ...name.split("/"));
    if (await manifestAt(candidate) !== undefined) {
      const installed = await realpath(candidate);
      if (!belongsToCanonicalRoot(canonicalRoot, installed)) {
        throw new Error(
          `Installed package resolution is outside canonical graph root: ${name} from ${issuer} resolves to ${installed}.`
        );
      }
      return installed;
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

function coordinate(manifest: Manifest, fallback: string): string {
  return `${manifest.name ?? fallback}@${manifest.version ?? "?"}`;
}

function checkEngine(
  manifest: Manifest,
  subject: string,
  nodeVersion: string,
  bunVersion: string
): void {
  for (const [engine, range] of Object.entries(manifest.engines ?? {})) {
    const version = engine === "node" ? nodeVersion : engine === "bun" ? bunVersion : undefined;
    if (version === undefined) {
      continue;
    }
    const normalized = validRange(range, `${subject} engines.${engine}`);
    if (!semver.satisfies(version, normalized)) {
      throw new Error(
        `Installed engine mismatch for ${subject}: ${engine} ${version} does not satisfy ${range}.`
      );
    }
  }
}

async function inspectPeers(
  canonicalRoot: string,
  issuer: string,
  manifest: Manifest
): Promise<readonly PeerAssignment[]> {
  const assignments: PeerAssignment[] = [];
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    const normalized = validRange(range, `${name} peer from ${issuer}`);
    const optional = manifest.peerDependenciesMeta?.[name]?.optional === true;
    const installed = await resolveInstalled(canonicalRoot, issuer, name);
    if (installed === undefined) {
      if (!optional) {
        throw new Error(`Required peer dependency is unresolved: ${name} from ${issuer}.`);
      }
      assignments.push({ name, range: normalized, optional, resolution: "missing-optional" });
      continue;
    }
    const peerManifest = await manifestAt(installed);
    const version = peerManifest?.version;
    if (version === undefined) {
      throw new Error(`Installed peer metadata is missing: ${name} from ${issuer}.`);
    }
    if (!semver.satisfies(version, normalized)) {
      throw new Error(
        `Incompatible installed peer for ${issuer}: ${name}@${version} does not satisfy ${range}.`
      );
    }
    assignments.push({
      name,
      range: normalized,
      optional,
      resolution: `${peerManifest?.name ?? name}@${version}`
    });
  }
  return assignments.toSorted((left, right) => left.name.localeCompare(right.name));
}

export async function inspectInstalledDependencies(
  root: string,
  nodeVersion = "26.11.1",
  bunVersion = "1.4.3"
): Promise<Inventory> {
  const canonicalRoot = await realpath(resolve(root));
  const rootManifest = await manifestAt(canonicalRoot);
  if (rootManifest === undefined) {
    throw new Error("Installed graph root manifest is missing.");
  }
  const authority = parsePnpmWorkspaceAuthority(
    await readFile(resolve(canonicalRoot, "pnpm-workspace.yaml"), "utf8")
  );
  const packageContexts = new Set<string>();
  const packages = new Set<string>();
  const peerAssignments = new Set<string>();
  const queue: string[] = [...await packageDirectories(canonicalRoot, authority.workspaces)];
  const workspaceIssuers = new Set(await Promise.all(queue.map((path) => realpath(path))));
  const seenIssuers = new Set<string>();
  while (queue.length > 0) {
    const issuer = await realpath(queue.shift() ?? canonicalRoot);
    if (seenIssuers.has(issuer)) {
      continue;
    }
    seenIssuers.add(issuer);
    const manifest = await manifestAt(issuer);
    if (manifest === undefined) {
      throw new Error(`Installed package manifest is missing at ${issuer}.`);
    }
    const issuerCoordinate = coordinate(manifest, relative(canonicalRoot, issuer) || "root");
    checkEngine(manifest, issuerCoordinate, nodeVersion, bunVersion);
    const peers = await inspectPeers(canonicalRoot, issuer, manifest);
    for (const peer of peers) {
      peerAssignments.add(`${issuerCoordinate} -> ${peer.name}@${peer.range}=${peer.resolution}`);
      if (peer.resolution !== "missing-optional") {
        const peerPath = await resolveInstalled(canonicalRoot, issuer, peer.name);
        const peerManifest = await manifestAt(peerPath ?? issuer);
        if (peerManifest !== undefined) {
          queue.push(peerPath ?? issuer);
        }
      }
    }
    for (const name of dependencyNames(manifest, workspaceIssuers.has(issuer))) {
      const optional = Object.hasOwn(manifest.optionalDependencies ?? {}, name);
      const installed = await resolveInstalled(canonicalRoot, issuer, name);
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
      const targetCoordinate = coordinate(installedManifest, name);
      checkEngine(installedManifest, targetCoordinate, nodeVersion, bunVersion);
      const targetPeers = await inspectPeers(canonicalRoot, installed, installedManifest);
      const peerProjection = targetPeers.map((peer) =>
        `${peer.name}@${peer.range}=${peer.resolution}`
      ).join(",");
      packages.add(targetCoordinate);
      packageContexts.add(
        `${issuerCoordinate} -> ${name}@${targetCoordinate} [${peerProjection}]`
      );
      queue.push(installed);
      await enqueuePeerTargets(canonicalRoot, targetPeers, installed, queue);
    }
  }
  return {
    outcome: "passed",
    packageContexts: [...packageContexts].toSorted(),
    packages: [...packages].toSorted(),
    peerAssignments: [...peerAssignments].toSorted()
  };
}

async function enqueuePeerTargets(
  canonicalRoot: string,
  peers: readonly PeerAssignment[],
  issuer: string,
  queue: string[]
): Promise<void> {
  for (const peer of peers) {
    if (peer.resolution === "missing-optional") {
      continue;
    }
    const peerPath = await resolveInstalled(canonicalRoot, issuer, peer.name);
    if (peerPath !== undefined) {
      queue.push(peerPath);
    }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.cwd());
  const inventory = await inspectInstalledDependencies(root);
  const inventoryPath = process.env["AGENT_TEAMS_FOUNDATION_INSTALLED_INVENTORY"];
  if (inventoryPath !== undefined && inventoryPath.length > 0) {
    const target = resolve(inventoryPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify({
    outcome: inventory.outcome,
    packageContexts: inventory.packageContexts.length,
    packageCoordinates: inventory.packages.length,
    peerAssignments: inventory.peerAssignments.length,
    inventory: inventoryPath ?? null
  }, null, 2)}\n`);
}
