import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readRepositoryRuntimePolicy, repositoryRoot } from "./runtime-policy.mts";
import { resolveQualificationExecutables, type RuntimeExecutables } from "./executable-policy.mts";
import {
  assertExplicitSourceGitAuthority,
  assertPnpmProfileQualificationRoot
} from "./dev.mts";

type RuntimeProfile = "bun" | "node";
type ToolRole = "runtime" | "node-qualification" | "node-tool" | "native-tool";

interface ToolCommand {
  readonly entry: string;
  readonly args: readonly string[];
  readonly role: ToolRole;
  readonly acceptsPaths?: true;
}

const SCRIPT_IDS = new Set([
  "standards:check", "build", "buf-qualification:e2e", "buf-qualification:e2e:built",
  "check", "verify", "check:changed", "check:fast", "dependencies:peers:check",
  "dependencies:installed:check",
  "ci:full", "ci:merge", "changeset", "changeset:coverage", "clean",
  "foundation:bootstrap", "foundation:dogfood", "foundation:qualification",
  "foundation:check", "foundation:check:built", "lint", "lint:fast", "lint:fast:files",
  "lint:typed", "lint:typed:files", "quality:gate:fast", "architecture:patterns",
  "architecture:patterns:test", "dead-code:check", "docs:terminology:check",
  "nx:graph:check", "node-compatibility:qualification",
  "npm-package-bootstrap:candidate-evidence", "published-compatibility:e2e",
  "public-docs-release:e2e", "public-managed-registry-canary", "check:affected",
  "package:check", "package:check:built", "package:group:built", "parser-spike:check",
  "registry-install-e2e", "registry-install-e2e:built", "release:publish",
  "release-owned-files:check", "release-graph:check", "security:workflows",
  "release:version", "spike:source-parser", "test", "test:built", "test:coverage",
  "test:coverage:built", "test:coverage:evidence:built", "test:manifests:check",
  "test:performance:built", "test:qgr:lifecycle:built", "test:shard:built",
  "typecheck", "typecheck:ci-tooling", "typecheck:restoration-lock-inputs",
  "typecheck:restoration-lock", "typecheck:managed-runtime-tests",
  "typecheck:local-mode-oracles", "typecheck:native-api-tests", "typecheck:native-release-tooling",
  "typecheck:agent-workflow",
  "quality:scope:check", "architecture:features:check", "architecture:features:plan",
  "quality:coverage:scope", "package:qualification:built"
]);

