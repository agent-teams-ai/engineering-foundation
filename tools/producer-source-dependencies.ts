import { lstat, mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { parsePnpmWorkspaceAuthority, type BunRootProjection } from "./runtime-policy.mts";

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}
async function manifest(path: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(path, "package.json"), "utf8")) as Manifest;
}
function contained(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}
async function resolvePackage(root: string, issuer: string, name: string): Promise<string | undefined> {
  let current = issuer;
  while (contained(root, current)) {
    const candidate = join(current, "node_modules", name);
    const entry = await lstat(candidate).catch(() => null);
    if (entry !== null) {
      const physical = await realpath(candidate);
      if (!contained(join(root, "node_modules"), physical)) {
        throw new Error(`Producer dependency escapes installed graph: ${name}`);
      }
      return physical;
    }
    if (current === root) { break; }
    current = dirname(current);
  }
  return undefined;
}

function admittedVersion(name: string, spec: string, authority: BunRootProjection): string {
  const catalog = spec === "catalog:" ? authority.catalog : authority.catalogs[spec.slice(8)];
  const version = spec.startsWith("catalog:") ? catalog?.[name] : spec;
  if (version === undefined || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(version)) {
    throw new Error(`Producer dependency requires an exact admitted version: ${name}`);
  }
  return version;
}

/** The registry consumer remains installed; only its shadowed producer receives dependency links. */
export async function projectProducerSourceDependencies(directory: string): Promise<void> {
  const root = await realpath(directory);
  const source = join(root, "packages/stack-toolchain");
  const sourceManifest = await manifest(source);
  const rootManifest = await manifest(root);
  const selected = rootManifest.devDependencies?.[sourceManifest.name];
  if (selected === undefined) { return; }
  const installed = await realpath(join(root, "node_modules", sourceManifest.name));
  if (installed === source || !contained(join(root, "node_modules"), installed)) {
    throw new Error("Producer projection requires a distinct contained registry Toolchain installation.");
  }
  const registry = await manifest(installed);
  if (registry.name !== sourceManifest.name || registry.version !== selected) {
    throw new Error("Producer projection registry identity differs from the exact root declaration.");
  }
  const authority = parsePnpmWorkspaceAuthority(await readFile(join(root, "pnpm-workspace.yaml"), "utf8"));
  const declarations = { ...sourceManifest.dependencies, ...sourceManifest.devDependencies, ...sourceManifest.optionalDependencies };
  const planned: { name: string; target: string }[] = [];
  for (const [name, spec] of Object.entries(declarations)) {
    const version = admittedVersion(name, spec, authority);
    const existing = await resolvePackage(root, source, name);
    const target = existing ?? await resolvePackage(root, installed, name);
    if (target === undefined) {
      if (sourceManifest.optionalDependencies?.[name] !== undefined) { continue; }
      throw new Error(`Required producer dependency is unavailable: ${name}`);
    }
    const observed = await manifest(target);
    if (observed.name !== name || observed.version !== version) {
      throw new Error(`Producer dependency identity mismatch: ${name}`);
    }
    if (existing === undefined) { planned.push({ name, target }); }
  }
  // Validate every dependency before making the first owned link. Never replace existing entries.
  for (const { name, target } of planned) {
    const link = join(source, "node_modules", name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(target, link, "junction");
    if (await realpath(link) !== target) { throw new Error(`Producer dependency link changed: ${name}`); }
  }
}
