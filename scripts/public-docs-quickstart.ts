import assert from "node:assert/strict";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import { applyReachability, fileSnapshot, readContainedBoundedFile } from "../packages/docs-protocol/dist/qualification/index.js";
import { runCommand } from "./pack-test-support.mjs";
import { parseStableVersion } from "./release-publish-registry-version.mjs";

export interface PublicDocsCoordinate {
  readonly name: string;
  readonly version: string;
}

export interface DocumentedQuickstart {
  readonly coordinates: readonly PublicDocsCoordinate[];
  readonly commands: readonly (readonly string[])[];
}

const CLI = "@agent-teams/docs-protocol";
const MCP = "@agent-teams/docs-protocol-mcp";
const REGISTRY = "https://registry.npmjs.org/";
const DIGEST_PLACEHOLDER = "sha256:PLAN_DIGEST_FROM_DRY_RUN";

function coordinate(source: string, name: string): PublicDocsCoordinate {
  const candidates = [...source.matchAll(/@agent-teams\/docs-protocol(?:-mcp)?@([^\s\x60\\]+)/gu)]
    .filter(([value]) => value.startsWith(name + "@"))
    .map(([, version]) => version);
  const versions = [...new Set(candidates)];
  const version = versions[0];
  if (versions.length !== 1 || parseStableVersion(version) === undefined) {
    throw new Error("Quickstart requires one literal stable coordinate for " + name + ".");
  }
  return Object.freeze({ name, version: version as string });
}

function registryFlags(manager: string): readonly string[] {
  const prefix = manager === "npm" ? "--" : "--config.";
  return [prefix + "registry=" + REGISTRY, prefix + "@agent-teams:registry=" + REGISTRY];
}

function expectedCommands(cli: string, mcp: string): readonly (readonly string[])[] {
  const view = (manager: string, value: string) =>
    [manager, "view", value, "version", "--json", ...registryFlags(manager)];
  const install = (manager: string, values: readonly string[]) =>
    [manager, manager === "npm" ? "install" : "add", "--save-dev", "--save-exact",
      ...registryFlags(manager), ...values];
  const init = ["docs-protocol", "init", "--project-id", "example/widgets",
    "--owner", "documentation/team"];
  const author = ["docs-protocol", "new", "--type", "adr", "--id", "ADR-0083",
    "--title", "Tenant isolation", "--owner", "documentation/team",
    "--summary", "Defines the tenant-isolation boundary."];
  return [
    view("npm", cli), view("pnpm", cli), install("npm", [cli]), install("pnpm", [cli]),
    [...init, "--dry-run"], [...init, "--apply", "--expect", DIGEST_PLACEHOLDER],
    ["docs-protocol", "find", "tenant isolation", "--fuzzy"],
    ["docs-protocol", "context", "tenant isolation", "--fuzzy", "--max-documents", "12"],
    [...author, "--dry-run"], [...author, "--apply", "--expect", DIGEST_PLACEHOLDER],
    ["docs-protocol", "check"], view("npm", mcp), view("pnpm", mcp),
    install("npm", [cli, mcp]), install("pnpm", [cli, mcp]),
    ["docs-protocol-mcp", "--consumer-root", "/absolute/path/to/repository"],
  ];
}

// The maintained walkthrough has sixteen known commands, not a shell language.
function argumentsFromFence(source: string): readonly string[] {
  const line = source.replace(/\\\r?\n[ \t]*/gu, " ").trim();
  const tokens = line.match(/"[^"\r\n]*"|[^\s"]+/gu) ?? [];
  if (tokens.join(" ") !== line.replace(/[ \t]+/gu, " ")) {
    throw new Error("Quickstart fence contains an unsupported command form.");
  }
  return Object.freeze(tokens.map((token) =>
    token.startsWith('"') ? token.slice(1, -1) : token));
}