const TOOL_COMMANDS: Readonly<Record<string, ToolCommand>> = Object.freeze({
  "standards:check": { entry: "scripts/check-engineering-quality-standard.mts", args: [], role: "runtime" },
  "check:changed": { entry: "packages/engineering-foundation/dist/cli.js", args: ["agent-workflow", "check-changed", "--consumer", "."], role: "runtime" },
  "check:fast": { entry: "packages/engineering-foundation/dist/cli.js", args: ["gate", "run", "bun-check-fast", "--consumer", ".", "--format", "text"], role: "runtime" },
  "dependencies:peers:check": { entry: "tools/pnpm-command.mts", args: ["peers", "check", "--lockfile-only"], role: "node-qualification" },
  "dependencies:installed:check": { entry: "tools/dependencies-installed-check.mts", args: [], role: "runtime" },
  "bun-projection:check": { entry: "tools/check-bun-projection.mts", args: [], role: "runtime" },
  "security:workflows": { entry: "scripts/security-toolchain.mjs", args: [], role: "runtime" },
  "buf-qualification:e2e:built": { entry: "scripts/buf-qualification-e2e.mjs", args: [], role: "node-qualification" },
  "published-compatibility:e2e": { entry: "scripts/published-compatibility-e2e.mjs", args: [], role: "node-qualification" },
  "public-docs-release:e2e": { entry: "scripts/public-docs-release-e2e.mjs", args: [], role: "node-qualification" },
  "registry-install-e2e:built": { entry: "scripts/registry-install-e2e.mjs", args: [], role: "node-qualification" },
  "package:qualification:built": { entry: "scripts/qualify-package-artifacts.mts", args: [], role: "node-qualification" },
  "release-owned-files:check": { entry: "scripts/check-release-owned-files.mjs", args: [], role: "runtime" },
  "release-graph:check": { entry: "scripts/check-release-graph-projections.mjs", args: [], role: "runtime" },
  "dead-code:check": { entry: "node_modules/knip/bin/knip.js", args: ["--config", "knip.json", "--no-progress"], role: "node-tool" },
  "docs:terminology:check": { entry: "scripts/check-documentation-terminology.mjs", args: [], role: "runtime" },
  "nx:graph:check": { entry: "node_modules/nx/dist/bin/nx.js", args: ["show", "projects"], role: "node-tool" },
  "npm-package-bootstrap:candidate-evidence": {
    entry: "scripts/npm-package-bootstrap-candidate-evidence.mjs",
    args: [],
    role: "node-qualification"
  },
  "test:built": { entry: "scripts/run-built-tests.mjs", args: [], role: "node-qualification" },
  "test:coverage:built": { entry: "scripts/run-test-coverage.mjs", args: [], role: "node-qualification" },
  "test:manifests:check": { entry: "scripts/check-test-manifests.mjs", args: [], role: "runtime" },
  "test:qgr:lifecycle:built": { entry: "scripts/run-selected-tests.mjs", args: ["tests/quality-gate-runner.test.mjs", "tests/quality-gate-runner-lifecycle.test.mjs", "tests/quality-gate-runner-real-pnpm-lifecycle.test.mjs", "tests/quality-gate-runner-remediation.test.mjs"], role: "node-qualification" },
  "typecheck": { entry: "node_modules/typescript/bin/tsc", args: ["--build", "tsconfig.json", "--pretty", "false"], role: "node-tool" },
  "typecheck:ci-tooling": { entry: "node_modules/typescript/bin/tsc", args: ["--project", "tsconfig.ci-tooling.json"], role: "node-tool" },
  "typecheck:restoration-lock-inputs": { entry: "node_modules/typescript/bin/tsc", args: ["--project", "tsconfig.restoration-lock-inputs-tests.json", "--skipLibCheck", "false"], role: "node-tool" },
  "typecheck:restoration-lock": { entry: "node_modules/typescript/bin/tsc", args: ["--project", "tsconfig.restoration-lock-tests.json", "--skipLibCheck", "false"], role: "node-tool" },
  "typecheck:managed-runtime-tests": { entry: "node_modules/typescript/bin/tsc", args: ["--project", "tsconfig.managed-runtime-tests.json", "--pretty", "false"], role: "node-tool" },
  "typecheck:local-mode-oracles": { entry: "node_modules/typescript/bin/tsc", args: ["--project", "tsconfig.local-mode-oracles.json"], role: "node-tool" },
  "typecheck:native-api-tests": { entry: "node_modules/typescript/bin/tsc", args: ["--project", "tsconfig.native-api-tests.json"], role: "node-tool" },
  "typecheck:native-release-tooling": { entry: "node_modules/typescript/bin/tsc", args: ["--project", "tsconfig.native-release-tooling.json"], role: "node-tool" },
  "typecheck:agent-workflow": { entry: "node_modules/typescript/bin/tsc", args: ["--project", "tsconfig.agent-workflow-tests.json", "--pretty", "false"], role: "node-tool" },
  "lint:fast": { entry: "node_modules/oxlint/bin/oxlint", args: ["--config", ".oxlintrc.json", "--deny-warnings", "--disable-nested-config", "."], role: "node-tool" },
  "lint:fast:files": { entry: "node_modules/oxlint/bin/oxlint", args: ["--config", ".oxlintrc.json", "--deny-warnings", "--disable-nested-config"], role: "node-tool", acceptsPaths: true },
  "lint:typed": { entry: "packages/engineering-foundation/dist/cli.js", args: ["quality", "check", "--consumer", "."], role: "runtime" },
  "lint:typed:files": { entry: "node_modules/oxlint/bin/oxlint", args: ["--config", ".oxlintrc.type-aware.json", "--deny-warnings", "--disable-nested-config"], role: "node-tool", acceptsPaths: true },
  "architecture:patterns": { entry: "scripts/run-ast-grep.mjs", args: ["scan", "--config", "sgconfig.yml", "--error=unused-suppression"], role: "runtime" },
  "architecture:patterns:test": { entry: "scripts/run-ast-grep.mjs", args: ["test", "--config", "sgconfig.yml", "--skip-snapshot-tests"], role: "runtime" },
  "quality:scope:check": { entry: "scripts/check-production-quality.mjs", args: [], role: "runtime" },
  "architecture:features:check": { entry: "scripts/check-feature-modules.mjs", args: [], role: "node-qualification" },
  "architecture:features:plan": { entry: "scripts/check-feature-modules.mjs", args: ["plan"], role: "runtime" },
  "quality:coverage:scope": { entry: "packages/engineering-foundation/dist/cli.js", args: ["quality", "check", "--consumer", ".", "--scope-only"], role: "runtime" },
  "foundation:check:built": { entry: "scripts/public-api-native-migration-cli.ts", args: ["qualify"], role: "node-qualification" },
  "release:version:apply": { entry: "scripts/public-api-native-migration-cli.ts", args: ["apply-version"], role: "node-qualification" },
  "runtime-observe": { entry: "tests/support/record-repository-runtime.mts", args: [], role: "runtime" },
  "parser-spike:typecheck": { entry: "node_modules/typescript/bin/tsc", args: ["--project", "spikes/source-dependency-parser/tsconfig.json", "--noEmit"], role: "node-tool" },
  "parser-spike:check": { entry: "spikes/source-dependency-parser/run.ts", args: ["--verify-only"], role: "node-qualification" },
  "spike:source-parser": { entry: "spikes/source-dependency-parser/run.ts", args: [], role: "node-qualification" }
});

