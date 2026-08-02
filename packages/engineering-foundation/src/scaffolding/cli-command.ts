import {
  applyFilesystemScaffold,
  readScaffoldPlanFile,
  recoverFilesystemScaffold
} from "./index.js";
import type { ScaffoldPlanV1, ScaffoldReceiptV1 } from "./contract/types.js";
import { ScaffoldError } from "./scaffold-error.js";
import { planScaffoldFromFile } from "./service.js";

export interface ScaffoldCliArguments {
  readonly command: string;
  readonly positional: readonly string[];
  readonly consumerRoot: string;
  readonly configPath: string;
}

function renderPlan(plan: ScaffoldPlanV1): string {
  return `Scaffold Plan: ${plan.planDigest}\nProject: ${plan.projectId}\nComposition: ${plan.composition.id}\nTarget: ${plan.target.id} -> ${plan.target.path}\nOperations: ${plan.operations.length}\n`;
}

function renderReceipt(receipt: ScaffoldReceiptV1): string {
  return `Scaffold Receipt: ${receipt.receiptDigest}\nPlan: ${receipt.planDigest}\nOutcome: ${receipt.outcome}\nOperations: ${receipt.operations.length}\n`;
}

function exitCode(receipt: ScaffoldReceiptV1): number {
  return receipt.outcome === "applied" ||
    receipt.outcome === "already-applied" ||
    receipt.outcome === "failed-recovered"
    ? 0
    : 1;
}

export async function runScaffoldingCliCommand(
  parsed: ScaffoldCliArguments,
  json: boolean
): Promise<boolean> {
  switch (parsed.command) {
    case "scaffold-apply": {
      const planPath = parsed.positional[0];
      if (planPath === undefined) {
        throw new ScaffoldError(
          "SCAFFOLD_INPUT_INVALID",
          "scaffold-apply requires a repository-relative Plan path."
        );
      }
      const plan = await readScaffoldPlanFile(parsed.consumerRoot, planPath);
      const receipt = await applyFilesystemScaffold(parsed.consumerRoot, plan);
      process.stdout.write(
        json ? `${JSON.stringify(receipt, null, 2)}\n` : renderReceipt(receipt)
      );
      process.exitCode = exitCode(receipt);
      return true;
    }
    case "scaffold-plan": {
      const intentPath = parsed.positional[0];
      if (intentPath === undefined) {
        throw new ScaffoldError(
          "SCAFFOLD_INPUT_INVALID",
          "scaffold-plan requires a repository-relative Intent path."
        );
      }
      const plan = await planScaffoldFromFile({
        consumerRoot: parsed.consumerRoot,
        intentPath,
        configPath: parsed.configPath
      });
      process.stdout.write(
        json ? `${JSON.stringify(plan, null, 2)}\n` : renderPlan(plan)
      );
      return true;
    }
    case "scaffold-recover": {
      const receipt = await recoverFilesystemScaffold(parsed.consumerRoot);
      if (receipt === undefined) {
        process.stdout.write(
          json
            ? `${JSON.stringify({ outcome: "no-pending-transaction" }, null, 2)}\n`
            : "No pending scaffolding transaction.\n"
        );
      } else {
        process.stdout.write(
          json ? `${JSON.stringify(receipt, null, 2)}\n` : renderReceipt(receipt)
        );
        process.exitCode = exitCode(receipt);
      }
      return true;
    }
    default:
      return false;
  }
}
