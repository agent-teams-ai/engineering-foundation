import type { EffectiveInstructionsReader } from "../../../application/ports/effective-instructions-reader.js";
import { renderEffectiveInstructionsReport } from "./report-renderer.js";
import { resolveEffectiveInstructions } from "../../../application/use-cases/resolve-effective-instructions.js";

export interface AgentWorkflowInstructionsInput {
  readonly signal?: AbortSignal;
  readonly consumerRoot: string;
  readonly format: "json" | "text";
  readonly targetPath: string;
}

export function createAgentWorkflowInstructionsCommand(
  reader: EffectiveInstructionsReader
): (input: AgentWorkflowInstructionsInput) => Promise<void> {
  return async (input) => {
    const report = await resolveEffectiveInstructions(
      {
        consumerRoot: input.consumerRoot,
        targetPath: input.targetPath,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      },
      reader
    );
    process.stdout.write(
      input.format === "json"
        ? `${JSON.stringify(report, null, 2)}\n`
        : renderEffectiveInstructionsReport(report)
    );
  };
}