async function isFile(path: string): Promise<boolean> {
  const metadata = await stat(path).catch(() => null);
  return metadata?.isFile() === true;
}

async function selectedRuntimeProfile(): Promise<RuntimeProfile> {
  const policy = await readRepositoryRuntimePolicy();
  const marker = process.env["AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE"];
  return marker === undefined ? policy.defaultProfile : marker === "bun" || marker === "node" ? marker : (() => { throw new Error(`Unknown runtime profile: ${marker}`); })();
}

async function runtimeExecutables(): Promise<{ readonly profile: RuntimeProfile; readonly node: string; readonly bun?: string }> {
  return resolveQualificationExecutables(await selectedRuntimeProfile());
}

export function resolveToolInvocation(
  role: ToolRole,
  entry: string,
  args: readonly string[],
  paths: readonly string[],
  runtime: { readonly profile: RuntimeProfile; readonly node: string; readonly bun?: string }
): { readonly command: string; readonly args: readonly string[] } {
  const roleCommand = role === "node-qualification" || role === "node-tool"
    ? runtime.node
    : role === "runtime"
      ? runtime.profile === "bun" ? runtime.bun : runtime.node
      : entry;
  if (roleCommand === undefined) {
    throw new Error("Tool runtime executable is unavailable.");
  }
  return {
    command: roleCommand,
    args: role === "native-tool" ? [...args, ...paths] : [entry, ...args, ...paths]
  };
}

