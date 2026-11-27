import { createHash } from "node:crypto";
import { assertOwnedEnvironment } from "../owned-root.ts";
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  array,
  command,
  digest,
  evidence,
  jsonEvidence,
  object,
  parse,
  requireEnvironment,
  requireEqual,
  string,
  utf8,
  type JsonRecord,
} from "../stage-a/io.ts";
import { github, invoke } from "../stage-a/publication.ts";

export const sourceRevision = "8c16e5dbf24d8a09d9f33fe7c3ee8f38bf74599c";
export const sourceCohort = "docs-2026-10-03-stable31";
export function exactDigest(value: unknown, label: string): string {
  const result = string(value, label);
  if (!/^sha256:(?!0{64}$)[0-9a-f]{64}$/u.test(result)) {
    throw new Error(`${label} is not an exact digest.`);
  }
  return result;
}
export function exactPath(value: unknown, label: string): string {
  const result = string(value, label);
  if (!isAbsolute(result) || resolve(result) !== result || result.includes("\0")) {
    throw new Error(`${label} must be a canonical absolute path.`);
  }
  return result;
}
export function bytes(path: string, maximum = 32 * 1024 * 1024): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum) {
    throw new Error(`Selected evidence is not one bounded regular file: ${path}`);
  }
  return readFileSync(path);
}
export function selectedBytes(
  value: unknown,
  label: string,
): { path: string; digest: string; bytes: Buffer } {
  const entry = object(value, label);
  const path = exactPath(entry["path"], `${label} path`);
  const selected = exactDigest(entry["sha256"], `${label} digest`);
  const content = bytes(path);
  requireEqual(digest(content), selected, label);
  return { path, digest: selected, bytes: content };
}
export function git(root: string, label: string, arguments_: readonly string[]): string {
  return utf8(command(label, "/usr/bin/git", arguments_, root).stdout).trimEnd();
}
export interface Image {
  readonly path: string;
  readonly kind: "file" | "symlink";
  readonly mode: number;
  readonly sha256: string;
}
export function image(root: string, path: string): Image {
  if (
    isAbsolute(path) ||
    path.split("/").includes("..") ||
    relative(root, resolve(root, path)).startsWith(`..${sep}`)
  ) {
    throw new Error("Repository image path escapes its root.");
  }
  const file = join(root, path),
    stat = lstatSync(file);
  const kind = stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : undefined;
  if (!kind || stat.size > 32 * 1024 * 1024) {
    throw new Error("Tracked image is not bounded.");
  }
  return {
    path,
    kind,
    mode: stat.mode & 0o777,
    sha256: digest(kind === "symlink" ? readlinkSync(file) : readFileSync(file)),
  };
}
export function inventory(root: string, label: string): readonly Image[] {
  const selected = command(`${label}-paths`, "/usr/bin/git", ["ls-files", "-z"], root).stdout;
  const paths = utf8(selected).split("\0").filter(Boolean);
  if (paths.length > 10_000 || new Set(paths).size !== paths.length) {
    throw new Error("Consumer tracked inventory is not bounded and unique.");
  }
  const result = paths.toSorted().map((path) => image(root, path));
  jsonEvidence(`${label}-inventory.json`, result);
  evidence(
    `${label}-git-status.bin`,
    command(
      `${label}-status`,
      "/usr/bin/git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      root,
    ).stdout,
  );
  return result;
}
export function equal(actual: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label} differs.`);
  }
}

function runtimeFileDigest(path: string): string {
  const descriptor = openSync(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let count: number;
    while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) !== 0) {
      hash.update(buffer.subarray(0, count));
    }
    return `sha256:${hash.digest("hex")}`;
  } finally {
    closeSync(descriptor);
  }
}

function observeControllerInstallation(
  selection: JsonRecord,
  consumer: string,
  record: JsonRecord,
) {
  const installation = realpathSync(
    exactPath(selection["controllerInstallation"], "retained controller installation"),
  );
  if (installation === consumer || installation.startsWith(`${consumer}${sep}`)) {
    throw new Error("Controller must remain outside the consumer.");
  }
  const installLockPath = join(installation, "package-lock.json");
  const installLockBytes = bytes(installLockPath);
  const installLock = parse(utf8(installLockBytes), "actual retained npm lock");
  requireEqual(installLock["lockfileVersion"], 3, "retained npm lock version");
  const installed = object(installLock["packages"], "retained installed packages");
  const packages = array(record["packages"], "qualified packages").map((value) =>
    object(value, "qualified package"),
  );
  for (const name of [
    "@agent-teams/docs-protocol-agent-teams",
    "@agent-teams/repository-mutation",
  ]) {
    const selected = packages.find((value) => value["name"] === name);
    if (!selected) {
      throw new Error("Published controller/kernel coordinate is missing.");
    }
    const locked = object(installed[`node_modules/${name}`], "retained locked package");
    requireEqual(locked["version"], selected["version"], "retained exact package version");
    requireEqual(locked["integrity"], selected["integrity"], "retained independently verified SRI");
    const resolved = new URL(string(locked["resolved"], "retained public archive"));
    requireEqual(resolved.origin, "https://registry.npmjs.org", "retained public registry");
    const manifest = parse(
      readFileSync(join(installation, "node_modules", name, "package.json"), "utf8"),
      "retained package manifest",
    );
    requireEqual(manifest["name"], name, "retained package identity");
    requireEqual(manifest["version"], selected["version"], "retained manifest version");
  }
  const controllerRoot = realpathSync(
    join(installation, "node_modules/@agent-teams/docs-protocol-agent-teams"),
  );
  const cli = realpathSync(join(controllerRoot, "dist/cli.js"));
  const controllerManifest = bytes(join(controllerRoot, "package.json"));
  const bin = object(
    parse(utf8(controllerManifest), "controller manifest")["bin"],
    "controller public bin",
  );
  requireEqual(bin["agent-teams-docs-managed"], "./dist/cli.js", "public controller CLI");
  const cliDigest = digest(bytes(cli));
  jsonEvidence("retained-controller-observation.json", {
    installation,
    controllerRoot,
    cli,
    manifestDigest: digest(controllerManifest),
    cliDigest,
    lockDigest: digest(installLockBytes),
    authenticity:
      "Actual isolated npm installation lock SRI is bound to the independently verified registry record; production preparation records complete controller/kernel build identities.",
  });
  evidence("retained-package-lock.json", installLockBytes);
  return {
    installation,
    controllerRoot,
    controllerManifest,
    cli,
    cliDigest,
    installLockPath,
    installLockBytes,
  };
}

function observePhysicalRuntimes(selection: JsonRecord, installation: string) {
  const node24 = realpathSync(exactPath(selection["node24Executable"], "physical Node24"));
  const node26 = realpathSync(exactPath(selection["node26Executable"], "physical Node26"));
  const corepack = realpathSync(
    exactPath(selection["corepackEntrypoint"], "actual Corepack entrypoint"),
  );
  requireEqual(realpathSync(process.execPath), node26, "driver executable");
  const corepackManifest = parse(
    readFileSync(join(dirname(dirname(corepack)), "package.json"), "utf8"),
    "Corepack package",
  );
  requireEqual(corepackManifest["name"], "corepack", "Corepack identity");
  requireEqual(corepackManifest["version"], "0.36.0", "observed selected Corepack");
  for (const [name, expected] of [
    ["AGENT_TEAMS_DOCS_UPGRADE_NODE24_EXECUTABLE", node24],
    ["AGENT_TEAMS_DOCS_UPGRADE_NODE26_EXECUTABLE", node26],
    ["AGENT_TEAMS_DOCS_UPGRADE_COREPACK_ENTRYPOINT", corepack],
  ] as const) {
    requireEqual(realpathSync(requireEnvironment(name)), expected, name);
  }
  assertOwnedEnvironment(process.env);
  const runtime = [];
  for (const [label, executable, expected] of [
    ["node24", node24, "24.22.3"],
    ["node26", node26, "26.12.1"],
  ] as const) {
    requireEqual(
      utf8(command(label, executable, ["-p", "process.versions.node"], installation).stdout).trim(),
      expected,
      label,
    );
    runtime.push({ label, executable, version: expected, sha256: runtimeFileDigest(executable) });
  }
  jsonEvidence("runtime-observations.json", {
    runtime,
    corepack,
    corepackDigest: digest(bytes(corepack)),
    corepackVersion: corepackManifest["version"],
    guardScope:
      "Observable controller/check processes only; no override of production scrubbed probe isolation.",
  });
  return { node24, node26, corepack };
}

export async function context(selection: JsonRecord) {
  requireEqual(process.versions.node, "26.12.1", "driver physical Node");
  requireEqual(process.platform, "linux", "driver platform");
  requireEqual(process.arch, "x64", "driver architecture");
  requireEqual(selection["schemaVersion"], 1, "driver selection schema");
  requireEqual(selection["sourceRevision"], sourceRevision, "bounded original source");
  const consumer = realpathSync(exactPath(selection["consumerRoot"], "consumer root"));
  const central = realpathSync(exactPath(selection["centralRoot"], "Central root"));
  const authorityRevision = string(selection["authorityRevision"], "qualified authority revision");
  if (!/^[0-9a-f]{40}$/u.test(authorityRevision)) {
    throw new Error("Authority revision is not exact.");
  }
  requireEqual(
    git(central, "central-head", ["rev-parse", "HEAD"]),
    authorityRevision,
    "selected authority checkout",
  );
  requireEqual(
    git(central, "central-clean", ["status", "--porcelain=v1", "--untracked-files=no"]),
    "",
    "clean authority source",
  );
  const authorityBranch = await github("repos/agent-teams-ai/.github/branches/main");
  requireEqual(authorityBranch["protected"], true, "protected authority branch");
  requireEqual(
    object(authorityBranch["commit"], "authority commit")["sha"],
    authorityRevision,
    "fresh selected authority",
  );
  jsonEvidence("authority-observation.json", authorityBranch);
  const candidate = selectedBytes(selection["candidate"], "actual candidate input");
  const candidateValue = parse(utf8(candidate.bytes), "actual candidate input");
  requireEqual(candidateValue["qualified"], false, "candidate evidence class");
  const proposed = object(candidateValue["proposedRecord"], "candidate proposed record");
  const targetCohort = string(proposed["cohort_id"], "actual target cohort");
  const registry = parse(
    readFileSync(join(central, "governance/docs-qualified-cohorts.json"), "utf8"),
    "actual registry",
  );
  const matches = array(registry["cohorts"], "actual cohort records")
    .map((value) => object(value, "record"))
    .filter((value) => value["cohort_id"] === targetCohort);
  if (matches.length !== 1) {
    throw new Error("Actual cohort record is not unique.");
  }
  const record = matches[0]!;
  requireEqual(record["candidate_digest"], candidate.digest, "registered actual candidate");
  for (const [name, value] of Object.entries(proposed)) {
    equal(record[name], value, `immutable registered ${name}`);
  }
  process.chdir(central);
  const owner = object(
    await import(pathToFileURL(join(central, "scripts/docs-cohort-policy.mjs")).href),
    "Central policy exports",
  );
  await invoke(owner, "validateDocsQualifiedCohorts", [
    registry,
    parse(
      readFileSync(join(central, "governance/docs-qualified-cohorts.schema.json"), "utf8"),
      "registry schema",
    ),
  ]);
  const projection = object(
    await invoke(owner, "qualifiedCohortProjection", [registry, targetCohort]),
    "real qualified projection",
  );
  requireEqual(projection["schemaVersion"], 3, "qualified generation");
  requireEqual(projection["lifecycleState"], "QUALIFIED", "actual qualification event");
  requireEqual(projection["canaryRepositoryIds"], ["1333298097"], "bounded real consumer");
  // Match the published authority reader's exact qualification-to-binding boundary.
  const targetBinding = Object.fromEntries(
    Object.entries(projection).filter(
      ([name]) => name !== "lifecycleState" && name !== "canaryRepositoryIds",
    ),
  );
  evidence("candidate-input.json", candidate.bytes);
  jsonEvidence("qualified-projection.json", projection);

  const controller = observeControllerInstallation(selection, consumer, record);
  const runtime = observePhysicalRuntimes(selection, controller.installation);
  const selectedLock = selectedBytes(selection["targetLock"], "selected target lock");
  evidence("selected-target-lock.yaml", selectedLock.bytes);
  return {
    consumer,
    central,
    authorityRevision,
    targetCohort,
    projection,
    targetBinding,
    ...controller,
    ...runtime,
    selectedLock,
  };
}

export type ManagedContext = Awaited<ReturnType<typeof context>>;
