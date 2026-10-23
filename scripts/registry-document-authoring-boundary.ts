import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureFailure, runCommand as untypedRunCommand } from "./pack-test-support.mjs";
import { isCanonicalPathInside, isSameCanonicalPath } from "./registry-package-paths.mjs";
interface RegistryManifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly bin?: Readonly<Record<string, string | undefined>>;
  readonly devDependencies?: Readonly<Record<string, unknown>>;
  readonly dependencies?: Readonly<Record<string, unknown>>;
  readonly exports?: Readonly<Record<string, unknown>>;
}
interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code?: number;
}
type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
  options?: { timeoutMs?: number },
) => Promise<CommandResult>;
const runCommand = untypedRunCommand as CommandRunner;

interface InstalledDocsInput {
  consumerRoot: string;
  version: string;
  docsVersion: string;
  installedDocsRoot: string;
}
const packageName = "@agent-teams/document-authoring",
  docsPackageName = "@agent-teams/docs-protocol";
const timeoutMs = 120_000;
const docsInfoArguments = [
  "info",
  "--consumer",
  ".",
  "--profile",
  "architecture/foundation/docs-protocol.yaml",
  "--json",
];
function assert(condition: unknown, message: string): asserts condition {
  const accepted = Boolean(condition);
  if (!accepted) {
    throw new Error(message);
  }
}
async function runDocsBin(consumerRoot: string, args: string[]) {
  const binRoot = join(consumerRoot, "node_modules", ".bin");
  if (process.platform === "win32") {
    return runWindowsDocsBin(consumerRoot, args);
  }
  const bin = join(binRoot, "agent-teams-docs");
  await lstat(bin);
  return runCommand(bin, args, consumerRoot, { timeoutMs });
}

export async function runWindowsDocsBin(
  consumerRoot: string,
  args: string[],
  execute = runCommand,
) {
  const docsRoot = await realpath(
    join(consumerRoot, "node_modules", "@agent-teams", "docs-protocol"),
  );
  const manifest = JSON.parse(
    await readFile(join(docsRoot, "package.json"), "utf8"),
  ) as RegistryManifest;
  assert(
    manifest.name === docsPackageName && manifest.bin?.["agent-teams-docs"] === "./dist/cli.js",
    "Installed Docs Protocol must declare its public Node CLI.",
  );
  const cli = await realpath(join(docsRoot, manifest.bin["agent-teams-docs"]));
  assert(
    isCanonicalPathInside(docsRoot, cli) && (await lstat(cli)).isFile(),
    "Installed Docs Protocol CLI escaped its package or is not a regular file.",
  );
  if (
    args.length === docsInfoArguments.length &&
    args.every((arg, index) => arg === docsInfoArguments[index])
  ) {
    // Retain actual installed-shim qualification. Only this fixed command is
    // shell syntax; the consumer root is a cwd and never enters the command.
    return execute(
      process.env.ComSpec ?? "cmd.exe",
      [
        "/d",
        "/s",
        "/c",
        ".\\node_modules\\.bin\\agent-teams-docs.cmd info --consumer . --profile architecture/foundation/docs-protocol.yaml --json",
      ],
      consumerRoot,
      { timeoutMs },
    );
  }
  return execute(process.execPath, [cli, ...args], consumerRoot, { timeoutMs });
}

export async function docsJsonCommand(consumerRoot: string, args: string[], expectedExitCode = 0) {
  const execution: CommandResult | undefined =
    expectedExitCode === 0
      ? await runDocsBin(consumerRoot, [...args, "--json"])
      : ((await captureFailure(() => runDocsBin(consumerRoot, [...args, "--json"]))) as
          | CommandResult
          | undefined);
  if (expectedExitCode !== 0) {
    assert(
      execution?.code === expectedExitCode,
      `Docs Protocol command exited with ${execution?.code ?? "no failure"}; expected ${expectedExitCode}.`,
    );
  }
  const completed = execution!;
  assert(completed.stderr === "", "Docs Protocol JSON command wrote unexpected stderr output.");
  const lines = completed.stdout.trim().split(/\r?\n/u);
  assert(lines.length === 1, "Docs Protocol command did not write exactly one JSON envelope.");
  return JSON.parse(lines.at(0)!) as unknown;
}

