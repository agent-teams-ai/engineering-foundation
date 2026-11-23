import { lstat, mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { parsePnpmWorkspaceAuthority, type BunRootProjection } from "./runtime-policy.mts";

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}
type MetadataResolvers = ReadonlyMap<string, () => string>;

function bootstrapMetadata(
  root: string,
  rootManifest: Manifest,
  declarations: Readonly<Record<string, string>>,
  authority: BunRootProjection,
): MetadataResolvers {
  const require = createRequire(join(root, "package.json"));
  const available = new Map<string, () => string>([
    [
      "@typescript-eslint/scope-manager",
      () => require.resolve("@typescript-eslint/scope-manager/package.json"),
    ],
    ["eslint", () => require.resolve("eslint/package.json")],
    ["eslint-parser-oxc", () => require.resolve("eslint-parser-oxc/package.json")],
  ]);
  const admitted = new Map<string, () => string>();
  for (const [name, resolveMetadata] of available) {
    const rootSpec = rootManifest.devDependencies?.[name];
    const sourceSpec = declarations[name];
    if (rootSpec !== undefined && sourceSpec !== undefined) {
      admitted.set(name, () => {
        if (
          admittedVersion(name, rootSpec, authority) !==
          admittedVersion(name, sourceSpec, authority)
        ) {
          throw new Error(`Producer bootstrap declaration mismatch: ${name}`);
        }
        return resolveMetadata();
      });
    }
  }
  return admitted;
}
async function manifest(path: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(path, "package.json"), "utf8")) as Manifest;
}
function contained(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}
async function resolvePackage(
  root: string,
  issuer: string,
  name: string,
  metadata: MetadataResolvers,
): Promise<string | undefined> {
  let current = issuer;
  while (contained(root, current)) {
    const candidate = join(current, "node_modules", name);
    const entry = await lstat(candidate).catch(() => null);
    if (entry !== null) {
      const physical = await realpath(candidate);
      if (!contained(join(root, "node_modules"), physical)) {
        throw new Error(`Producer dependency escapes installed graph: ${name}`);
      }
      const publicMetadata = current === root ? metadata.get(name)?.() : undefined;
      if (publicMetadata !== undefined) {
        const resolvedMetadata = await realpath(publicMetadata);
        if (resolvedMetadata !== join(physical, "package.json")) {
          throw new Error(`Producer bootstrap metadata identity mismatch: ${name}`);
        }
        return dirname(resolvedMetadata);
      }
      return physical;
    }
    if (current === root) {
      break;
    }
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

async function resolveHostCore(
  root: string,
  declarations: Readonly<Record<string, string>>,
  authority: BunRootProjection,
  metadata: MetadataResolvers,
): Promise<string | undefined> {
  const hostSpec = declarations.eslint;
  if (hostSpec === undefined || !metadata.has("eslint")) {
    return undefined;
  }
  const host = await resolvePackage(root, root, "eslint", metadata);
  if (host === undefined) {
    return undefined;
  }
  const observed = await manifest(host);
  if (
    observed.name !== "eslint" ||
    observed.version !== admittedVersion("eslint", hostSpec, authority) ||
    observed.dependencies?.["@eslint/core"] === undefined
  ) {
    throw new Error("Producer type dependency requires its exact declared ESLint host.");
  }
  return resolvePackage(root, host, "@eslint/core", metadata);
}

/** The registry consumer remains installed; only its shadowed producer receives dependency links. */
export async function projectProducerSourceDependencies(directory: string): Promise<void> {
  const root = await realpath(directory);
  const source = join(root, "packages/stack-toolchain");
  const sourceManifest = await manifest(source);
  const rootManifest = await manifest(root);
  const selected = rootManifest.devDependencies?.[sourceManifest.name];
  if (selected === undefined) {
    return;
  }
  const installed = await realpath(join(root, "node_modules", sourceManifest.name));
  if (installed === source || !contained(join(root, "node_modules"), installed)) {
    throw new Error(
      "Producer projection requires a distinct contained registry Toolchain installation.",
    );
  }
  const registry = await manifest(installed);
  if (registry.name !== sourceManifest.name || registry.version !== selected) {
    throw new Error(
      "Producer projection registry identity differs from the exact root declaration.",
    );
  }
  const authority = parsePnpmWorkspaceAuthority(
    await readFile(join(root, "pnpm-workspace.yaml"), "utf8"),
  );
  const declarations = {
    ...sourceManifest.dependencies,
    ...sourceManifest.devDependencies,
    ...sourceManifest.optionalDependencies,
  };
  const metadata = bootstrapMetadata(root, rootManifest, declarations, authority);
  const planned: { name: string; target: string }[] = [];
  for (const [name, spec] of Object.entries(declarations)) {
    const version = admittedVersion(name, spec, authority);
    const existing = await resolvePackage(root, source, name, metadata);
    const target =
      existing ??
      (await resolvePackage(root, installed, name, metadata)) ??
      (name === "@eslint/core"
        ? await resolveHostCore(root, declarations, authority, metadata)
        : undefined);
    if (target === undefined) {
      if (sourceManifest.optionalDependencies?.[name] !== undefined) {
        continue;
      }
      throw new Error(`Required producer dependency is unavailable: ${name}`);
    }
    const observed = await manifest(target);
    if (observed.name !== name || observed.version !== version) {
      throw new Error(`Producer dependency identity mismatch: ${name}`);
    }
    if (existing === undefined) {
      planned.push({ name, target });
    }
  }
  // Validate every dependency before making the first owned link. Never replace existing entries.
  for (const { name, target } of planned) {
    const link = join(source, "node_modules", name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(target, link, "junction");
    if ((await realpath(link)) !== target) {
      throw new Error(`Producer dependency link changed: ${name}`);
    }
  }
}
