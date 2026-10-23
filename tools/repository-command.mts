import {
  SCRIPT_IDS,
  TOOL_COMMANDS,
  type ToolRole,
  type ToolCommand,
} from "./repository-tool-catalog.ts";
import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertBunRootProjection,
  readRepositoryRuntimePolicy,
  repositoryRoot,
} from "./runtime-policy.mts";
import { resolveQualificationExecutables, type RuntimeExecutables } from "./executable-policy.mts";
import { withoutGitRepositorySelectors } from "./git-environment.ts";
import { runRepositoryOxlint } from "./repository-oxlint.ts";
import {
  assertExplicitSourceGitAuthority,
  assertPnpmProfileQualificationRoot,
  assertPnpmProfileSourceIdentity,
} from "./dev.mts";

type RuntimeProfile = "bun" | "node";
async function isFile(path: string): Promise<boolean> {
  const metadata = await stat(path).catch(() => null);
  return metadata?.isFile() === true;
}

async function selectedRuntimeProfile(): Promise<RuntimeProfile> {
  const policy = await readRepositoryRuntimePolicy();
  const marker = process.env["AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE"];
  return marker === undefined
    ? policy.defaultProfile
    : marker === "bun" || marker === "node"
      ? marker
      : (() => {
          throw new Error(`Unknown runtime profile: ${marker}`);
        })();
}

async function runtimeExecutables(): Promise<{
  readonly profile: RuntimeProfile;
  readonly node: string;
  readonly bun?: string;
}> {
  return resolveQualificationExecutables(await selectedRuntimeProfile());
}

export function resolveToolInvocation(
  role: ToolRole,
  entry: string,
  args: readonly string[],
  paths: readonly string[],
  runtime: { readonly profile: RuntimeProfile; readonly node: string; readonly bun?: string },
): { readonly command: string; readonly args: readonly string[] } {
  const roleCommand =
    role === "node-qualification" || role === "node-tool"
      ? runtime.node
      : role === "runtime"
        ? runtime.profile === "bun"
          ? runtime.bun
          : runtime.node
        : entry;
  if (roleCommand === undefined) {
    throw new Error("Tool runtime executable is unavailable.");
  }
  return {
    command: roleCommand,
    args: role === "native-tool" ? [...args, ...paths] : [entry, ...args, ...paths],
  };
}

export function resolveNodeToolInvocation(
  entry: string,
  args: readonly string[],
  paths: readonly string[],
  node: string,
): { readonly command: string; readonly args: readonly string[] } {
  return resolveToolInvocation("node-tool", entry, args, paths, { profile: "node", node });
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  return new Promise((_resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env: withoutGitRepositorySelectors(environment),
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`Command terminated by ${signal}.`));
        return;
      }
      _resolve(code ?? 1);
    });
  });
}

/** Carry verified executable identities across the child-process boundary. */
function runtimeEnvironment(
  runtime: RuntimeExecutables,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: runtime.node,
    ...(runtime.bun === undefined ? {} : { AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE: runtime.bun }),
  };
}

async function invokeScript(id: string): Promise<number> {
  if (!SCRIPT_IDS.has(id)) {
    throw new Error(`Unknown repository script ID: ${id}`);
  }
  if (id === "check:changed") {
    return invokeTool(id, []);
  }
  const runtime = await runtimeExecutables();
  if (runtime.profile === "bun" && id === "package:check:built") {
    const authority = await assertExplicitSourceGitAuthority(repositoryRoot);
    return run(
      runtime.node,
      [resolve(repositoryRoot, "tools/dev.mts"), "--profile", "node", id],
      repositoryRoot,
      runtimeEnvironment(runtime, {
        ...process.env,
        AGENT_TEAMS_FOUNDATION_SOURCE_ROOT:
          process.env["AGENT_TEAMS_FOUNDATION_SOURCE_ROOT"] ?? authority.sourceRoot,
        AGENT_TEAMS_FOUNDATION_SOURCE_SHA:
          process.env["AGENT_TEAMS_FOUNDATION_SOURCE_SHA"] ?? authority.sourceCommit,
      }),
    );
  }
  const command = runtime.profile === "bun" ? runtime.bun : runtime.node;
  const args =
    runtime.profile === "bun"
      ? ["run", id]
      : [resolve(repositoryRoot, "tools/pnpm-command.mts"), "run", id];
  return run(
    command ??
      (() => {
        throw new Error("Selected manager executable is unavailable.");
      })(),
    args,
    process.cwd(),
    runtimeEnvironment(runtime),
  );
}

async function invokeSourceChanged(): Promise<number> {
  const sourceRoot = await realpath(
    process.env["AGENT_TEAMS_FOUNDATION_SOURCE_ROOT"] ?? repositoryRoot,
  );
  await assertExplicitSourceGitAuthority(sourceRoot);
  await assertBunRootProjection(sourceRoot);
  const runtime = await resolveQualificationExecutables("bun");
  const command = TOOL_COMMANDS["check:changed"];
  if (command === undefined) {
    throw new Error("Missing source-owned changed-check command.");
  }
  const entry = resolve(sourceRoot, command.entry);
  if (
    !(await isFile(entry)) ||
    !(await isFile(resolve(sourceRoot, "node_modules/typescript/bin/tsc"))) ||
    (await isFile(resolve(sourceRoot, "node_modules/.pnpm/lock.yaml")))
  ) {
    throw new Error("Source-owned check:changed requires the source Bun installation and build.");
  }
  return run(
    runtime.bun ?? runtime.node,
    [entry, ...command.args],
    sourceRoot,
    runtimeEnvironment(runtime, {
      ...withoutGitRepositorySelectors(),
      AGENT_TEAMS_FOUNDATION_SOURCE_ROOT: sourceRoot,
      AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: "bun",
    }),
  );
}

