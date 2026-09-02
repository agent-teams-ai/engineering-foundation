import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parse as parseYaml } from "yaml";

import { NPM_PACKAGE_BOOTSTRAP } from "./npm-package-bootstrap-catalog.mjs";
import { PUBLISHABLE_PACKAGE_CATALOG } from "./publishable-packages.mjs";

const execute = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function git(args, cwd) {
  const { stdout } = await execute("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout.trim();
}

const EXTRA_RUNTIME_SECTIONS = [
  "bundleDependencies",
  "bundledDependencies",
  "optionalDependencies",
  "peerDependencies",
];

async function readWorkspaceVersions(readManifest) {
  const entries = await Promise.all(
    PUBLISHABLE_PACKAGE_CATALOG.map(async (entry) => [
      entry.name,
      (await readManifest(entry.manifestPath)).version,
    ])
  );
  return new Map(entries);
}

/**
 * Resolves the runtime dependency map the way `pnpm pack` would publish it:
 * `workspace:*` becomes the sibling package version and `catalog:` becomes the
 * pinned workspace catalog version. Anything else is already exact.
 */
function resolvedRuntimeDependencies({ catalogVersions, manifest, workspaceVersions }) {
  const dependencies = manifest.dependencies ?? {};
  const resolved = [];
  for (const [name, specifier] of Object.entries(dependencies)) {
    const version = specifier === "workspace:*"
      ? workspaceVersions.get(name)
      : specifier === "catalog:"
        ? catalogVersions[name]
        : specifier;
    resolved.push({ name, specifier, version: version ?? null });
  }
  return resolved.toSorted((left, right) => left.name.localeCompare(right.name));
}

function dependencyProblems({ catalogVersions, manifest, profile, workspaceVersions }) {
  const problems = [];
  const extra = EXTRA_RUNTIME_SECTIONS.filter((key) => manifest[key] !== undefined);
  if (extra.length > 0) {
    problems.push(
      `${profile.name}: manifest declares ${extra.join(", ")}, which the reviewed bootstrap profile forbids.`
    );
  }
  const expected = profile.dependencies
    .map(({ name, specifier, version }) => ({ name, specifier, version }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
  const observed = resolvedRuntimeDependencies({ catalogVersions, manifest, workspaceVersions });
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    problems.push(
      `${profile.name}: runtime dependencies would pack as ${renderDependencies(observed)} but the reviewed bootstrap profile binds ${renderDependencies(expected)}.`
    );
  }
  return problems;
}

function renderDependencies(entries) {
  return entries
    .map(({ name, specifier, version }) => `${name}@${version ?? "?"} (${specifier})`)
    .join(", ") || "none";
}

/**
 * Local preflight for the reviewed npm bootstrap authority. An `approved`
 * profile pins the exact Git tree of its package directory and its exact
 * packed runtime dependency map until the `0.0.0` namespace is published, and
 * the hosted package lane refuses anything else. This check reports the same
 * refusals before a push instead of ten minutes into CI. Archive integrity
 * stays a hosted Ubuntu-writer concern because gzip bytes are platform
 * specific.
 */
export async function checkNpmBootstrapTrees({
  catalog = NPM_PACKAGE_BOOTSTRAP,
  cwd = repositoryRoot,
  readCatalogVersions = async () =>
    parseYaml(await readFile(resolve(cwd, "pnpm-workspace.yaml"), "utf8")).catalog ?? {},
  readManifest = async (path) => JSON.parse(await readFile(resolve(cwd, path), "utf8")),
  runGit = git,
} = {}) {
  const problems = [];
  const verified = [];
  let catalogVersions;
  let workspaceVersions;
  for (const profile of catalog.packages) {
    if (profile.state !== "approved" || profile.approval === null) {
      continue;
    }
    const manifest = await readManifest(profile.manifestPath);
    if (manifest.version !== profile.bootstrapVersion) {
      continue;
    }
    catalogVersions ??= await readCatalogVersions();
    workspaceVersions ??= await readWorkspaceVersions(readManifest);
    const committedTree = await runGit(["rev-parse", `HEAD:${profile.root}`], cwd);
    const dirty = await runGit(
      ["status", "--porcelain", "--untracked-files=normal", "--", profile.root],
      cwd
    );
    const before = problems.length;
    if (committedTree !== profile.approval.packageTree) {
      problems.push(
        `${profile.name}: committed tree ${committedTree} differs from the reviewed bootstrap authority ${profile.approval.packageTree}.`
      );
    }
    if (dirty.length > 0) {
      problems.push(
        `${profile.name}: uncommitted changes under ${profile.root} would leave the reviewed bootstrap authority.`
      );
    }
    problems.push(...dependencyProblems({ catalogVersions, manifest, profile, workspaceVersions }));
    if (problems.length === before) {
      verified.push(`${profile.name}@${profile.bootstrapVersion}`);
    }
  }
  return Object.freeze({ problems: Object.freeze(problems), verified: Object.freeze(verified) });
}

async function main() {
  const result = await checkNpmBootstrapTrees();
  if (result.problems.length > 0) {
    process.stderr.write(
      [
        "npm package bootstrap preflight refused:",
        ...result.problems.map((problem) => `  - ${problem}`),
        "An approved bootstrap profile freezes its package tree and packed runtime dependencies until the namespace is published.",
        "Keep the change outside that package and its pinned dependency versions, or land a new reviewed approval",
        "(packageTree plus Ubuntu-writer archive integrity) as described in docs/release.md, section \"One-time namespace bootstrap\", and ADR-0040 decision 4.",
        "",
      ].join("\n")
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Verified npm bootstrap trees: ${result.verified.join(", ") || "none pending"}.\n`
  );
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  await main();
}
