import { tmpdir } from "node:os";
import { lstat, realpath, mkdtemp, writeFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, delimiter, join } from "node:path";
import type {
  ConsumerIntegrationDesiredStateV3,
  ManagedSuccessorProfile,
} from "../domain/model.js";
import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";
import { parseJsonRecord } from "./strict-json-record.js";
import {
  readStableConsumerFile,
  MAXIMUM_MANIFEST_BYTES,
} from "./node-consumer-repository-files.js";
import { execute } from "./consumer-upgrade-sandbox-support.js";

type ManagedCohort =
  | ConsumerIntegrationDesiredStateV3["cohort"]
  | ManagedSuccessorProfile["cohort"];

async function canonicalRuntimeFile(value: string | undefined, subject: string): Promise<string> {
  if (value === undefined || !isAbsolute(value) || value.includes("\0")) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UPGRADE_RUNTIME_REQUIRED",
      `${subject} requires one explicit absolute runtime file.`,
    );
  }
  const path = await realpath(value);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UPGRADE_RUNTIME_INVALID",
      `${subject} is not one canonical regular file.`,
    );
  }
  return path;
}

function assertRuntimeObservation(observation: unknown, major: number): void {
  if (
    typeof observation !== "object" ||
    observation === null ||
    !("node" in observation) ||
    !("platform" in observation) ||
    observation.platform !== "linux" ||
    !("architecture" in observation) ||
    observation.architecture !== "x64" ||
    observation.node !== (major === 26 ? "26.11.1" : "24.21.0")
  ) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UPGRADE_RUNTIME_INVALID",
      "Managed migration requires physical Node24.21.0 or Node26.11.1 on Linux/x64.",
    );
  }
}

/** Existing process ownership with explicit physical source/target runtimes, never an engine fallback. */
export async function managedUpgradeRuntime(
  cohort: ManagedCohort,
  root: string,
  environment: () => NodeJS.ProcessEnv,
  offline = false,
): Promise<typeof execute> {
  const major = cohort.schemaVersion === 3 ? 26 : 24;
  const env = environment();
  const node = await canonicalRuntimeFile(
    env[`AGENT_TEAMS_DOCS_UPGRADE_NODE${major}_EXECUTABLE`],
    `Node ${major}`,
  );
  const corepack = await canonicalRuntimeFile(
    env["AGENT_TEAMS_DOCS_UPGRADE_COREPACK_ENTRYPOINT"],
    "Corepack entrypoint",
  );
  const result = await execute(
    node,
    [
      "--input-type=module",
      "--eval",
      "console.log(JSON.stringify({node:process.versions.node,platform:process.platform,architecture:process.arch}))",
    ],
    root,
  );
  assertRuntimeObservation(JSON.parse(result.stdout), major);
  const childEnvironment = { ...env, PATH: `${dirname(node)}${delimiter}${env["PATH"] ?? ""}` };
  const run: typeof execute = (executable, args, cwd, codes, childEnv) =>
    execute(
      executable === "corepack" || executable === process.execPath ? node : executable,
      executable === "corepack" ? [corepack, ...args] : args,
      cwd,
      codes,
      {
        ...childEnvironment,
        ...childEnv,
        PATH: `${dirname(node)}${delimiter}${(childEnv ?? env)["PATH"] ?? ""}`,
      },
    );
  const observedManifest = await readStableConsumerFile(
    root,
    "package.json",
    MAXIMUM_MANIFEST_BYTES,
    true,
  );
  if (observedManifest.state !== "file") {
    throw new Error("unreachable");
  }
  const manager = parseJsonRecord(Buffer.from(observedManifest.bytes).toString("utf8"))[
    "packageManager"
  ];
  const pin =
    typeof manager === "string"
      ? /^pnpm@(11\.([0-9]+)\.[0-9]+)(?:\+sha512\.[A-Za-z0-9+/=]+)?$/u.exec(manager)
      : null;
  if (pin === null || Number(pin[2]) < 17 || (major === 26 && pin[1] !== "11.20.0")) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UPGRADE_RUNTIME_INVALID",
      "Managed migration packageManager does not match its exact qualified pnpm coordinate.",
    );
  }
  const managerProbe = await run(
    "corepack",
    ["pnpm", "--version"],
    root,
    [0],
    offline ? { ...childEnvironment, COREPACK_ENABLE_NETWORK: "0" } : childEnvironment,
  );
  if (managerProbe.stdout.trim() !== pin[1]) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UPGRADE_RUNTIME_INVALID",
      "Observed pnpm differs from the exact consumer packageManager pin.",
    );
  }
  return run;
}

/** Re-observe the selected physical runtime before CAS, without downloading or touching the consumer. */
export async function verifyManagedRuntimeSelection(
  cohort: ManagedCohort,
  packageManager: string,
  environment: () => NodeJS.ProcessEnv,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "docs-managed-runtime-preflight-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, packageManager }), {
      flag: "wx",
      mode: 0o600,
    });
    await managedUpgradeRuntime(cohort, root, environment, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