async function lintRoots(
  profile: RuntimeProfile,
): Promise<{ readonly sourceRoot: string; readonly consumerRoot: string }> {
  const consumerRoot = await realpath(process.cwd());
  const sourceRoot =
    profile === "node"
      ? await realpath(process.env["AGENT_TEAMS_FOUNDATION_SOURCE_ROOT"] ?? repositoryRoot)
      : consumerRoot;
  if (sourceRoot !== consumerRoot) {
    await assertPnpmProfileSourceIdentity(consumerRoot, sourceRoot);
  }
  return { sourceRoot, consumerRoot };
}

async function invokeLintTool(input: {
  readonly id: string;
  readonly command: ToolCommand;
  readonly paths: readonly string[];
  readonly profile: RuntimeProfile;
  readonly runtime: RuntimeExecutables;
  readonly entry: string;
}): Promise<number> {
  const { id, command, paths, profile, runtime, entry } = input;
  const { sourceRoot, consumerRoot } = await lintRoots(profile);
  return runRepositoryOxlint({
    node: runtime.node,
    entry,
    args: command.args,
    targets: id === "lint:fast" ? ["."] : paths,
    sourceRoot,
    consumerRoot,
    environment: runtimeEnvironment(runtime),
  });
}

async function invokeTool(
  id: string,
  paths: readonly string[],
  toolArguments: readonly string[] = [],
): Promise<number> {
  if (id === "check:changed") {
    if (paths.length + toolArguments.length !== 0) {
      throw new Error("Source-owned check:changed does not accept extra arguments.");
    }
    return invokeSourceChanged();
  }
  const profile = await selectedRuntimeProfile();
  const command =
    id === "dependencies:peers:check" && profile === "bun"
      ? TOOL_COMMANDS["dependencies:installed:check"]
      : TOOL_COMMANDS[id];
  if (command === undefined) {
    throw new Error(`Unknown repository tool ID: ${id}`);
  }
  if (paths.length > 0 && command.acceptsPaths !== true) {
    throw new Error(`Tool ${id} does not accept file paths.`);
  }
  const runtime =
    command.role === "node-tool" || command.role === "node-qualification"
      ? await resolveQualificationExecutables("node")
      : await resolveQualificationExecutables(profile);
  const entry = resolve(repositoryRoot, command.entry);
  if (!(await isFile(entry))) {
    throw new Error(`Tool entrypoint is unavailable: ${command.entry}`);
  }
  if (["lint:fast", "lint:fast:files", "lint:typed:files"].includes(id)) {
    return invokeLintTool({ id, command, paths, profile, runtime, entry });
  }
  if (id === "lint:typed") {
    await lintRoots(profile);
  }
  if (id === "npm-package-bootstrap:candidate-evidence") {
    const sourceRoot = process.env["AGENT_TEAMS_FOUNDATION_SOURCE_ROOT"];
    if (sourceRoot === undefined || sourceRoot === "") {
      throw new Error("Bootstrap candidate evidence requires an explicit source root.");
    }
    await assertPnpmProfileQualificationRoot(repositoryRoot, sourceRoot);
    await assertExplicitSourceGitAuthority(sourceRoot);
    const invocation = resolveToolInvocation(
      command.role,
      entry,
      [...command.args, ...toolArguments],
      paths,
      runtime,
    );
    return run(
      invocation.command,
      invocation.args,
      process.cwd(),
      runtimeEnvironment(runtime, {
        ...process.env,
        AGENT_TEAMS_FOUNDATION_SOURCE_ROOT: sourceRoot,
      }),
    );
  }
  const effectiveArgs =
    id === "check:fast"
      ? ["gate", "run", `${runtime.profile}-check-fast`, "--consumer", ".", "--format", "text"]
      : [...command.args, ...toolArguments];
  const invocation = resolveToolInvocation(command.role, entry, effectiveArgs, paths, runtime);
  const cwd =
    id === "release-owned-files:check"
      ? (
          await assertExplicitSourceGitAuthority(
            process.env["AGENT_TEAMS_FOUNDATION_SOURCE_ROOT"] ?? repositoryRoot,
          )
        ).sourceRoot
      : process.cwd();
  return run(invocation.command, invocation.args, cwd, runtimeEnvironment(runtime));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, id, ...rest] = process.argv.slice(2);
  if (operation !== "script" && operation !== "tool") {
    throw new Error("Usage: repository-command.mts (script|tool) <known-id> [--paths <path>...]");
  }
  if (
    id === undefined ||
    (id !== "npm-package-bootstrap:candidate-evidence" &&
      rest.some((value, index) => (value === "--paths" ? index !== 0 : index < 1)))
  ) {
    throw new Error("Repository command arguments are malformed.");
  }
  const paths = rest[0] === "--paths" ? rest.slice(1) : [];
  const toolArguments = id === "npm-package-bootstrap:candidate-evidence" ? rest : [];
  if (
    id === "npm-package-bootstrap:candidate-evidence" &&
    (toolArguments.length !== 2 ||
      toolArguments[0] !== "--output" ||
      !isAbsolute(toolArguments[1] ?? ""))
  ) {
    throw new Error("Bootstrap candidate evidence requires one absolute --output path.");
  }
  process.exitCode =
    operation === "script" ? await invokeScript(id) : await invokeTool(id, paths, toolArguments);
}