export function resolveNodeToolInvocation(
  entry: string,
  args: readonly string[],
  paths: readonly string[],
  node: string
): { readonly command: string; readonly args: readonly string[] } {
  return resolveToolInvocation("node-tool", entry, args, paths, { profile: "node", node });
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env
): Promise<number> {
  return new Promise((_resolve, reject) => {
    const child = spawn(command, [...args], { cwd, env: environment, shell: false, stdio: "inherit" });
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
  environment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...environment,
    AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: runtime.node,
    ...(runtime.bun === undefined ? {} : { AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE: runtime.bun })
  };
}

async function invokeScript(id: string): Promise<number> {
  if (!SCRIPT_IDS.has(id)) {
    throw new Error(`Unknown repository script ID: ${id}`);
  }
  const runtime = await runtimeExecutables();
  const command = runtime.profile === "bun" ? runtime.bun : runtime.node;
  const args = runtime.profile === "bun"
    ? ["run", id]
    : [resolve(repositoryRoot, "tools/pnpm-command.mts"), "run", id];
  return run(command ?? (() => { throw new Error("Selected manager executable is unavailable."); })(), args, process.cwd(), runtimeEnvironment(runtime));
}

async function invokeTool(
  id: string,
  paths: readonly string[],
  toolArguments: readonly string[] = []
): Promise<number> {
  const profile = await selectedRuntimeProfile();
  const command = id === "dependencies:peers:check" && profile === "bun"
    ? TOOL_COMMANDS["dependencies:installed:check"]
    : TOOL_COMMANDS[id];
  if (command === undefined) {
    throw new Error(`Unknown repository tool ID: ${id}`);
  }
  if (paths.length > 0 && command.acceptsPaths !== true) {
    throw new Error(`Tool ${id} does not accept file paths.`);
  }
  const runtime = command.role === "node-tool" || command.role === "node-qualification"
    ? await resolveQualificationExecutables("node")
    : await resolveQualificationExecutables(profile);
  const entry = resolve(repositoryRoot, command.entry);
  if (!await isFile(entry)) {
    throw new Error(`Tool entrypoint is unavailable: ${command.entry}`);
  }
  if (id === "npm-package-bootstrap:candidate-evidence") {
    const sourceRoot = process.env["AGENT_TEAMS_FOUNDATION_SOURCE_ROOT"];
    if (sourceRoot === undefined || sourceRoot === "") {
      throw new Error("Bootstrap candidate evidence requires an explicit source root.");
    }
    await assertPnpmProfileQualificationRoot(repositoryRoot, sourceRoot);
    const sourceAuthority = await assertExplicitSourceGitAuthority(sourceRoot);
    const invocation = resolveToolInvocation(
      command.role,
      entry,
      [...command.args, ...toolArguments],
      paths,
      runtime
    );
    return run(invocation.command, invocation.args, process.cwd(), runtimeEnvironment(runtime, {
      ...process.env,
      ...sourceAuthority.environment,
      AGENT_TEAMS_FOUNDATION_SOURCE_ROOT: sourceRoot
    }));
  }
  const effectiveArgs = id === "check:fast"
    ? ["gate", "run", `${runtime.profile}-check-fast`, "--consumer", ".", "--format", "text"]
    : [...command.args, ...toolArguments];
  const invocation = resolveToolInvocation(command.role, entry, effectiveArgs, paths, runtime);
  return run(invocation.command, invocation.args, process.cwd(), runtimeEnvironment(runtime));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, id, ...rest] = process.argv.slice(2);
  if (operation !== "script" && operation !== "tool") {
    throw new Error("Usage: repository-command.mts (script|tool) <known-id> [--paths <path>...]");
  }
  if (id === undefined || (id !== "npm-package-bootstrap:candidate-evidence" &&
    rest.some((value, index) => value === "--paths" ? index !== 0 : index < 1))) {
    throw new Error("Repository command arguments are malformed.");
  }
  const paths = rest[0] === "--paths" ? rest.slice(1) : [];
  const toolArguments = id === "npm-package-bootstrap:candidate-evidence" ? rest : [];
  if (id === "npm-package-bootstrap:candidate-evidence" &&
    (toolArguments.length !== 2 || toolArguments[0] !== "--output" ||
      !isAbsolute(toolArguments[1] ?? ""))) {
    throw new Error("Bootstrap candidate evidence requires one absolute --output path.");
  }
  process.exitCode = operation === "script"
    ? await invokeScript(id)
    : await invokeTool(id, paths, toolArguments);
}
