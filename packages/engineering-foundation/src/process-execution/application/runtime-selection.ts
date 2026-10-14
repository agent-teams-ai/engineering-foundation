export type RepositoryRuntimeProfile = "bun" | "node";
export type RepositoryPackageManager = "bun" | "pnpm";

export interface RepositoryRuntimeExecutables {
  readonly node: string;
  readonly bun?: string;
}

export interface RepositoryRuntimeSelectionInput {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly currentExecutablePath: string;
  readonly currentRuntime: RepositoryRuntimeProfile;
  readonly verifyExecutable: (path: string) => Promise<boolean>;
}

export class RepositoryRuntimeSelectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RepositoryRuntimeSelectionError";
  }
}

export function selectClosedPackageManager<T>(
  manager: RepositoryPackageManager,
  adapters: {
    readonly bun?: T;
    readonly pnpm?: T;
  }
): T {
  const selected = manager === "bun"
    ? adapters.bun
    : manager === "pnpm"
      ? adapters.pnpm
      : undefined;
  if (selected === undefined) {
    throw new RepositoryRuntimeSelectionError(
      `Package manager is unavailable or mismatched: ${String(manager)}`
    );
  }
  return selected;
}

const RUNTIME_PROFILE_ENVIRONMENT_VARIABLE =
  "AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE";
const NODE_EXECUTABLE_ENVIRONMENT_VARIABLE =
  "AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE";
const BUN_EXECUTABLE_ENVIRONMENT_VARIABLE =
  "AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE";

function configuredPath(
  environment: Readonly<Record<string, string | undefined>>,
  name: string
): string | undefined {
  const value = environment[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

async function verifiedExecutable(
  label: string,
  path: string,
  verify: (path: string) => Promise<boolean>
): Promise<string> {
  if (!(await verify(path))) {
    throw new RepositoryRuntimeSelectionError(
      `The explicit ${label} executable is unavailable: ${path}`
    );
  }
  return path;
}

/**
 * Resolves the snapshotted outer runtime profile without treating process.execPath
 * as Node while Bun is executing. Manager selection remains a separate closed
 * policy decision.
 */
export async function resolveRepositoryRuntimeExecutables(
  input: RepositoryRuntimeSelectionInput
): Promise<{
  readonly profile: RepositoryRuntimeProfile;
  readonly executables: RepositoryRuntimeExecutables;
}> {
  const marker = configuredPath(
    input.environment,
    RUNTIME_PROFILE_ENVIRONMENT_VARIABLE
  );
  if (marker !== undefined && marker !== "bun" && marker !== "node") {
    throw new RepositoryRuntimeSelectionError(
      `Unsupported repository runtime profile: ${marker}`
    );
  }
  const profile = marker ?? input.currentRuntime;

  const configuredNode = configuredPath(
    input.environment,
    NODE_EXECUTABLE_ENVIRONMENT_VARIABLE
  );
  const nodeCandidate =
    configuredNode ??
    (input.currentRuntime === "node" ? input.currentExecutablePath : undefined);
  if (nodeCandidate === undefined) {
    throw new RepositoryRuntimeSelectionError(
      "An explicit verified Node executable is required when Bun executes repository JavaScript."
    );
  }
  const node = await verifiedExecutable(
    "Node",
    nodeCandidate,
    input.verifyExecutable
  );

  const configuredBun = configuredPath(
    input.environment,
    BUN_EXECUTABLE_ENVIRONMENT_VARIABLE
  );
  const bunCandidate =
    configuredBun ??
    (input.currentRuntime === "bun" ? input.currentExecutablePath : undefined);
  const bun =
    bunCandidate === undefined
      ? undefined
      : await verifiedExecutable("Bun", bunCandidate, input.verifyExecutable);

  return Object.freeze({
    profile,
    executables: Object.freeze(bun === undefined ? { node } : { node, bun })
  });
}
