import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCommand, runNpmCommand } from "./pack-test-support.mjs";
import {
  assertSafeTarballInventory,
  assertTarballEntryTypes,
  SUPPORTING_MCP_PACKAGE,
  supportingMcpCoordinate,
} from "./public-managed-registry-canary-policy.mjs";
import { verifyRegistryDocsProtocolMcp } from "./registry-docs-protocol-mcp-e2e.mjs";
import { verifiedProvenanceFromNpmAudit } from "./release-publish-ordered-runtime.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const commandTimeout = 240_000;

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function fetchJson(url, fetcher) {
  const response = await fetcher(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Public npm observation failed with HTTP ${response.status} for ${url}.`);
  }
  return await response.json();
}

export async function observeSupportingMcp(authority, fetcher = globalThis.fetch) {
  const packument = await fetchJson(
    new URL(encodeURIComponent(SUPPORTING_MCP_PACKAGE.name), authority.registry),
    fetcher,
  );
  return supportingMcpCoordinate(packument);
}

function docsProtocolCoordinate(authority) {
  const coordinate = authority.coordinates.find(({ key }) => key === "docsProtocol");
  if (coordinate === undefined) {
    throw new Error("Cohort authority is missing Docs Protocol for the supporting MCP install.");
  }
  return coordinate;
}

export function assertSupportingMcpNpmLockCoordinates(lockfileBytes, authority, coordinate) {
  const lock = JSON.parse(lockfileBytes.toString("utf8"));
  const docsCoordinate = docsProtocolCoordinate(authority);
  const expected = [docsCoordinate, coordinate];
  const rootDependencies = lock.packages?.[""]?.devDependencies;
  if (rootDependencies?.[docsCoordinate.name] !== docsCoordinate.version ||
      rootDependencies?.[coordinate.name] !== coordinate.version) {
    throw new Error("Supporting MCP install root is not bound to exact trusted versions.");
  }
  for (const item of expected) {
    const suffix = `node_modules/${item.name}`;
    const matches = Object.entries(lock.packages ?? {}).filter(([path]) =>
      path === suffix || path.endsWith(`/${suffix}`));
    if (matches.length === 0 || matches.some(([, entry]) =>
      entry.version !== item.version || entry.integrity !== item.integrity ||
      !entry.resolved?.startsWith("https://registry.npmjs.org/"))) {
      throw new Error(`Supporting MCP npm lock evidence differs for ${item.name}.`);
    }
  }
}

async function installSupportingMcp(root, authority, coordinate) {
  const docsCoordinate = docsProtocolCoordinate(authority);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, ".npmrc"), [
    `registry=${authority.registry}`,
    `@agent-teams:registry=${authority.registry}`,
    "audit=false",
    "fund=false",
    "provenance=false",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "public-managed-canary-supporting-mcp",
    private: true,
    type: "module",
    devDependencies: {
      [docsCoordinate.name]: docsCoordinate.version,
      [coordinate.name]: coordinate.version,
    },
  }, null, 2)}\n`, "utf8");
  await runNpmCommand([
    "install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=true",
    "--registry", authority.registry, "--userconfig", join(root, ".npmrc"),
  ], root, { timeoutMs: commandTimeout });
  const lockfile = await readFile(join(root, "package-lock.json"));
  const lockfileBytes = Buffer.from(lockfile);
  const lockfileDigest = sha256(lockfileBytes);
  assertSupportingMcpNpmLockCoordinates(lockfileBytes, authority, coordinate);
  const installedDocsRoot = await realpath(join(root, "node_modules", ...docsCoordinate.name.split("/")));
  const installedMcpRoot = await realpath(join(root, "node_modules", ...coordinate.name.split("/")));
  for (const [installedRoot, expected] of [
    [installedDocsRoot, docsCoordinate],
    [installedMcpRoot, coordinate],
  ]) {
    const manifest = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
    if (manifest.name !== expected.name || manifest.version !== expected.version) {
      throw new Error(`Supporting MCP install resolved unexpected identity for ${expected.name}.`);
    }
  }
  return Object.freeze({
    installedDocsRoot,
    installedMcpRoot,
    receipt: Object.freeze({
      cohortDocsProtocolLockValidated: true,
      exactPackageLockValidated: true,
      exactRegistryResolved: true,
      lockfileDigest,
      manager: "npm",
      manifestValidated: true,
      rootCount: 2,
    }),
  });
}

