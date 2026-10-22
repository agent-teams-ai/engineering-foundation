import fs from "node:fs";
import {
  installedToolVersion,
  resolveDoctorExecutable,
  toolchainPins,
  type ToolName,
} from "./executables.js";
import type { CheckerExecutable } from "./process.js";

interface ToolObservation {
  readonly required: boolean;
  readonly expectedVersion: string;
  readonly installedVersion: string | null;
  readonly resolvedVersion: string | null;
  readonly available: boolean;
  readonly version?: string;
  readonly versionSource: "binary-output" | "installed-package" | null;
  readonly stderr?: string;
  readonly resolutionCode?: string;
}
interface DoctorFinding {
  readonly tool: ToolName;
  readonly code:
    | "TOOLCHAIN_OPTIONAL_TOOL_UNAVAILABLE"
    | "TOOLCHAIN_TOOL_UNAVAILABLE"
    | "TOOLCHAIN_TOOL_PIN_MISMATCH"
    | "TOOLCHAIN_TOOL_PROBE_FAILED";
  readonly severity: "error" | "info";
}
export type DoctorDetails = Readonly<Record<ToolName, ToolObservation>> & {
  readonly schemaVersion: 1;
  readonly packageVersion: string;
  readonly findings: readonly DoctorFinding[];
};
type Probe = (executable: CheckerExecutable) => Promise<{
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}>;

function reportedVersion(tool: ToolName, output: string): string | null {
  const semver = "(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)";
  return (
    (tool === "tsrs"
      ? new RegExp(`\\btsrs ${semver}(?:,|\\))`, "u")
      : new RegExp(`^(?:Version:?\\s+)?${semver}$`, "u")
    ).exec(output.trim())?.[1] ?? null
  );
}

function unavailableFinding(
  tool: ToolName,
  observed: Pick<ToolObservation, "required" | "expectedVersion" | "installedVersion">,
  resolutionCode: string | undefined,
): DoctorFinding {
  const mismatch =
    (observed.installedVersion !== null &&
      observed.installedVersion !== observed.expectedVersion) ||
    resolutionCode?.includes("PIN_MISMATCH") === true;
  return {
    tool,
    code: mismatch
      ? "TOOLCHAIN_TOOL_PIN_MISMATCH"
      : observed.required || resolutionCode !== undefined
        ? "TOOLCHAIN_TOOL_UNAVAILABLE"
        : "TOOLCHAIN_OPTIONAL_TOOL_UNAVAILABLE",
    severity: observed.required || resolutionCode !== undefined || mismatch ? "error" : "info",
  };
}

export async function doctor(signal: AbortSignal, probe: Probe): Promise<DoctorDetails> {
  const own: unknown = JSON.parse(
    fs.readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
  );
  if (
    typeof own !== "object" ||
    own === null ||
    !("version" in own) ||
    typeof own.version !== "string"
  ) {
    throw new Error("TOOLCHAIN_PACKAGE_VERSION_INVALID");
  }
  const findings: DoctorFinding[] = [];
  const entries: [ToolName, ToolObservation][] = [];
  for (const tool of ["typescript", "tsrs", "bun", "oxlint", "oxlint-tsgolint", "oxfmt"] as const) {
    signal.throwIfAborted();
    const required = tool !== "tsrs" && tool !== "bun";
    const expectedVersion = toolchainPins[tool];
    let installedVersion: string | null = null;
    let executable: CheckerExecutable | null = null;
    let resolutionCode: string | undefined;
    try {
      installedVersion = installedToolVersion(tool);
      executable = resolveDoctorExecutable(tool);
    } catch (error) {
      resolutionCode =
        error instanceof Error && /^TOOLCHAIN_[A-Z_]+(?::[a-z-]+)?$/u.test(error.message)
          ? error.message
          : "TOOLCHAIN_TOOL_RESOLUTION_FAILED";
    }
    if (executable === null) {
      findings.push(
        unavailableFinding(tool, { required, expectedVersion, installedVersion }, resolutionCode),
      );
      entries.push([
        tool,
        {
          required,
          expectedVersion,
          installedVersion,
          resolvedVersion: null,
          available: false,
          versionSource: null,
          ...(resolutionCode === undefined ? {} : { resolutionCode }),
        },
      ]);
      continue;
    }
    // The pinned companion has no supported --version command. Its resolver
    // checks both package/native versions and executable permission instead.
    if (tool === "oxlint-tsgolint") {
      entries.push([
        tool,
        {
          required,
          expectedVersion,
          installedVersion,
          resolvedVersion: installedVersion,
          available: true,
          version: installedVersion!,
          versionSource: "installed-package",
        },
      ]);
      continue;
    }
    // Process capture/custody failures remain terminal; never continue probes
    // after the existing executor reports an incomplete owned process result.
    const result = await probe(executable);
    signal.throwIfAborted();
    const resolvedVersion = reportedVersion(tool, result.stdout);
    if (result.exitCode !== 0 || resolvedVersion === null) {
      findings.push({ tool, code: "TOOLCHAIN_TOOL_PROBE_FAILED", severity: "error" });
    } else if (resolvedVersion !== expectedVersion) {
      findings.push({ tool, code: "TOOLCHAIN_TOOL_PIN_MISMATCH", severity: "error" });
    }
    entries.push([
      tool,
      {
        required,
        expectedVersion,
        installedVersion,
        resolvedVersion,
        available: result.exitCode === 0,
        version: result.stdout.trim(),
        versionSource: "binary-output",
        stderr: result.stderr,
      },
    ]);
  }
  const tools = Object.fromEntries(entries) as Record<ToolName, ToolObservation>;
  return { ...tools, schemaVersion: 1, packageVersion: own.version, findings };
}