export function parseDocumentedQuickstart(source: string): DocumentedQuickstart {
  if (Buffer.byteLength(source) > 128 * 1024) {
    throw new Error("Quickstart exceeds its maintained-document size bound.");
  }
  const coordinates = [coordinate(source, CLI), coordinate(source, MCP)];
  const commands = [...source.matchAll(/\x60{3}bash\r?\n([\s\S]*?)\r?\n\x60{3}/gu)]
    .map(([, fence]) => argumentsFromFence(fence ?? ""));
  const expected = expectedCommands(
    CLI + "@" + coordinates[0]!.version, MCP + "@" + coordinates[1]!.version,
  );
  if (JSON.stringify(commands) !== JSON.stringify(expected)) {
    throw new Error("Quickstart commands differ from the closed documented workflow.");
  }
  return Object.freeze({
    coordinates: Object.freeze(coordinates),
    commands: Object.freeze(commands),
  });
}

export async function readDocumentedQuickstart(): Promise<DocumentedQuickstart> {
  return parseDocumentedQuickstart(await readFile(
    new URL("../docs/reference/open-source-docs-protocol.md", import.meta.url), "utf8",
  ));
}

export function documentedInstallCommands(
  quickstart: DocumentedQuickstart,
  manager: string,
  pair: boolean,
): readonly (readonly string[])[] {
  assert.ok(manager === "npm" || manager === "pnpm", "Unknown quickstart manager.");
  const views = quickstart.commands.filter((command) =>
    command[0] === manager && command[1] === "view" &&
    (pair || command[2]?.startsWith(CLI + "@")));
  const installations = quickstart.commands.filter((command) =>
    command[0] === manager && (command[1] === "install" || command[1] === "add") &&
    command.filter((argument) => argument.startsWith("@agent-teams/")).length === (pair ? 2 : 1));
  assert.equal(views.length, pair ? 2 : 1);
  assert.equal(installations.length, 1);
  return Object.freeze([...views, installations[0]!]);
}

export async function installedDocumentedBinary(
  root: string,
  installedDocsRoot: string,
  manager = "npm",
): Promise<string> {
  assert.ok(manager === "npm" || manager === "pnpm");
  const physicalRoot = await realpath(root);
  const bin = join(physicalRoot, "node_modules", ".bin", "docs-protocol");
  const manifest = JSON.parse(await readFile(join(installedDocsRoot, "package.json"), "utf8")) as {
    readonly name?: unknown;
    readonly bin?: Readonly<Record<string, unknown>>;
  };
  assert.equal(manifest.name, CLI);
  const target = manifest.bin?.["docs-protocol"];
  assert.ok(target === "dist/cli.js" || target === "./dist/cli.js");
  const physicalTarget = await realpath(join(installedDocsRoot, target));
  const metadata = await lstat(bin);
  if (metadata.isSymbolicLink()) {
    assert.equal(await realpath(bin), physicalTarget);
  } else {
    assert.equal(manager, "pnpm", "Only the pinned pnpm profile owns a regular POSIX bin shim.");
    assert.ok(metadata.isFile() && (metadata.mode & 0o111) !== 0);
    await assertPnpmShimTarget(physicalRoot, bin, physicalTarget);
  }
  return bin;
}

async function assertPnpmShimTarget(root: string, bin: string, target: string): Promise<void> {
  const { bytes } = await readContainedBoundedFile(root, "node_modules/.bin/docs-protocol", "Installed pnpm bin shim", 16 * 1024);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assert.ok(source.startsWith("#!/bin/sh\n"));
  const markers = source.split("\n").filter((line) => line.startsWith("# cmd-shim-target="));
  assert.equal(markers.length, 1);
  assert.equal(await realpath(markers[0]!.slice("# cmd-shim-target=".length)), target);
  const path = relative(dirname(bin), target).split(sep).join("/");
  const argument = '"$basedir/' + path + '" "$@"';
  const windowsArgument = '"$basedir_win/' + path + '" "$@"';
  // Bind all exec slots of the pinned manager's generated shim, then execute
  // that installed entry itself. This does not interpret a shell program.
  assert.deepEqual(source.split("\n").filter((line) => /^\s*exec\b/u.test(line)), [
    '  exec "$basedir/node.exe"  ' + windowsArgument,
    '  exec "$basedir/node"  ' + argument,
    "  exec node  " + argument,
    "  exec node.exe  " + windowsArgument,
    "  exec node  " + argument,
  ]);
}

