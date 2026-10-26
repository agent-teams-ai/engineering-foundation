import {
  rejectFormatCoverage,
  type FormatCoveragePorts,
  type FormatAuthorityCommand,
} from "../api.js";

export function createFormatAuthorityExecution(
  run: FormatAuthorityCommand,
  qualityGateActive: boolean,
): NonNullable<FormatCoveragePorts["execution"]> {
  return {
    qualityGateActive,
    async runAuthorities(invocation, observed, budgetMs) {
      if (observed.gate === undefined) rejectFormatCoverage("Missing required authority profile.");
      const result = await run({
        consumerRoot: invocation.consumerRoot,
        ...observed.gate,
        budgetMs,
        ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
      });
      if (
        result.reportSchemaVersion !== 1 ||
        result.outcome !== "passed" ||
        result.profileId !== observed.gate.profileId ||
        JSON.stringify(result.tasks.map(({ id }) => id).toSorted()) !==
          JSON.stringify([...observed.authorities].toSorted()) ||
        result.tasks.some(
          (task) => task.outcome !== "passed" || task.exitCode !== 0 || task.signal !== null,
        )
      )
        rejectFormatCoverage("Required format authority failed or did not execute.");
    },
  };
}
