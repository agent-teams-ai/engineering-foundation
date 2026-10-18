import { parse as parseYaml } from "yaml";
import { createRequire } from "node:module";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePnpmWorkspaceAuthority, type BunRootProjection } from "./runtime-policy.mts";

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
  readonly valid: (version: string) => string | null;
  readonly validRange: (range: string) => string | null;
  readonly satisfies: (version: string, range: string) => boolean;
};

function dependencyDeclarations(manifest: Manifest, includeDevelopment: boolean): readonly (readonly [string, string])[] {
  return Object.entries({
    ...(includeDevelopment ? manifest.devDependencies : {}),
    ...manifest.dependencies,
    ...manifest.optionalDependencies
  }).toSorted(([left], [right]) => left.localeCompare(right));
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
  for (;;) {
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

function peerRange(range: string, workspaceVersion: string | undefined, subject: string): string {
  if (!range.startsWith("workspace:")) {
    return validRange(range, subject);
  }
  if (workspaceVersion === undefined) {
    throw new Error(`Workspace peer has no declared workspace package: ${subject}.`);
  }
  const selector = range.slice("workspace:".length);
  const selected = selector === "^" || selector === "~" ? `${selector}${workspaceVersion}`
    : selector === "*" ? workspaceVersion : selector;
  return validRange(selected, subject);
}

interface WorkspacePackage { readonly path: string; readonly version: string }

function catalogSpec(
  name: string, spec: string, authority: BunRootProjection, workspaceIssuer: boolean
): string {
  if (!spec.startsWith("catalog:")) { return spec; }
  if (!workspaceIssuer) { throw new Error(`Registry dependency cannot borrow a workspace catalog: ${name}.`); }
  const catalog = spec === "catalog:" ? authority.catalog : authority.catalogs[spec.slice("catalog:".length)];
  const selected = catalog?.[name];
  if (selected === undefined) { throw new Error(`Dependency catalog declaration is missing: ${name}@${spec}.`); }
  return selected;
}

function aliasSpec(name: string, spec: string): { readonly name: string; readonly range: string } {
  if (!spec.startsWith("npm:")) { return { name, range: spec }; }
  const match = /^npm:((?:@[^/\s:@]+\/)?[^/\s:@]+)@(.+)$/u.exec(spec);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`Unsupported dependency npm alias: ${name}@${spec}.`);
  }
  return { name: match[1], range: match[2] };
}

interface DependencyContext {
  readonly authority: BunRootProjection;
  readonly workspaceIssuer: boolean;
  readonly workspacePackages: ReadonlyMap<string, WorkspacePackage>;
  readonly lockedTags: ReadonlyMap<string, ReadonlySet<string>>;
}

function dependencyAdmission(
  name: string, declared: string, issuer: Manifest, context: DependencyContext
): { readonly name: string; readonly range: string; readonly workspace?: WorkspacePackage } {
  const requested = aliasSpec(name, catalogSpec(name, declared, context.authority, context.workspaceIssuer));
  const override = context.authority.overrides[name];
  if (requested.range.startsWith("workspace:") && override !== undefined) {
    throw new Error(`Unsupported override of workspace dependency: ${name}.`);
  }
  if (requested.name !== name && context.authority.overrides[requested.name] !== undefined) {
    throw new Error(`Unsupported override of npm alias target: ${name}.`);
  }
  const admitted = override === undefined ? requested : aliasSpec(requested.name, override);
  const workspace = admitted.range.startsWith("workspace:") ? context.workspacePackages.get(admitted.name) : undefined;
  const selected = /^[A-Za-z][A-Za-z0-9._-]*$/u.test(admitted.range)
    ? lockedTagRange(issuer, name, admitted.name, context.lockedTags)
    : admitted.range;
  return { name: admitted.name, range: peerRange(selected, workspace?.version, `${name} dependency`),
    ...(workspace === undefined ? {} : { workspace }) };
}

function checkDependency(
  name: string,
  admitted: ReturnType<typeof dependencyAdmission>,
  installed: string,
  manifest: Manifest
): void {
  if (admitted.workspace !== undefined && installed !== admitted.workspace.path) {
    throw new Error(`Workspace dependency resolves outside its declared workspace package: ${name}.`);
  }
  if (manifest.name !== admitted.name) {
    throw new Error(`Installed dependency identity mismatch: ${name} requires ${admitted.name}, found ${manifest.name ?? "missing"}.`);
  }
  if (manifest.version === undefined || !semver.satisfies(manifest.version, admitted.range)) {
    throw new Error(`Installed dependency version mismatch: ${name}@${manifest.version ?? "missing"} does not satisfy ${admitted.range}.`);
  }
}

function lockedTagRange(
  issuer: Manifest, name: string, target: string, edges: ReadonlyMap<string, ReadonlySet<string>>
): string {
  const versions = edges.get(`${coordinate(issuer, "missing")} -> ${name}`);
  const values = [...versions ?? []];
  const locked = values.length === 1 ? values[0] : undefined;
  const version = locked?.startsWith(`${target}@`) === true ? locked.slice(target.length + 1) : locked;
  const normalized = version?.split("(")[0];
  if (normalized === undefined || semver.valid(normalized) === null) {
    throw new Error(`Dependency tag has no unambiguous frozen lock coordinate: ${name} from ${coordinate(issuer, "missing")}.`);
  }
  return normalized;
}

