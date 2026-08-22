import { renderEffectiveInstructionsReport } from "./adapters/inbound/cli/report-renderer.js";
import { FilesystemEffectiveInstructionsReader } from "./adapters/outbound/filesystem/filesystem-effective-instructions-reader.js";
import { resolveEffectiveInstructions } from "./application/use-cases/resolve-effective-instructions.js";

export async function runAgentWorkflowInstructionsCommand(input: {
  readonly consumerRoot: string;
  readonly format: "json" | "text";
  readonly targetPath: string;
}): Promise<void> {
  const controller = new AbortController();
  const cancel = () => {
    controller.abort();
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const report = await resolveEffectiveInstructions(
      {
        consumerRoot: input.consumerRoot,
        targetPath: input.targetPath,
        signal: controller.signal
      },
      new FilesystemEffectiveInstructionsReader()
    );
    process.stdout.write(
      input.format === "json"
        ? `${JSON.stringify(report, null, 2)}\n`
        : renderEffectiveInstructionsReport(report)
    );
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