async function npmSignatureEvidence(root, authority) {
  const result = await runNpmCommand([
    "audit", "signatures", "--json", "--include-attestations", "--registry", authority.registry,
    "--userconfig", join(root, ".npmrc"),
  ], root, { timeoutMs: commandTimeout });
  return JSON.parse(result.stdout);
}

function assertProvenanceAncestor(provenanceCommit, expectedCommit, packageName) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", provenanceCommit, expectedCommit], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Provenance commit is not an ancestor of expected commit for ${packageName}.`);
  }
  return true;
}

async function packInventory(root, coordinate, authority) {
  const destination = join(root, "packs", coordinate.name.replaceAll("/", "-").replace("@", ""));
  await mkdir(destination, { recursive: true });
  const result = await runNpmCommand([
    "pack", `${coordinate.name}@${coordinate.version}`, "--json", "--ignore-scripts",
    "--pack-destination", destination, "--registry", authority.registry,
    "--userconfig", join(root, ".npmrc"),
  ], root, { timeoutMs: commandTimeout });
  const report = JSON.parse(result.stdout);
  const item = Array.isArray(report) ? report[0] : report;
  if (item?.name !== coordinate.name || item.version !== coordinate.version ||
      item.integrity !== coordinate.integrity) {
    throw new Error(`npm pack identity differs from authority for ${coordinate.name}.`);
  }
  const archives = (await readdir(destination)).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1) {
    throw new Error(`npm pack did not create one bounded archive for ${coordinate.name}.`);
  }
  const archivePath = join(destination, archives[0]);
  const listed = await runCommand("tar", ["-tzf", archivePath], root, { timeoutMs: commandTimeout });
  const entries = listed.stdout.trim().split("\n").filter(Boolean);
  assertSafeTarballInventory(entries, coordinate.name);
  const verbose = await runCommand("tar", ["-tvzf", archivePath], root, { timeoutMs: commandTimeout });
  assertTarballEntryTypes(verbose.stdout, coordinate.name);
  return Object.freeze({ entries, report: item });
}

export async function qualifySupportingMcp(root, authority, coordinate) {
  const install = await installSupportingMcp(root, authority, coordinate);
  const signatureEvidence = await npmSignatureEvidence(root, authority);
  const inventory = await packInventory(root, coordinate, authority);
  const provenance = verifiedProvenanceFromNpmAudit(signatureEvidence, coordinate, authority.source);
  const packageEvidence = Object.freeze({
    integrity: coordinate.integrity,
    latest: coordinate.version,
    name: coordinate.name,
    provenanceAncestorOfExpectedCommit: assertProvenanceAncestor(
      provenance.commit,
      authority.expectedCommit,
      coordinate.name,
    ),
    provenanceCommit: provenance.commit,
    signatureVerified: true,
    tarballEntries: inventory.entries.length,
    version: coordinate.version,
  });
  await verifyRegistryDocsProtocolMcp({
    consumerRoot: join(root, "read-only-qualification"),
    installedDocsRoot: install.installedDocsRoot,
    installedMcpRoot: install.installedMcpRoot,
    mcpVersion: coordinate.version,
  });
  return Object.freeze({
    install: install.receipt,
    mcp: Object.freeze({
      cleanShutdown: true,
      consumerTreeUnchanged: true,
      readOnlyToolNames: Object.freeze(["docs_info", "docs_find", "docs_context"]),
      readOnlyToolsValidated: true,
      serverName: coordinate.name,
      serverVersion: coordinate.version,
      startupValidated: true,
    }),
    package: packageEvidence,
    status: "passed",
  });
}
