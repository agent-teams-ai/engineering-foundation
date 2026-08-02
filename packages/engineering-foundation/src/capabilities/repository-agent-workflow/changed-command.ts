import { GitRepositoryChangesReader } from "./adapters/outbound/git/git-repository-changes-reader.js";
import { PnpmPackageScriptRunner } from "./adapters/outbound/pnpm/pnpm-package-script-runner.js";
import type { PnpmProcessEnvironment } from "./adapters/outbound/pnpm/pnpm-package-script-runner.js";
import { renderAgentWorkflowReport } from "./adapters/inbound/cli/report-renderer.js";
import { runChangedAgentWorkflow } from "./application/use-cases/run-changed-agent-workflow.js";
import { loadAgentWorkflowPolicy } from "./contract/config.js";

export async function runAgentWorkflowChangedCommand(input: {
  readonly consumerRoot: string;
  readonly format: "json" | "text";
  readonly baseRef?: string;
  readonly configPath: string;
  readonly pnpmEnvironment: PnpmProcessEnvironment;
}): Promise<void> {
  const controller = new AbortController();
  const cancel = () => {
    controller.abort();
  };
  process.once("SIGINT", cancel);
  try {
    const report = await runChangedAgentWorkflow(
      {
        consumerRoot: input.consumerRoot,
        policy: await loadAgentWorkflowPolicy(
          input.consumerRoot,
          input.configPath,
          controller.signal
        ),
        ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
        signal: controller.signal
      },
      new GitRepositoryChangesReader(),
      new PnpmPackageScriptRunner(input.pnpmEnvironment)
    );
    process.stdout.write(
      input.format === "json"
        ? `${JSON.stringify(report, null, 2)}\n`
        : renderAgentWorkflowReport(report)
    );
    process.exitCode = report.outcome === "passed" ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", cancel);
  }
}
