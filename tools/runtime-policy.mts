import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export interface RepositoryRuntimePolicy {
  readonly schemaVersion: 1;
  readonly defaultProfile: "bun" | "node";
  readonly profiles: {
    readonly bun: { readonly manager: "bun"; readonly runtime: "bun" };
    readonly node: { readonly manager: "pnpm"; readonly runtime: "node" };
  };
  readonly toolchain: {
    readonly bun: { readonly version: string; readonly linuxX64ArchiveSha256: string };
    readonly node: { readonly version: string };
    readonly pnpm: { readonly version: string };
  };
  readonly install: {
    readonly dependencyScripts: false;
    readonly nativeInitialization: readonly string[];
    readonly disabledDependencyScripts: readonly string[];
  };
}

export interface BunRootProjection {
  readonly workspaces: readonly string[];
  readonly catalog: Readonly<Record<string, string>>;
  readonly catalogs: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly overrides: Readonly<Record<string, string>>;
}

function scalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  const comment = trimmed.search(/\s+#/u);
  return (comment < 0 ? trimmed : trimmed.slice(0, comment).trim()).replace(/\r$/u, "");
}

function mapAtIndent(
  lines: readonly string[],
  start: number,
  parentIndent: number,
): { readonly value: Readonly<Record<string, string>>; readonly next: number } {
  const value: Record<string, string> = {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) {
      index += 1;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent <= parentIndent) {
      break;
    }
    const match = /^([^:]+):\s*(.*)$/u.exec(line.trim());
    if (match === null) {
      throw new Error(`Unsupported pnpm-workspace.yaml map line: ${line}`);
    }
    value[scalar(match[1] ?? "")] = scalar(match[2] ?? "");
    index += 1;
  }
  return { value: Object.freeze(value), next: index };
}

function nestedMapsAtIndent(
  lines: readonly string[],
  start: number,
  parentIndent: number,
): {
  readonly value: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly next: number;
} {
  const value: Record<string, Record<string, string>> = {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) {
      index += 1;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent <= parentIndent) {
      break;
    }
    const match = /^([^:]+):\s*$/u.exec(line.trim());
    if (match === null) {
      throw new Error(`Unsupported pnpm-workspace.yaml nested map line: ${line}`);
    }
    const parsed = mapAtIndent(lines, index + 1, indent);
    value[scalar(match[1] ?? "")] = { ...parsed.value };
    index = parsed.next;
  }
  return {
    value: Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, Object.freeze(entry)])),
    ),
    next: index,
  };
}

// oxlint-disable-next-line complexity -- The closed YAML subset has one deterministic authority parser.
export function parsePnpmWorkspaceAuthority(source: string): BunRootProjection {
  const lines = source.replace(/\r\n/gu, "\n").split("\n");
  const packages: string[] = [];
  let catalog: Readonly<Record<string, string>> = Object.freeze({});
  let catalogs: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({});
  let overrides: Readonly<Record<string, string>> = Object.freeze({});
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) {
      index += 1;
      continue;
    }
    const top = /^([A-Za-z][A-Za-z0-9-]*):(?:\s*(.*))?$/u.exec(line);
    if (top === null || line.length !== line.trimStart().length) {
      throw new Error(`Unsupported pnpm-workspace.yaml top-level line: ${line}`);
    }
    const key = top[1] ?? "";
    const inline = top[2] ?? "";
    index += 1;
    if (key === "packages") {
      if (inline.trim().length > 0) {
        throw new Error("Inline pnpm workspace package arrays are not supported.");
      }
      while (index < lines.length) {
        const entry = lines[index] ?? "";
        if (entry.trim().length === 0 || entry.trimStart().startsWith("#")) {
          index += 1;
          continue;
        }
        const indent = entry.length - entry.trimStart().length;
        if (indent === 0) {
          break;
        }
        const item = /^\s*-\s*(.+)$/u.exec(entry);
        if (item === null) {
          throw new Error(`Unsupported pnpm workspace package line: ${entry}`);
        }
        packages.push(scalar(item[1] ?? ""));
        index += 1;
      }
      continue;
    }
    if (key === "catalog") {
      const parsed = mapAtIndent(lines, index, 0);
      catalog = parsed.value;
      index = parsed.next;
      continue;
    }
    if (key === "catalogs") {
      const parsed = nestedMapsAtIndent(lines, index, 0);
      catalogs = parsed.value;
      index = parsed.next;
      continue;
    }
    if (key === "overrides") {
      const parsed = mapAtIndent(lines, index, 0);
      overrides = parsed.value;
      index = parsed.next;
      continue;
    }
    while (
      index < lines.length &&
      (lines[index] ?? "").length !== (lines[index] ?? "").trimStart().length
    ) {
      index += 1;
    }
  }
  return Object.freeze({
    workspaces: Object.freeze(packages),
    catalog,
    catalogs,
    overrides,
  });
}

