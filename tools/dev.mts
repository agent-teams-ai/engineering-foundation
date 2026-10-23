import { projectProducerSourceDependencies } from "./producer-source-dependencies.ts";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBunRootProjection, readRepositoryRuntimePolicy, repositoryRoot, projectNodeAgentWorkflowPolicy, assertNodeAgentWorkflowPolicyProjection, projectNodeDependencyDeclarationsPolicy, assertNodeDependencyDeclarationsPolicyProjection } from "./runtime-policy.mts";
import { resolveQualificationExecutables, verifySupportedNode } from "./executable-policy.mts";
import { assertOwnedProfileRoot, assertExplicitSourceGitAuthority } from "./profile-root.mts";
import { withoutGitRepositorySelectors } from "./git-environment.ts";
import { copySourceTree, sourceTreeDigest } from "./profile-source.ts";
export { copySourceTree, sourceTreeDigest } from "./profile-source.ts";
export { assertExplicitSourceGitAuthority } from "./profile-root.mts";

type Profile = "bun" | "node";

export interface ProfileEvidence {
  readonly profile: Profile;
  readonly sourceSha: string;
  readonly sourceDigest: string;
  readonly originalManifestSha256: string;
  readonly derivedManifestSha256: string;
  readonly originalWorkflowPolicySha256: string;
  readonly derivedWorkflowPolicySha256: string;
  readonly originalDependencyDeclarationsPolicySha256: string;
  readonly derivedDependencyDeclarationsPolicySha256: string;
}

function parseArguments(arguments_: readonly string[]): { readonly profile: Profile; readonly command: string } {
  let profile: Profile = "bun";
  const rest = [...arguments_];
  while (rest[0] === "--profile") {
    const selected = rest[1];
    if (selected !== "bun" && selected !== "node") {
      throw new Error("--profile must be bun or node.");
    }
    profile = selected;
    rest.splice(0, 2);
  }
  if (rest.length !== 1 || !["install", "build", "check", "verify", "check:changed", "check:fast", "security:workflows", "test:qgr:lifecycle:built", "package:check:built"].includes(rest[0] ?? "")) {
    throw new Error("Usage: dev.mts [--profile bun|node] (install|build|check|verify|check:changed|check:fast|security:workflows|test:qgr:lifecycle:built|package:check:built)");
  }
  if ((rest[0] === "check" || rest[0] === "verify") && profile !== "node") {
    throw new Error("Full repository diagnostics require the explicit --profile node projection.");
  }
  if (rest[0] === "package:check:built" && profile !== "node") {
    throw new Error("Package qualification requires the explicit --profile node projection.");
  }
  return { profile, command: rest[0] ?? "" };
}

