import type {
  ConsumerIntegrationExecutionV1
} from "../model/consumer-integration-execution.js";
import type {
  ConsumerAssetCatalogReader,
  ConsumerIntegrationInputReader,
  ConsumerIntegrationTransactionPort
} from "../ports/consumer-integration-lifecycle.js";
import type {
  ConsumerIntegrationPlanningPorts
} from "../ports/consumer-integration-planners.js";
import { compileConsumerIntegration } from "./plan-consumer-integration.js";
import type { ConsumerIntegrationIssue } from "../../domain/model.js";

export interface ConsumerIntegrationLifecyclePorts {
  readonly assets: ConsumerAssetCatalogReader;
  readonly input: ConsumerIntegrationInputReader;
  readonly planning: ConsumerIntegrationPlanningPorts;
  readonly transaction: ConsumerIntegrationTransactionPort;
}

async function compile(
  ports: ConsumerIntegrationLifecyclePorts,
  options: {
    readonly consumerRoot: string;
    readonly integrationProfilePath?: string;
  }
) {
  const input = await ports.input.read(options);
  const assetCatalog = await ports.assets.read();
  const compiled = compileConsumerIntegration({
    desired: input.desired,
    snapshot: input.snapshot,
    assetCatalog
  }, ports.planning);
  return {
    root: input.root,
    ...compiled
  };
}

async function recoveryIssue(
  transaction: ConsumerIntegrationTransactionPort,
  consumerRoot: string
): Promise<ConsumerIntegrationIssue | undefined> {
  const inspection = await transaction.inspect({ consumerRoot });
  if (inspection.state === "idle") {return undefined;}
  return Object.freeze({
    code: inspection.code,
    severity: "error",
    subject: "foundation-transaction",
    message: inspection.message
  });
}

function blockedExecution(
  command: ConsumerIntegrationExecutionV1["command"],
  issue: ConsumerIntegrationIssue
): ConsumerIntegrationExecutionV1 {
  return Object.freeze({
    schemaVersion: 1,
    command,
    outcome: "blocked",
    issues: Object.freeze([issue])
  });
}

export function createConsumerIntegrationUseCases(ports: ConsumerIntegrationLifecyclePorts) {
  return Object.freeze({
    async check(options: {
      readonly consumerRoot: string;
      readonly integrationProfilePath?: string;
    }): Promise<ConsumerIntegrationExecutionV1> {
      const issue = await recoveryIssue(ports.transaction, options.consumerRoot);
      if (issue !== undefined) {return blockedExecution("consumer.check", issue);}
      const { plan } = await compile(ports, options);
      return Object.freeze({
        schemaVersion: 1,
        command: "consumer.check",
        outcome: plan.outcome,
        issues: plan.issues,
        plan
      });
    },

    async plan(options: {
      readonly consumerRoot: string;
      readonly integrationProfilePath?: string;
      readonly to: string;
    }): Promise<ConsumerIntegrationExecutionV1> {
      const issue = await recoveryIssue(ports.transaction, options.consumerRoot);
      if (issue !== undefined) {return blockedExecution("consumer.plan", issue);}
      const { plan } = await compile(ports, options);
      if (plan.cohortId !== options.to) {
        return Object.freeze({
          schemaVersion: 1,
          command: "consumer.plan",
          outcome: "blocked",
          issues: Object.freeze([{
            code: "DOCS_CONSUMER_TARGET_COHORT_MISMATCH",
            severity: "error" as const,
            subject: options.to,
            message: `Integration profile selects ${plan.cohortId}, not requested cohort ${options.to}.`
          }]),
          plan
        });
      }
      return Object.freeze({
        schemaVersion: 1,
        command: "consumer.plan",
        outcome: plan.outcome,
        issues: plan.issues,
        plan
      });
    },

    async apply(options: {
      readonly consumerRoot: string;
      readonly expect: string;
      readonly integrationProfilePath?: string;
    }): Promise<ConsumerIntegrationExecutionV1> {
      const issue = await recoveryIssue(ports.transaction, options.consumerRoot);
      if (issue !== undefined) {return blockedExecution("consumer.apply", issue);}
      const { root, plan, mutationPlan } = await compile(ports, options);
      if (plan.planDigest !== options.expect) {
        return Object.freeze({
          schemaVersion: 1,
          command: "consumer.apply",
          outcome: "blocked",
          issues: Object.freeze([{
            code: "DOCS_CONSUMER_STALE_PLAN",
            severity: "error" as const,
            subject: "--expect",
            message: `Expected ${options.expect}, but fresh Plan digest is ${plan.planDigest}.`
          }]),
          plan
        });
      }
      if (plan.outcome === "blocked" || mutationPlan === undefined) {
        return Object.freeze({
          schemaVersion: 1,
          command: "consumer.apply",
          outcome: "blocked",
          issues: plan.issues,
          plan
        });
      }
      const receipt = await ports.transaction.apply({
        consumerRoot: root,
        plan: mutationPlan
      });
      const after = await compile(ports, options);
      if (after.plan.outcome !== "current") {
        throw new Error("Consumer integration postimage verification did not converge to current.");
      }
      return Object.freeze({
        schemaVersion: 1,
        command: "consumer.apply",
        outcome: receipt.outcome === "applied" ? "applied" : "current",
        issues: Object.freeze([]),
        plan: after.plan,
        receipt
      });
    },

    async recover(options: {
      readonly consumerRoot: string;
    }): Promise<ConsumerIntegrationExecutionV1> {
      const receipt = await ports.transaction.recover({
        consumerRoot: options.consumerRoot
      });
      return Object.freeze({
        schemaVersion: 1,
        command: "consumer.recover",
        outcome: "recovered",
        issues: Object.freeze([]),
        receipt
      });
    }
  });
}
