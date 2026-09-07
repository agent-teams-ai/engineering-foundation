import type { ScaffoldingApi } from "./create-scaffolding-api.js";
import type {
  ScaffoldPlan,
  ScaffoldReceipt
} from "../../contract/scaffold-contract.js";
import { ScaffoldError } from "../../scaffold-error.js";

export interface ScaffoldCliArguments {
  readonly command: string;
  readonly positional: readonly string[];
  readonly consumerRoot: string;
  readonly configPath: string;
}

function renderPlan(plan: ScaffoldPlan): string {
  return `Scaffold Plan: ${plan.planDigest}\nProject: ${plan.projectId}\nComposition: ${plan.composition.id}\nTarget: ${plan.target.id} -> ${plan.target.path}\nOperations: ${plan.operations.length}\n`;
}

function renderReceipt(receipt: ScaffoldReceipt): string {
  return `Scaffold Receipt: ${receipt.receiptDigest}\nPlan: ${receipt.planDigest}\nOutcome: ${receipt.outcome}\nOperations: ${receipt.operations.length}\n`;
}

function exitCode(receipt: ScaffoldReceipt): number {
  return receipt.outcome === "applied" ||
    receipt.outcome === "already-applied" ||
    receipt.outcome === "failed-recovered"
    ? 0
    : 1;
}

export async function runScaffoldingCliCommand(
  parsed: ScaffoldCliArguments,
  json: boolean,
  api: Pick<ScaffoldingApi, "planScaffoldFromFile" | "applyFilesystemScaffold" | "readScaffoldPlanFile" | "recoverFilesystemScaffold">
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
      const plan = await api.readScaffoldPlanFile(parsed.consumerRoot, planPath);
      const receipt = await api.applyFilesystemScaffold(parsed.consumerRoot, plan);
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
      const plan = await api.planScaffoldFromFile({
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
      const receipt = await api.recoverFilesystemScaffold(parsed.consumerRoot);
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