export async function readRepositoryRuntimePolicy(
  root: string = repositoryRoot,
): Promise<RepositoryRuntimePolicy> {
  const value = JSON.parse(
    await readFile(resolve(root, "architecture/foundation/repository-runtime.json"), "utf8"),
  ) as {
    readonly schemaVersion?: unknown;
    readonly defaultProfile?: unknown;
    readonly toolchain?: {
      readonly bun?: { readonly version?: unknown };
      readonly node?: { readonly version?: unknown };
      readonly pnpm?: { readonly version?: unknown };
    };
  } | null;
  if (
    value?.schemaVersion !== 1 ||
    value.defaultProfile !== "bun" ||
    value.toolchain?.bun?.version !== "1.4.3" ||
    value.toolchain.node?.version !== "26.11.1" ||
    value.toolchain.pnpm?.version !== "11.20.0"
  ) {
    throw new Error("Repository runtime policy identity is invalid.");
  }
  return value as RepositoryRuntimePolicy;
}

export async function assertBunRootProjection(
  root: string = repositoryRoot,
): Promise<BunRootProjection> {
  const [manifestSource, workspaceSource] = await Promise.all([
    readFile(resolve(root, "package.json"), "utf8"),
    readFile(resolve(root, "pnpm-workspace.yaml"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestSource) as Record<string, unknown>;
  const projection = parsePnpmWorkspaceAuthority(workspaceSource);
  const workspaces = manifest["workspaces"] as Record<string, unknown> | undefined;
  const expected = {
    packages: projection.workspaces,
    catalog: projection.catalog,
    catalogs: projection.catalogs,
  };
  for (const field of ["packages", "catalog", "catalogs"] as const) {
    if (JSON.stringify(workspaces?.[field]) !== JSON.stringify(expected[field])) {
      throw new Error(`Bun root workspaces.${field} drifted from pnpm-workspace.yaml.`);
    }
  }
  for (const field of ["catalog", "catalogs", "overrides"] as const) {
    if (JSON.stringify(manifest[field]) !== JSON.stringify(projection[field])) {
      throw new Error(`Bun root field ${field} drifted from pnpm-workspace.yaml.`);
    }
  }
  if (manifest["packageManager"] !== "bun@1.4.3") {
    throw new Error("The repository root packageManager must be bun@1.4.3.");
  }
  return projection;
}

// This is a closed projection of this repository's reviewed policy bytes.
// Public consumers select their own manager through the v2 schema instead.
export function projectNodeAgentWorkflowPolicy(source: string): string {
  const versions = [...source.matchAll(/^schemaVersion:[^\n]*$/gmu)];
  const managers = [...source.matchAll(/^packageManager:[^\n]*$/gmu)];
  if (
    versions.length !== 1 ||
    versions[0]?.[0].trimEnd() !== "schemaVersion: 2" ||
    managers.length !== 1 ||
    managers[0]?.[0].trimEnd() !== "packageManager: bun"
  ) {
    throw new Error("Node projection requires the exact repository v2 Bun workflow policy.");
  }
  return source.replace(/^packageManager: bun(?=\r?$)/mu, "packageManager: pnpm");
}

export async function assertNodeAgentWorkflowPolicyProjection(
  root: string,
  sourceRoot: string,
  evidence: {
    readonly originalWorkflowPolicySha256: string;
    readonly derivedWorkflowPolicySha256: string;
  },
): Promise<void> {
  const path = "architecture/foundation/repository-agent-workflow.yaml";
  const original = await readFile(resolve(sourceRoot, path), "utf8");
  const derived = await readFile(resolve(root, path), "utf8");
  if (
    derived !== projectNodeAgentWorkflowPolicy(original) ||
    createHash("sha256").update(original).digest("hex") !== evidence.originalWorkflowPolicySha256 ||
    createHash("sha256").update(derived).digest("hex") !== evidence.derivedWorkflowPolicySha256
  ) {
    throw new Error("Node profile workflow policy projection or digest evidence is stale.");
  }
}

// Recognizes this repository's complete ASCII policy format, not consumer YAML.
function isCanonicalDependencyDeclarationsPolicy(source: string): boolean {
  const normalized = source.replaceAll("\r\n", "\n");
  if (/[^\n -~]/u.test(normalized)) {
    return false;
  }
  const lines = normalized.split("\n").filter((line) => !/^ *(?:#.*)?$/u.test(line));
  const headers = [
    "schemaVersion: 2",
    "packageManager:",
    "  kind: bun",
    "  workspaceManifest: pnpm-workspace.yaml",
    "policies:",
    "  externalDependencies: catalog",
    "  catalogVersions: exact",
    "  internalDependencies: workspace-protocol",
  ];
  if (headers.some((line, index) => lines[index] !== line)) {
    return false;
  }
  const packageItem =
    /^    - (?:"(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*"|[a-z0-9][a-z0-9._-]*)$/u;
  let index = headers.length;
  for (const [field, item] of [
    ["reservedScopes", /^    - "@[a-z0-9][a-z0-9._-]*\/"$/u],
    ["developmentOnlyPackages", packageItem],
    ["exactRegistryDevelopmentOnlyPackages", packageItem],
  ] as const) {
    if (lines[index] === `  ${field}: []`) {
      index += 1;
      continue;
    }
    if (lines[index] !== `  ${field}:`) {
      return false;
    }
    index += 1;
    const values = new Set<string>();
    while (item.test(lines[index] ?? "")) {
      const value = (lines[index] ?? "").slice(6).replaceAll('"', "");
      if (values.has(value)) {
        return false;
      }
      values.add(value);
      index += 1;
    }
    if (values.size === 0) {
      return false;
    }
  }
  return index === lines.length;
}

export function projectNodeDependencyDeclarationsPolicy(source: string): string {
  if (!isCanonicalDependencyDeclarationsPolicy(source)) {
    throw new Error(
      "Node projection requires the exact repository v2 Bun dependency declaration policy.",
    );
  }
  return source.replace(/^  kind: bun(?=\r?$)/mu, "  kind: pnpm");
}

export async function assertNodeDependencyDeclarationsPolicyProjection(
  root: string,
  sourceRoot: string,
  evidence: {
    readonly originalDependencyDeclarationsPolicySha256: string;
    readonly derivedDependencyDeclarationsPolicySha256: string;
  },
): Promise<void> {
  const path = "architecture/foundation/dependency-declarations.yaml";
  const original = await readFile(resolve(sourceRoot, path), "utf8");
  const derived = await readFile(resolve(root, path), "utf8");
  if (
    derived !== projectNodeDependencyDeclarationsPolicy(original) ||
    createHash("sha256").update(original).digest("hex") !==
      evidence.originalDependencyDeclarationsPolicySha256 ||
    createHash("sha256").update(derived).digest("hex") !==
      evidence.derivedDependencyDeclarationsPolicySha256
  ) {
    throw new Error(
      "Node profile dependency declaration policy projection or digest evidence is stale.",
    );
  }
}
