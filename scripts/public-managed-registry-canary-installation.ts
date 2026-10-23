import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  ProjectedCanaryAuthority,
  CanaryPackageCoordinate,
} from "./public-managed-registry-canary-policy.mjs";
import {
  assertSafeTarballInventory,
  assertTarballEntryTypes,
} from "./public-managed-registry-canary-validation.ts";
import {
  runCommand as untypedRunCommand,
  runNpmCommand as untypedRunNpmCommand,
} from "./pack-test-support.mjs";
interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}
type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
  options?: { timeoutMs?: number },
) => Promise<CommandResult>;
const runCommand = untypedRunCommand as CommandRunner;
const runNpmCommand = untypedRunNpmCommand as (
  args: string[],
  cwd: string,
  options?: { timeoutMs?: number },
) => Promise<CommandResult>;
interface PackageIdentity {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly integrity?: unknown;
}
const commandTimeout = 240_000;
const FORBIDDEN_MCP = "@agent-teams/docs-protocol-mcp";
export async function writeConsumer(
  root: string,
  authority: ProjectedCanaryAuthority,
  name: string,
) {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, ".npmrc"),
    [
      `registry=${authority.registry}`,
      `@agent-teams:registry=${authority.registry}`,
      "audit=false",
      "fund=false",
      "provenance=false",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name,
        private: true,
        type: "module",
        devDependencies: Object.fromEntries(
          authority.roots.map(({ name: packageName, version }) => [packageName, version]),
        ),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export async function assertInstalledRootManifests(
  root: string,
  authority: ProjectedCanaryAuthority,
) {
  for (const coordinate of authority.roots) {
    const manifest = JSON.parse(
      await readFile(
        join(root, "node_modules", ...coordinate.name.split("/"), "package.json"),
        "utf8",
      ),
    ) as PackageIdentity;
    if (manifest.name !== coordinate.name || manifest.version !== coordinate.version) {
      throw new Error(`Disposable install resolved unexpected identity for ${coordinate.name}.`);
    }
  }
}

function assertNoMcpClosure(lock: unknown, manager: string) {
  if (JSON.stringify(lock).includes(FORBIDDEN_MCP)) {
    throw new Error(`${manager} resolved forbidden Docs Protocol MCP closure.`);
  }
}

export function assertNpmLockCoordinates(
  lockfileBytes: Buffer,
  authority: ProjectedCanaryAuthority,
) {
  const lock = JSON.parse(lockfileBytes.toString("utf8")) as {
    packages?: Record<string, { version?: string; integrity?: string }>;
  };
  assertNoMcpClosure(lock, "npm");
  for (const coordinate of authority.coordinates) {
    const suffix = `node_modules/${coordinate.name}`;
    const matches = Object.entries(lock.packages ?? {}).filter(
      ([path]) => path === suffix || path.endsWith(`/${suffix}`),
    );
    if (
      matches.length === 0 ||
      matches.some(
        ([, entry]) =>
          entry.version !== coordinate.version || entry.integrity !== coordinate.integrity,
      )
    ) {
      throw new Error(`npm lock evidence differs for ${coordinate.name}.`);
    }
  }
}

export function assertPnpmLockCoordinates(
  lockfileBytes: Buffer,
  authority: ProjectedCanaryAuthority,
) {
  const lock = parseYaml(lockfileBytes.toString("utf8")) as {
    packages?: Record<string, { resolution?: { integrity?: string } } | undefined>;
  };
  assertNoMcpClosure(lock, "pnpm");
  for (const coordinate of authority.coordinates) {
    const locator = `${coordinate.name}@${coordinate.version}`;
    const matches = Object.entries(lock.packages ?? {}).filter(
      ([key]) => key === locator || key.startsWith(`${locator}(`),
    );
    if (
      matches.length === 0 ||
      matches.some(([, entry]) => entry?.resolution?.integrity !== coordinate.integrity)
    ) {
      throw new Error(`pnpm lock evidence differs for ${coordinate.name}.`);
    }
  }
}

export async function packInventory(
  root: string,
  coordinate: CanaryPackageCoordinate,
  authority: ProjectedCanaryAuthority,
) {
  const destination = join(root, "packs", coordinate.name.replaceAll("/", "-").replace("@", ""));
  await mkdir(destination, { recursive: true });
  const result = await runNpmCommand(
    [
      "pack",
      `${coordinate.name}@${coordinate.version}`,
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      destination,
      "--registry",
      authority.registry,
      "--userconfig",
      join(root, ".npmrc"),
    ],
    root,
    { timeoutMs: commandTimeout },
  );
  const report = JSON.parse(result.stdout) as PackageIdentity | PackageIdentity[];
  const item = Array.isArray(report) ? report.at(0) : report;
  if (
    item?.name !== coordinate.name ||
    item.version !== coordinate.version ||
    item.integrity !== coordinate.integrity
  ) {
    throw new Error(`npm pack identity differs from authority for ${coordinate.name}.`);
  }
  const archives = (await readdir(destination)).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1) {
    throw new Error(`npm pack did not create one bounded archive for ${coordinate.name}.`);
  }
  const archivePath = join(destination, archives.at(0)!);
  const listed = await runCommand("tar", ["-tzf", archivePath], root, {
    timeoutMs: commandTimeout,
  });
  const entries = listed.stdout.trim().split("\n").filter(Boolean);
  assertSafeTarballInventory(entries, coordinate.name);
  const verbose = await runCommand("tar", ["-tvzf", archivePath], root, {
    timeoutMs: commandTimeout,
  });
  assertTarballEntryTypes(verbose.stdout, coordinate.name);
  const contents =
    coordinate.name === "@agent-teams/docs-protocol"
      ? (await runCommand("tar", ["-xOzf", archivePath], root, { timeoutMs: commandTimeout }))
          .stdout
      : "";
  return Object.freeze({ contents, entries, report: item });
}

export function sha256(bytes: string | Buffer) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function fetchJson(url: string | URL, fetcher = globalThis.fetch) {
  const response = await fetcher(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Public npm observation failed with HTTP ${response.status} for ${url}.`);
  }
  return (await response.json()) as unknown;
}