export async function assertInstalledBoundary(input: InstalledDocsInput) {
  const manifest = JSON.parse(
    await readFile(join(input.consumerRoot, "package.json"), "utf8"),
  ) as RegistryManifest;
  assert(
    manifest.devDependencies?.[packageName] === input.version,
    "Clean consumer must pin the exact packed Document Authoring version.",
  );
  const packageRoot = join(
    input.consumerRoot,
    "node_modules",
    "@agent-teams",
    "document-authoring",
  );
  const entry = await lstat(packageRoot);
  assert(
    entry.isDirectory() && !entry.isSymbolicLink(),
    "Document E2E resolved a workspace/link fallback instead of a registry package.",
  );
  const source = await realpath(packageRoot);
  assert(
    isCanonicalPathInside(await realpath(join(input.consumerRoot, "node_modules")), source),
    "Installed Document Authoring escaped the clean consumer node_modules tree.",
  );
  assert(
    manifest.devDependencies[docsPackageName] === input.docsVersion,
    "Clean consumer must pin the exact packed Docs Protocol version.",
  );
  const docsRoot = join(input.consumerRoot, "node_modules", "@agent-teams", "docs-protocol");
  const docsEntry = await lstat(docsRoot);
  assert(
    docsEntry.isDirectory() && !docsEntry.isSymbolicLink(),
    "Document E2E resolved a Docs Protocol workspace/link fallback instead of a registry package.",
  );
  assert(
    isCanonicalPathInside(
      await realpath(join(input.consumerRoot, "node_modules")),
      await realpath(docsRoot),
    ),
    "Installed Docs Protocol escaped the clean consumer node_modules tree.",
  );
  assert(
    isSameCanonicalPath(await realpath(input.installedDocsRoot), await realpath(docsRoot)),
    "Document E2E received a different installed Docs Protocol package root.",
  );
  const authoringManifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  ) as RegistryManifest;
  assert(
    typeof authoringManifest.exports?.["./qualification"] === "object",
    "Packed Document Authoring does not declare its closed qualification export.",
  );
  assert(
    authoringManifest.dependencies?.["@agent-teams/engineering-foundation"] === undefined,
    "Packed Document Authoring has a forbidden Foundation dependency.",
  );
  const docsManifest = JSON.parse(
    await readFile(join(docsRoot, "package.json"), "utf8"),
  ) as RegistryManifest;
  assert(
    docsManifest.dependencies?.[packageName] === input.version &&
      docsManifest.dependencies["@agent-teams/engineering-foundation"] === undefined,
    "Packed Docs Protocol does not use the new-only Document Authoring edge.",
  );
  const installedFoundationManifest = JSON.parse(
    await readFile(
      join(
        input.consumerRoot,
        "node_modules",
        "@agent-teams",
        "engineering-foundation",
        "package.json",
      ),
      "utf8",
    ),
  ) as RegistryManifest;
  assert(
    installedFoundationManifest.exports?.["./document-authoring"] === undefined &&
      installedFoundationManifest.exports?.["./document-authoring/qualification"] === undefined,
    "Packed Foundation retained a forbidden legacy authoring export.",
  );
  const { stdout: resolutionOutput } = await runCommand(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const qualification=${JSON.stringify(`${packageName}/qualification`)};const manifest=${JSON.stringify(`${packageName}/package.json`)};const api=await import(qualification);if(typeof api.runDocumentAuthoringCrashQualification!=="function")process.exit(42);process.stdout.write(JSON.stringify({manifest:import.meta.resolve(manifest),qualification:import.meta.resolve(qualification)}));`,
    ],
    docsRoot,
    { timeoutMs },
  );
  const resolved = JSON.parse(resolutionOutput) as { manifest: string; qualification: string };
  assert(
    isSameCanonicalPath(
      await realpath(fileURLToPath(resolved.manifest)),
      await realpath(join(packageRoot, "package.json")),
    ),
    "Docs Protocol resolves a different physical Document Authoring package.",
  );
  assert(
    isCanonicalPathInside(
      await realpath(packageRoot),
      await realpath(fileURLToPath(resolved.qualification)),
    ),
    "Docs Protocol qualification resolved outside the declared physical Document Authoring package.",
  );
  await runCommand(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const api=await import(${JSON.stringify(packageName)});if(typeof api.planDocumentationDocument!=="function"||typeof api.applyDocumentationPlan!=="function")process.exit(41);`,
    ],
    input.consumerRoot,
    { timeoutMs },
  );
  const oldExport = await captureFailure(() =>
    runCommand(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'await import("@agent-teams/engineering-foundation/document-authoring");',
      ],
      input.consumerRoot,
      { timeoutMs },
    ),
  );
  assert(
    (oldExport as { readonly code?: unknown } | undefined)?.code !== 0,
    "Installed resolution unexpectedly retained the old Foundation authoring export.",
  );
}