export function reviewedApplyArguments(
  command: readonly string[],
  digest: string,
): readonly string[] {
  assert.match(digest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(command.filter((argument) => argument === DIGEST_PLACEHOLDER).length, 1);
  return Object.freeze(command.map((argument) =>
    argument === DIGEST_PLACEHOLDER ? digest : argument));
}

export function previewPlanDigest(output: string): string {
  const plans = [...output.matchAll(/^Plan: (sha256:[0-9a-f]{64})$/gmu)];
  assert.equal(plans.length, 1, "Preview must print exactly one complete Plan digest.");
  return plans[0]![1]!;
}

export interface DocumentedWorkflowEvidence {
  readonly binary: string;
  readonly completedCommands: number;
  readonly rejectedStalePlans: number;
  readonly manualReachability: boolean;
}

async function rejectStalePlan(
  binary: string,
  command: readonly string[],
  root: string,
  actualDigest: string,
): Promise<void> {
  const staleDigest = "sha256:" + (actualDigest.endsWith("0") ? "1" : "0").repeat(64);
  const before = await fileSnapshot(root);
  await assert.rejects(
    runCommand(binary, reviewedApplyArguments(command, staleDigest).slice(1), root),
    (error: unknown) => {
      assert.ok(error instanceof Error && error.name === "CommandExecutionError");
      const failure = error as Error & Readonly<Record<string, unknown>>;
      assert.ok(typeof failure["code"] === "number" && failure["code"] !== 0);
      assert.equal(failure["signal"], null);
      assert.equal(failure["timedOut"], false);
      assert.equal(failure["terminationConfirmed"], true);
      const output = String(failure["stdout"]) + "\n" + String(failure["stderr"]);
      assert.match(output, /(?:plan-digest-stale|authority-stale|[Dd]igest.*(?:differ|stale|match))/u);
      return true;
    },
  );
  assert.deepEqual(await fileSnapshot(root), before, "Stale apply must preserve consumer bytes.");
}

export async function runDocumentedQuickstart(input: {
  readonly quickstart: DocumentedQuickstart;
  readonly root: string;
  readonly installedDocsRoot: string;
  readonly manager: string;
}): Promise<DocumentedWorkflowEvidence> {
  assert.notEqual(process.platform, "win32", "This walkthrough qualifies POSIX bootstrap apply.");
  const { quickstart, root, installedDocsRoot, manager } = input;
  const binary = await installedDocumentedBinary(root, installedDocsRoot, manager);
  let digest: string | undefined;
  let completedCommands = 0;
  let rejectedStalePlans = 0;
  let manualReachability = false;
  for (const documented of quickstart.commands.filter((command) => command[0] === "docs-protocol")) {
    let command = documented;
    const preview = command.includes("--dry-run");
    const before = preview ? await fileSnapshot(root) : undefined;
    if (command.includes("--apply")) {
      assert.ok(digest !== undefined, "Apply requires its immediately preceding preview digest.");
      await rejectStalePlan(binary, command, root, digest);
      rejectedStalePlans += 1;
      command = reviewedApplyArguments(command, digest);
      digest = undefined;
    }
    const { stdout } = await runCommand(binary, command.slice(1), root);
    completedCommands += 1;
    if (preview) {
      assert.deepEqual(await fileSnapshot(root), before, "Preview must preserve consumer bytes.");
      digest = previewPlanDigest(stdout);
    }
    if (command[1] === "new" && command.includes("--apply")) {
      const actions = [...stdout.matchAll(/^Next: add (.+) to (.+)$/gmu)];
      assert.equal(actions.length, 1, "New apply must print one manual index instruction.");
      await applyReachability(root, {
        state: "manual-required", markdownLink: actions[0]![1], indexPath: actions[0]![2],
      });
      manualReachability = true;
    }
  }
  assert.equal(completedCommands, 7);
  assert.equal(rejectedStalePlans, 2);
  assert.equal(manualReachability, true);
  return Object.freeze({ binary, completedCommands, rejectedStalePlans, manualReachability });
}