async function frozenTagEdges(root: string): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const source = await readFile(join(root, "pnpm-lock.yaml"), "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") { throw error; }
    return null;
  });
  const edges = new Map<string, Set<string>>();
  if (source === null) { return edges; }
  const lock = parseYaml(source) as { readonly lockfileVersion?: unknown; readonly snapshots?: Readonly<Record<string, {
    readonly dependencies?: Readonly<Record<string, string>>; readonly optionalDependencies?: Readonly<Record<string, string>>;
  }>> };
  if (String(lock.lockfileVersion) !== "9.0" || lock.snapshots === undefined) {
    throw new Error("Installed dependency admission requires supported frozen pnpm lock v9 snapshots.");
  }
  for (const [issuer, snapshot] of Object.entries(lock.snapshots)) {
    for (const [name, version] of Object.entries({ ...snapshot.dependencies, ...snapshot.optionalDependencies })) {
      const key = `${issuer.split("(")[0] ?? issuer} -> ${name}`;
      const versions = edges.get(key) ?? new Set<string>();
      versions.add(version);
      edges.set(key, versions);
    }
  }
  return edges;
}

async function declaredWorkspacePeers(paths: ReadonlySet<string>) {
  const workspacePeers = new Map<string, { readonly path: string; readonly version: string }>();
  for (const path of paths) {
    const manifest = await manifestAt(path);
    if (manifest?.name !== undefined && manifest.version !== undefined) {
      workspacePeers.set(manifest.name, { path, version: manifest.version });
    }
  }
  return workspacePeers;
}

async function inspectPeers(
  canonicalRoot: string,
  issuer: string,
  manifest: Manifest,
  workspacePeers: ReadonlyMap<string, { readonly path: string; readonly version: string }>
): Promise<readonly PeerAssignment[]> {
  const assignments: PeerAssignment[] = [];
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    const workspacePeer = range.startsWith("workspace:") ? workspacePeers.get(name) : undefined;
    const normalized = peerRange(range, workspacePeer?.version, `${name} peer from ${issuer}`);
    const optional = manifest.peerDependenciesMeta?.[name]?.optional === true;
    const installed = await resolveInstalled(canonicalRoot, issuer, name);
    if (installed === undefined) {
      if (!optional) {
        throw new Error(`Required peer dependency is unresolved: ${name} from ${issuer}.`);
      }
      assignments.push({ name, range: normalized, optional, resolution: "missing-optional" });
      continue;
    }
    if (workspacePeer !== undefined && installed !== workspacePeer.path) {
      throw new Error(`Workspace peer resolves outside its declared workspace package: ${name} from ${issuer}.`);
    }
    const peerManifest = await manifestAt(installed);
    const version = peerManifest?.version;
    if (version === undefined) {
      throw new Error(`Installed peer metadata is missing: ${name} from ${issuer}.`);
    }
    if (peerManifest?.name !== name) {
      throw new Error(`Installed peer identity mismatch: ${name} from ${issuer} resolved to ${peerManifest?.name ?? "missing"}.`);
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
      resolution: `${name}@${version}`
    });
  }
  return assignments.toSorted((left, right) => left.name.localeCompare(right.name));
}

function assertSupportedOverrides(overrides: Readonly<Record<string, string>>): void {
  for (const selector of Object.keys(overrides)) {
    if (!/^(?:@[^/\s:@]+\/)?[^/\s:@>]+$/u.test(selector)) {
      throw new Error(`Unsupported dependency override selector: ${selector}.`);
    }
  }
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
  assertSupportedOverrides(authority.overrides);
  const packageContexts = new Set<string>();
  const packages = new Set<string>();
  const peerAssignments = new Set<string>();
  const queue: string[] = [...await packageDirectories(canonicalRoot, authority.workspaces)];
  const workspaceIssuers = new Set(await Promise.all(queue.map((path) => realpath(path))));
  const workspacePeers = await declaredWorkspacePeers(workspaceIssuers);
  const lockedTags = await frozenTagEdges(canonicalRoot);
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
    const peers = await inspectPeers(canonicalRoot, issuer, manifest, workspacePeers);
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
    for (const [name, declared] of dependencyDeclarations(manifest, workspaceIssuers.has(issuer))) {
      const optional = Object.hasOwn(manifest.optionalDependencies ?? {}, name);
      const admitted = dependencyAdmission(name, declared, manifest, {
        authority, workspaceIssuer: workspaceIssuers.has(issuer), workspacePackages: workspacePeers, lockedTags
      });
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
      checkDependency(name, admitted, installed, installedManifest);
      const targetCoordinate = coordinate(installedManifest, name);
      checkEngine(installedManifest, targetCoordinate, nodeVersion, bunVersion);
      const targetPeers = await inspectPeers(canonicalRoot, installed, installedManifest, workspacePeers);
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
