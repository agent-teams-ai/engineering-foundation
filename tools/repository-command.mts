import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";
import { readRepositoryRuntimePolicy, repositoryRoot } from "./runtime-policy.mts";

type RuntimeProfile = "bun" | "node";
type ToolRole = "runtime" | "node-qualification" | "native-tool";

interface ToolCommand {
  readonly entry: string;
  readonly args: readonly string[];
  readonly role: ToolRole;
  readonly acceptsPaths?: true;
}

const SCRIPT_IDS = new Set([
  "standards:check", "build", "buf-qualification:e2e", "buf-qualification:e2e:built",
  "check", "verify", "check:changed", "check:fast", "dependencies:peers:check",
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
  "quality:scope:check", "architecture:features:check", "architecture:features:plan",
  "quality:coverage:scope", "package:qualification:built"
]);

const TOOL_COMMANDS: Readonly<Record<string, ToolCommand>> = Object.freeze({
  "standards:check": { entry: "scripts/check-engineering-quality-standard.mts", args: [], role: "runtime" },
  "check:changed": { entry: "packages/engineering-foundation/dist/cli.js", args: ["agent-workflow", "changed", "--consumer", "."], role: "runtime" },
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
  "dead-code:check": { entry: "node_modules/.bin/knip", args: ["--config", "knip.json", "--no-progress"], role: "native-tool" },
  "docs:terminology:check": { entry: "scripts/check-documentation-terminology.mjs", args: [], role: "runtime" },
  "nx:graph:check": { entry: "node_modules/.bin/nx", args: ["show", "projects"], role: "native-tool" },
  "test:built": { entry: "scripts/run-built-tests.mjs", args: [], role: "node-qualification" },
  "test:coverage:built": { entry: "scripts/run-test-coverage.mjs", args: [], role: "node-qualification" },
  "test:manifests:check": { entry: "scripts/check-test-manifests.mjs", args: [], role: "runtime" },
  "test:qgr:lifecycle:built": { entry: "scripts/run-selected-tests.mjs", args: ["tests/quality-gate-runner.test.mjs", "tests/quality-gate-runner-lifecycle.test.mjs", "tests/quality-gate-runner-real-pnpm-lifecycle.test.mjs", "tests/quality-gate-runner-remediation.test.mjs"], role: "node-qualification" },
  "typecheck": { entry: "node_modules/typescript/bin/tsc", args: ["--build", "tsconfig.json", "--pretty", "false"], role: "native-tool" },
  "typecheck:ci-tooling": { entry: "node_modules/typescript/bin/tsc", args: ["--project", "tsconfig.ci-tooling.json"], role: "native-tool" },
  "typecheck:restoration-lock-inputs": { entry: "node_modules/typescript/bin/tsc", args: ["--project", "tsconfig.restoration-lock-inputs-tests.json", "--skipLibCheck", "false"], role: "native-tool" },
  "typecheck:restoration-lock": { entry: "node_modules/typescript/bin/tsc", args: ["--project", "tsconfig.restoration-lock-tests.json", "--skipLibCheck", "false"], role: "native-tool" },
  "typecheck:managed-runtime-tests": { entry: "node_modules/typescript/bin/tsc", args: ["--project", "tsconfig.managed-runtime-tests.json", "--pretty", "false"], role: "native-tool" },
  "lint:fast": { entry: "node_modules/.bin/oxlint", args: ["--config", ".oxlintrc.json", "--deny-warnings", "--disable-nested-config", "."], role: "native-tool" },
  "lint:fast:files": { entry: "node_modules/.bin/oxlint", args: ["--config", ".oxlintrc.json", "--deny-warnings", "--disable-nested-config"], role: "native-tool", acceptsPaths: true },
  "lint:typed": { entry: "node_modules/.bin/oxlint", args: ["--config", ".oxlintrc.type-aware.json", "--deny-warnings", "--disable-nested-config", "."], role: "native-tool" },
  "lint:typed:files": { entry: "node_modules/.bin/oxlint", args: ["--config", ".oxlintrc.type-aware.json", "--deny-warnings", "--disable-nested-config"], role: "native-tool", acceptsPaths: true },
  "architecture:patterns": { entry: "scripts/run-ast-grep.mjs", args: ["scan", "--config", "sgconfig.yml", "--error=unused-suppression"], role: "runtime" },
  "architecture:patterns:test": { entry: "scripts/run-ast-grep.mjs", args: ["test", "--config", "sgconfig.yml", "--skip-snapshot-tests"], role: "runtime" },
  "quality:scope:check": { entry: "scripts/check-production-quality.mjs", args: [], role: "runtime" },
  "architecture:features:check": { entry: "scripts/check-feature-modules.mjs", args: [], role: "runtime" },
  "architecture:features:plan": { entry: "scripts/check-feature-modules.mjs", args: ["plan"], role: "runtime" },
  "quality:coverage:scope": { entry: "packages/engineering-foundation/dist/cli.js", args: ["quality", "check", "--consumer", ".", "--scope-only"], role: "runtime" },
  "foundation:check:built": { entry: "packages/engineering-foundation/dist/cli.js", args: ["check", "--consumer", "."], role: "runtime" },
  "runtime-observe": { entry: "tests/support/record-repository-runtime.mjs", args: [], role: "runtime" },
  "parser-spike:check": { entry: "tools/pnpm-command.mts", args: ["--filter", "@agent-teams/source-dependency-parser-spike", "run", "check"], role: "node-qualification" },
  "spike:source-parser": { entry: "tools/pnpm-command.mts", args: ["--filter", "@agent-teams/source-dependency-parser-spike", "run", "spike"], role: "node-qualification" }
});

