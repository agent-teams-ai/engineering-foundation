import {
  checkFormatCoverage,
  type FormatAuthorityCommand,
  type FormatCoveragePorts,
} from "../api.js";
import { createFormatAuthorityExecution } from "./format-authorities.js";

type StaticFormatPorts = Omit<FormatCoveragePorts, "execution">;

/** Static observation has no authority-process execution port. */
export function createStaticFormatPorts(
  observations: Pick<FormatCoveragePorts, "read" | "verify">,
  clock: Pick<FormatCoveragePorts, "nowMs">,
  prepareFormatter: FormatCoveragePorts["prepareFormatter"],
): StaticFormatPorts {
  return {
    read: observations.read,
    verify: observations.verify,
    nowMs: clock.nowMs,
    prepareFormatter,
  };
}

/** The command borrows its gate executor; the command Host retains process ownership. */
export function createNodeFormatCommand(
  ports: StaticFormatPorts,
  run: FormatAuthorityCommand,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const execution = createFormatAuthorityExecution(
    run,
    environment["AGENT_TEAMS_FOUNDATION_QUALITY_GATE_ACTIVE"] !== undefined,
  );
  return (input: Parameters<typeof checkFormatCoverage>[0]) =>
    checkFormatCoverage(input, { ...ports, execution });
}
