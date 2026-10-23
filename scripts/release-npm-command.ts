import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
interface PublishArtifact {
  readonly archivePath: string;
  readonly name: string;
  readonly version: string;
  readonly registry?: string;
}
const EXPECTED_NPM_VERSION = "11.19.0";

export function assertNpmVersion(npmVersion = executeCommand("npm", ["--version"]).trim()) {
  if (npmVersion !== EXPECTED_NPM_VERSION) {
    throw new Error(
      `Ordered publishing requires npm ${EXPECTED_NPM_VERSION}, observed ${npmVersion}.`,
    );
  }
}

export function npmPublishArguments(artifact: PublishArtifact, tag: string) {
  const registry = artifact.registry ?? "https://registry.npmjs.org/";
  return [
    "publish",
    artifact.archivePath,
    "--access",
    "public",
    "--tag",
    tag,
    "--provenance",
    "--ignore-scripts",
    `--registry=${registry}`,
  ];
}

export function npmSignatureInstallArguments(artifact: PublishArtifact) {
  const registry = artifact.registry ?? "https://registry.npmjs.org/";
  return [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--fund=false",
    "--save-exact",
    `--registry=${registry}`,
    `${artifact.name}@${artifact.version}`,
  ];
}

export function executeCommand(
  executable: string,
  args: readonly string[],
  options: Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> = {},
) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${executable} ${args[0]} failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

// Keep raw npm output (which can contain credentials) inside this adapter.
// Only positively identified local refusals bypass registry reconciliation.
export function publishNpmArtifact(
  artifact: PublishArtifact,
  tag: string,
  { cwd, spawn = spawnSync }: { cwd?: string; spawn?: typeof spawnSync } = {},
) {
  const result = spawn("npm", npmPublishArguments(artifact, tag), {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }) as Omit<SpawnSyncReturns<string>, "stderr"> & { readonly stderr?: string };
  if (result.error === undefined && result.status === 0) {
    return;
  }
  const npmCode = /^npm error code (E[A-Z0-9]+)$/mu.exec(result.stderr ?? "")?.[1];
  const code = spawnErrorCode(result.error) ?? npmCode;
  const knownCodes = [
    "ENOENT",
    "EACCES",
    "ENEEDAUTH",
    "EUSAGE",
    "EPRIVATE",
    "E401",
    "E403",
    "E404",
    "EPUBLISHCONFLICT",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOBUFS",
    "EINTEGRITY",
    "E422",
    "E500",
    "E502",
    "E503",
  ];
  const notStarted = publishNotStarted(result, npmCode);
  const diagnostic = [
    `npm publish failed; code=${typeof code === "string" && knownCodes.includes(code) ? code : "unknown"}`,
    `exit=${Number.isInteger(result.status) ? result.status : "unknown"}`,
    `signal=${["SIGTERM", "SIGKILL", "SIGINT"].includes(result.signal ?? "") ? result.signal : "none-or-unknown"}`,
    "raw output omitted",
  ].join("; ");
  throw Object.assign(new Error(diagnostic), {
    publishFailure: {
      diagnostic,
      notStarted,
      outcome:
        result.error === undefined && Number.isInteger(result.status) && result.status !== 0
          ? "nonzero"
          : "unknown",
    },
  });
}

function publishNotStarted(
  result: Pick<ReturnType<typeof spawnSync>, "error" | "pid">,
  npmCode: string | undefined,
): boolean {
  const code = spawnErrorCode(result.error);
  return result.error !== undefined
    ? typeof code === "string" && ["ENOENT", "EACCES"].includes(code) && result.pid === 0
    : ["ENEEDAUTH", "EUSAGE", "EPRIVATE"].includes(npmCode ?? "");
}

export function runTimedAudit(
  command: string,
  args: readonly string[],
  options: Omit<SpawnSyncOptionsWithStringEncoding, "encoding">,
) {
  return spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
    killSignal: "SIGKILL",
  });
}

function spawnErrorCode(error: Error | undefined): unknown {
  return error !== undefined && "code" in error ? error.code : undefined;
}