async function isFile(path: string): Promise<boolean> {
  const metadata = await lstat(path).catch(() => null);
  return metadata?.isFile() === true;
}

async function verifyNode(path: string): Promise<string> {
  if (!isAbsolute(path) || !await isFile(path)) {
    throw new Error(`Node executable is unavailable: ${path}`);
  }
  const { spawnSync } = await import("node:child_process");
  const observation = spawnSync(path, ["-p", "JSON.stringify({execPath:process.execPath,version:process.versions.node})"], {
    encoding: "utf8",
    timeout: 10_000
  });
  if (observation.status !== 0) {
    throw new Error(`Node executable did not run: ${path}`);
  }
  const observed = JSON.parse(observation.stdout) as { readonly execPath: string; readonly version: string };
  if (
    observed.version !== "26.11.1" ||
    await realpath(observed.execPath) !== await realpath(path) ||
    !/(?:^|[\\/])node(?:\.exe)?$/u.test(observed.execPath)
  ) {
    throw new Error(`Executable is not admitted Node 26.11.1: ${path}`);
  }
  return path;
}

async function verifyBun(path: string): Promise<string> {
  if (!isAbsolute(path) || !await isFile(path)) {
    throw new Error(`Bun executable is unavailable: ${path}`);
  }
  const { spawnSync } = await import("node:child_process");
  const observation = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (observation.status !== 0 || observation.stdout.trim() !== "1.4.3") {
    throw new Error(`Executable is not admitted Bun 1.4.3: ${path}`);
  }
  return path;
}

async function firstExisting(candidates: readonly (string | undefined)[]): Promise<string> {
  for (const candidate of candidates) {
    if (candidate !== undefined && isAbsolute(candidate) && await isFile(candidate)) {
      return candidate;
    }
  }
  throw new Error("No admitted runtime executable was found.");
}

async function runtimeExecutables(): Promise<{ readonly profile: RuntimeProfile; readonly node: string; readonly bun?: string }> {
  const policy = await readRepositoryRuntimePolicy();
  const marker = process.env["AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE"];
  const profile: RuntimeProfile = marker === undefined ? policy.defaultProfile : marker === "bun" || marker === "node" ? marker : (() => { throw new Error(`Unknown runtime profile: ${marker}`); })();
  const node = await verifyNode(await firstExisting([
    process.env["AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE"],
    process.versions["bun"] === undefined ? process.execPath : undefined,
    ...((process.env["PATH"] ?? "").split(delimiter).filter(Boolean).map((path) => resolve(path, process.platform === "win32" ? "node.exe" : "node")))
  ]));
  const bun = profile === "bun" || process.env["AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE"] !== undefined
    ? await verifyBun(await firstExisting([
        process.env["AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE"],
        resolve(repositoryRoot, "node_modules/.job-scratch/toolchains/bun/bun-linux-x64/bun"),
        ...((process.env["PATH"] ?? "").split(delimiter).filter(Boolean).map((path) => resolve(path, process.platform === "win32" ? "bun.exe" : "bun")))
      ]))
    : undefined;
  return { profile, node, bun };
}

function run(command: string, args: readonly string[], cwd: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], { cwd, env: process.env, shell: false, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`Command terminated by ${signal}.`));
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
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
  return run(command ?? (() => { throw new Error("Selected manager executable is unavailable."); })(), args, process.cwd());
}

async function invokeTool(id: string, paths: readonly string[]): Promise<number> {
  const command = TOOL_COMMANDS[id];
  if (command === undefined) {
    throw new Error(`Unknown repository tool ID: ${id}`);
  }
  if (paths.length > 0 && command.acceptsPaths !== true) {
    throw new Error(`Tool ${id} does not accept file paths.`);
  }
  const runtime = await runtimeExecutables();
  const entry = resolve(repositoryRoot, command.entry);
  if (!await isFile(entry)) {
    throw new Error(`Tool entrypoint is unavailable: ${command.entry}`);
  }
  const roleCommand = command.role === "node-qualification"
    ? runtime.node
    : command.role === "runtime"
      ? runtime.profile === "bun" ? runtime.bun : runtime.node
      : /\.(?:c|m)?js$/u.test(entry) ? runtime.node : entry;
  const effectiveArgs = id === "check:fast"
    ? ["gate", "run", `${runtime.profile}-check-fast`, "--consumer", ".", "--format", "text"]
    : command.args;
  const roleArgs = command.role === "native-tool" && !/\.(?:c|m)?js$/u.test(entry)
    ? [...effectiveArgs, ...paths]
    : [entry, ...effectiveArgs, ...paths];
  return run(roleCommand ?? (() => { throw new Error("Tool runtime executable is unavailable."); })(), roleArgs, process.cwd());
}

const [operation, id, ...rest] = process.argv.slice(2);
if (operation !== "script" && operation !== "tool") {
  throw new Error("Usage: repository-command.mts (script|tool) <known-id> [--paths <path>...]");
}
if (id === undefined || rest.some((value, index) => value === "--paths" ? index !== 0 : index < 1)) {
  throw new Error("Repository command arguments are malformed.");
}
const paths = rest[0] === "--paths" ? rest.slice(1) : [];
process.exitCode = operation === "script"
  ? await invokeScript(id)
  : await invokeTool(id, paths);