function run(command: string, args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv = process.env): Promise<number> {
  return new Promise((_resolve, reject) => {
    const child = spawn(command, [...args], { cwd, env: withoutGitRepositorySelectors(environment), shell: false, stdio: "inherit" });
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

async function executable(profile: Profile): Promise<{ readonly node: string; readonly bun?: string; readonly manager: string }> {
  const policy = await readRepositoryRuntimePolicy();
  const runtime = await resolveQualificationExecutables(profile);
  const node = runtime.node;
  const bun = runtime.bun;
  const manager = profile === "bun"
    ? bun ?? (() => { throw new Error("Bun executable is unavailable."); })()
    : resolve(repositoryRoot, "tools/pnpm-command.mts");
  if (policy.defaultProfile !== "bun") {
    throw new Error("Runtime policy default profile drifted.");
  }
  return { node, ...(profile === "bun" ? { bun } : {}), manager };
}

async function freshProfileRoot(profile: Profile): Promise<string> {
  const requested = process.env["AGENT_TEAMS_FOUNDATION_PROFILE_ROOT"];
  if (profile === "bun" && requested === undefined) {
    const installed = resolve(repositoryRoot, "node_modules");
    const entries: string[] = await readdir(installed).catch((): string[] => []);
    if (entries.includes(".pnpm")) {
      throw new Error("The repository has a pnpm installation; use a profile-owned TEST root.");
    }
    return repositoryRoot;
  }
  const sourceSha = process.env["AGENT_TEAMS_FOUNDATION_SOURCE_SHA"] ??
    (await assertExplicitSourceGitAuthority(repositoryRoot)).sourceCommit;
  const sourceDigest = await sourceTreeDigest();
  const profiles = resolve(repositoryRoot, ".worker-tmp/profiles");
  await mkdir(profiles, { recursive: true });
  const target = await assertOwnedProfileRoot(
    requested ?? resolve(repositoryRoot, `.worker-tmp/profiles/${profile}-${sourceSha}`)
  );
  if (profile === "bun") {
    const evidence = await readFile(resolve(target, ".agent-teams-runtime-profile.json"), "utf8")
      .then((source) => JSON.parse(source) as {
        readonly profile?: string;
        readonly sourceSha?: string;
        readonly sourceDigest?: string;
      })
      .catch(() => null);
    const entries = await readdir(resolve(target, "node_modules")).catch((): string[] => []);
    if (
      evidence?.profile === "bun" &&
      evidence.sourceSha === sourceSha &&
      evidence.sourceDigest === sourceDigest &&
      !entries.includes(".pnpm")
    ) {
      return target;
    }
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await copySourceTree(repositoryRoot, target);
  return target;
}

export async function prepareProfileProjection(input: {
  readonly profile: Profile;
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly sourceSha: string;
}): Promise<ProfileEvidence> {
  if (!/^[0-9a-f]{40}$/u.test(input.sourceSha)) {
    throw new Error("Source identity must be a full lowercase Git SHA.");
  }
  await mkdir(resolve(input.sourceRoot, ".worker-tmp/profiles"), { recursive: true });
  const target = await assertOwnedProfileRoot(input.targetRoot, input.sourceRoot);
  const sourceDigest = await sourceTreeDigest(input.sourceRoot);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await copySourceTree(input.sourceRoot, target);
  if (await sourceTreeDigest(target) !== sourceDigest) {
    throw new Error("Copied profile source digest differs from its source tree.");
  }
  await assertBunRootProjection(target);
  const policy = await readRepositoryRuntimePolicy(target);
  const originalManifest = await readFile(resolve(target, "package.json"), "utf8");
  const originalDigest = createHash("sha256").update(originalManifest).digest("hex");
  const derivedManifest = input.profile === "node"
    ? projectPackageManager(originalManifest, `pnpm@${policy.toolchain.pnpm.version}`)
    : originalManifest;
  if (input.profile === "node") {
    await writeFile(resolve(target, "package.json"), derivedManifest, "utf8");
  }
  const derivedDigest = createHash("sha256").update(derivedManifest).digest("hex");
  const workflowPath = resolve(target, "architecture/foundation/repository-agent-workflow.yaml");
  const originalWorkflow = await readFile(workflowPath, "utf8");
  const derivedWorkflow = input.profile === "node"
    ? projectNodeAgentWorkflowPolicy(originalWorkflow)
    : originalWorkflow;
  if (input.profile === "node") {
    await writeFile(workflowPath, derivedWorkflow, "utf8");
  }
  const dependencyPath = resolve(target, "architecture/foundation/dependency-declarations.yaml");
  const originalDependencies = await readFile(dependencyPath, "utf8");
  const derivedDependencies = input.profile === "node"
    ? projectNodeDependencyDeclarationsPolicy(originalDependencies) : originalDependencies;
  if (input.profile === "node") { await writeFile(dependencyPath, derivedDependencies, "utf8"); }
  const evidence: ProfileEvidence = {
    profile: input.profile,
    sourceSha: input.sourceSha,
    sourceDigest,
    originalManifestSha256: originalDigest,
    derivedManifestSha256: derivedDigest,
    originalWorkflowPolicySha256: createHash("sha256").update(originalWorkflow).digest("hex"),
    derivedWorkflowPolicySha256: createHash("sha256").update(derivedWorkflow).digest("hex"),
    originalDependencyDeclarationsPolicySha256: createHash("sha256").update(originalDependencies).digest("hex"),
    derivedDependencyDeclarationsPolicySha256: createHash("sha256").update(derivedDependencies).digest("hex")
  };
  await writeProfileEvidence(target, evidence);
  return evidence;
}

function executionRoot(profile: Profile, sourceSha: string): string {
  return process.env["AGENT_TEAMS_FOUNDATION_PROFILE_ROOT"] ??
    (profile === "node" ? resolve(repositoryRoot, `.worker-tmp/profiles/node-${sourceSha}`) : repositoryRoot);
}

async function install(profile: Profile): Promise<number> {
  const sourceSha = process.env["AGENT_TEAMS_FOUNDATION_SOURCE_SHA"] ??
    (await assertExplicitSourceGitAuthority(repositoryRoot)).sourceCommit;
  if (!/^[0-9a-f]{40}$/u.test(sourceSha)) {
    throw new Error("Source identity must be a full lowercase Git SHA.");
  }
  const nodeTarget = process.env["AGENT_TEAMS_FOUNDATION_PROFILE_ROOT"] ??
    resolve(repositoryRoot, `.worker-tmp/profiles/node-${sourceSha}`);
  if (profile === "node") {
    await prepareProfileProjection({
      profile,
      sourceRoot: repositoryRoot,
      targetRoot: nodeTarget,
      sourceSha
    });
  }
  const profileRoot = profile === "node" ? nodeTarget : await freshProfileRoot(profile);
  if (profile === "bun") {
    await assertBunRootProjection(profileRoot);
    const manifest = await readFile(resolve(profileRoot, "package.json"), "utf8");
    const manifestDigest = createHash("sha256").update(manifest).digest("hex");
    const workflow = await readFile(resolve(profileRoot, "architecture/foundation/repository-agent-workflow.yaml"), "utf8");
    const workflowDigest = createHash("sha256").update(workflow).digest("hex");
    const dependencyPolicy = await readFile(resolve(profileRoot, "architecture/foundation/dependency-declarations.yaml"), "utf8");
    const dependencyDigest = createHash("sha256").update(dependencyPolicy).digest("hex");
    await writeProfileEvidence(profileRoot, {
      profile,
      sourceSha,
      sourceDigest: await sourceTreeDigest(repositoryRoot),
      originalManifestSha256: manifestDigest,
      derivedManifestSha256: manifestDigest,
      originalWorkflowPolicySha256: workflowDigest,
      derivedWorkflowPolicySha256: workflowDigest,
      originalDependencyDeclarationsPolicySha256: dependencyDigest,
      derivedDependencyDeclarationsPolicySha256: dependencyDigest
    });
  }
  const tools = await executable(profile);
  const managerArgs = profile === "bun"
    ? ["install", "--frozen-lockfile", "--ignore-scripts", "--linker=isolated"]
    : ["install", "--frozen-lockfile", "--ignore-scripts", "--engine-strict"];
  const command = profile === "bun" ? tools.bun ?? (() => { throw new Error("Bun executable is unavailable."); })() : tools.node;
  const entryArgs = profile === "bun" ? managerArgs : [tools.manager, ...managerArgs];
  const status = await run(command, entryArgs, profileRoot);
  if (status !== 0) {
    return status;
  }
  if (profile === "bun") { await projectProducerSourceDependencies(profileRoot); }
  if (profile === "bun") {
    const initialization = [
      [resolve(profileRoot, "node_modules/@ast-grep/cli/postinstall.js")],
      [resolve(profileRoot, "node_modules/nx/dist/bin/post-install.js")]
    ];
    for (const args of initialization) {
      const initStatus = await run(tools.node, args, profileRoot);
      if (initStatus !== 0) { return initStatus; }
    }
    const qualified = await run(
      tools.node,
      [resolve(profileRoot, "tools/qualify-native-tools.mts")],
      profileRoot,
      {
        ...process.env,
        AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: tools.node,
        ...(tools.bun === undefined ? {} : { AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE: tools.bun })
      }
    );
    return qualified === 0
      ? run(tools.bun ?? tools.node, [resolve(profileRoot, "tools/dependencies-installed-check.mts")], profileRoot, {
          ...process.env,
          AGENT_TEAMS_FOUNDATION_INSTALLED_INVENTORY: resolve(profileRoot, ".worker-tmp/installed-dependencies.json")
        })
      : qualified;
  }
  return run(tools.node, [tools.manager, "peers", "check", "--lockfile-only"], profileRoot);
}

export function projectPackageManager(manifestSource: string, packageManager: string): string {
  const before = JSON.parse(manifestSource) as Record<string, unknown>;
  const projected = manifestSource.replace(
    /("packageManager"\s*:\s*")[^"]+(")/u,
    `$1${packageManager}$2`
  );
  if (projected === manifestSource) {
    throw new Error("The root packageManager field is missing or duplicated.");
  }
  const after = JSON.parse(projected) as Record<string, unknown>;
  const beforeWithoutManager = { ...before };
  const afterWithoutManager = { ...after };
  delete beforeWithoutManager["packageManager"];
  delete afterWithoutManager["packageManager"];
  if (
    JSON.stringify(beforeWithoutManager) !== JSON.stringify(afterWithoutManager) ||
    after["packageManager"] !== packageManager
  ) {
    throw new Error("The Node profile projection may change only packageManager.");
  }
  return projected;
}

export async function assertPnpmProfileQualificationRoot(
  root: string,
  sourceRoot: string,
  requireVirtualStore: boolean = true
): Promise<ProfileEvidence> {
  const evidenceSource = await readFile(resolve(root, ".agent-teams-runtime-profile.json"), "utf8");
  const parsed = JSON.parse(evidenceSource) as Partial<ProfileEvidence>;
  const expectedKeys = [
    "profile", "sourceSha", "sourceDigest", "originalManifestSha256", "derivedManifestSha256",
    "originalWorkflowPolicySha256", "derivedWorkflowPolicySha256",
    "originalDependencyDeclarationsPolicySha256", "derivedDependencyDeclarationsPolicySha256"
  ];
  if (
    Object.keys(parsed).toSorted().join("\0") !== expectedKeys.toSorted().join("\0") ||
    parsed.profile !== "node" ||
    typeof parsed.sourceSha !== "string" ||
    typeof parsed.sourceDigest !== "string" ||
    typeof parsed.originalManifestSha256 !== "string" ||
    typeof parsed.derivedManifestSha256 !== "string" ||
    typeof parsed.originalWorkflowPolicySha256 !== "string" ||
    typeof parsed.derivedWorkflowPolicySha256 !== "string" ||
    typeof parsed.originalDependencyDeclarationsPolicySha256 !== "string" ||
    typeof parsed.derivedDependencyDeclarationsPolicySha256 !== "string"
  ) {
    throw new Error("Node profile qualification evidence is malformed.");
  }
  const evidence: ProfileEvidence = {
    profile: parsed.profile,
    sourceSha: parsed.sourceSha,
    sourceDigest: parsed.sourceDigest,
    originalManifestSha256: parsed.originalManifestSha256,
    derivedManifestSha256: parsed.derivedManifestSha256,
    originalWorkflowPolicySha256: parsed.originalWorkflowPolicySha256,
    derivedWorkflowPolicySha256: parsed.derivedWorkflowPolicySha256,
    originalDependencyDeclarationsPolicySha256: parsed.originalDependencyDeclarationsPolicySha256,
    derivedDependencyDeclarationsPolicySha256: parsed.derivedDependencyDeclarationsPolicySha256
  };
  const manifestSource = await readFile(resolve(root, "package.json"), "utf8");
  const manifest = JSON.parse(manifestSource) as Record<string, unknown>;
  const policy = await readRepositoryRuntimePolicy(root);
  const expectedManager = `pnpm@${policy.toolchain.pnpm.version}`;
  if (manifest["packageManager"] !== expectedManager) {
    throw new Error("Package qualification requires the exact private pnpm profile projection.");
  }
  const derivedDigest = createHash("sha256").update(manifestSource).digest("hex");
  const sourceManifest = await readFile(resolve(sourceRoot, "package.json"), "utf8");
  const projectedManifest = projectPackageManager(sourceManifest, expectedManager);
  if (projectedManifest !== manifestSource) {
    throw new Error("Node profile projection changed more than packageManager.");
  }
  const originalDigest = createHash("sha256").update(sourceManifest).digest("hex");
  if (
    derivedDigest !== evidence.derivedManifestSha256 ||
    originalDigest !== evidence.originalManifestSha256
  ) {
    throw new Error("Node profile manifest digest evidence is stale.");
  }
  await assertNodeAgentWorkflowPolicyProjection(root, sourceRoot, evidence);
  await assertNodeDependencyDeclarationsPolicyProjection(root, sourceRoot, evidence);
  if (await sourceTreeDigest(sourceRoot) !== evidence.sourceDigest) {
    throw new Error("Node profile source digest evidence is stale.");
  }
  if (requireVirtualStore) {
    const virtualStoreLock = resolve(root, "node_modules/.pnpm/lock.yaml");
    const virtualStoreMetadata = await stat(virtualStoreLock).catch(() => null);
    if (virtualStoreMetadata?.isFile() !== true) {
      throw new Error("Node profile qualification requires the actual pnpm virtual store.");
    }
  }
  return evidence;
}

export async function assertCompatibilityNodeExecutable(): Promise<string> {
  const captured = process.env["COMPAT_NODE_EXECUTABLE"];
  if (captured === undefined || captured === "") {
    throw new Error("Node compatibility qualification requires its explicit compatibility executable.");
  }
  const verified = await verifySupportedNode(captured);
  if (await realpath(verified) !== await realpath(process.execPath)) {
    throw new Error("Node compatibility qualification did not execute on its captured compatibility Node.");
  }
  return verified;
}

/** Lint may reuse a projection only while all of its source inputs still match. */
export async function assertPnpmProfileSourceIdentity(root: string, sourceRoot: string): Promise<void> {
  const evidence = await assertPnpmProfileQualificationRoot(root, sourceRoot);
  const normalized = new Map(await Promise.all([
    "package.json",
    "architecture/foundation/repository-agent-workflow.yaml",
    "architecture/foundation/dependency-declarations.yaml"
  ].map(async (path): Promise<[string, string]> => [path, await readFile(resolve(sourceRoot, path), "utf8")])));
  if (await sourceTreeDigest(root, normalized) !== evidence.sourceDigest) {
    throw new Error("Node profile source projection digest evidence is stale.");
  }
}

async function writeProfileEvidence(
  root: string,
  evidence: ProfileEvidence
): Promise<void> {
  await writeFile(resolve(root, ".agent-teams-runtime-profile.json"), `${JSON.stringify({
    ...evidence
  }, null, 2)}\n`, "utf8");
}

async function build(profile: Profile, sourceOwned = false): Promise<number> {
  const sourceSha = process.env["AGENT_TEAMS_FOUNDATION_SOURCE_SHA"] ??
    (await assertExplicitSourceGitAuthority(repositoryRoot)).sourceCommit;
  const root = sourceOwned ? repositoryRoot : executionRoot(profile, sourceSha);
  const tools = await executable(profile);
  if (profile === "node") {
    const evidence = await assertPnpmProfileQualificationRoot(root, repositoryRoot);
    const authority = await assertExplicitSourceGitAuthority(repositoryRoot);
    if (evidence.sourceSha !== authority.sourceCommit) {
      throw new Error("Node profile source commit evidence is stale.");
    }
  }
  return run(tools.node, [resolve(root, "node_modules/typescript/bin/tsc"), "--build", "tsconfig.json", "--pretty", "false"], root);
}

async function assertPackagePhaseReady(): Promise<void> {
  const authority = await assertExplicitSourceGitAuthority(repositoryRoot);
  const declaredRoot = process.env["AGENT_TEAMS_FOUNDATION_SOURCE_ROOT"];
  const declaredSha = process.env["AGENT_TEAMS_FOUNDATION_SOURCE_SHA"];
  if ((declaredRoot !== undefined && await realpath(declaredRoot) !== authority.sourceRoot) ||
      (declaredSha !== undefined && declaredSha !== authority.sourceCommit)) {
    throw new Error("Package qualification source claims differ from the actual source authority.");
  }
  const root = await assertOwnedProfileRoot(executionRoot("node", authority.sourceCommit), authority.sourceRoot);
  const evidence = await assertPnpmProfileQualificationRoot(root, authority.sourceRoot);
  if (evidence.sourceSha !== authority.sourceCommit) {
    throw new Error("Node profile source commit evidence is stale.");
  }
  await assertPnpmProfileSourceIdentity(root, authority.sourceRoot);
}

async function execute(profile: Profile, command: string): Promise<number> {
  // Changed scope belongs to the source Git checkout and its Bun workflow policy.
  // Reaching it through a Node launcher does not qualify the isolated projection.
  const selectedProfile = command === "check:changed" ? "bun" : profile;
  const sourceSha = process.env["AGENT_TEAMS_FOUNDATION_SOURCE_SHA"] ??
    (await assertExplicitSourceGitAuthority(repositoryRoot)).sourceCommit;
  const root = command === "check:changed" ? repositoryRoot : executionRoot(profile, sourceSha);
  const tools = await executable(selectedProfile);
  const environment = {
    ...withoutGitRepositorySelectors(),
    AGENT_TEAMS_FOUNDATION_SOURCE_ROOT: repositoryRoot,
    AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE: selectedProfile,
    AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: tools.node,
    ...(tools.bun === undefined ? {} : { AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE: tools.bun })
  };
  const launcher = resolve(root, "tools/repository-command.mts");
  const operation = command === "check" || command === "verify" || command === "package:check:built" ? "script" : "tool";
  const status = await run(tools.node, [launcher, operation, command], root, environment);
  return status;
}

async function main(): Promise<number> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.command === "package:check:built") {
    await assertPackagePhaseReady();
  }
  if (parsed.command === "install") {
    return install(parsed.profile);
  }
  if (parsed.command === "build") {
    return build(parsed.profile);
  }
  const before = await build(parsed.command === "check:changed" ? "bun" : parsed.profile,
    parsed.command === "check:changed");
  return before === 0 ? execute(parsed.profile, parsed.command) : before;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
