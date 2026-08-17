import {
  applyKnownFileTransaction,
  inspectKnownFileTransactionBarrier,
  recoverKnownFileTransaction,
  type KnownFileTransactionReceiptV1
} from "@agent-teams/engineering-foundation/mutation";

import { readConsumerIntegrationInput } from "../adapters/node-consumer-integration-repository.js";
import { loadPackageConsumerAssetCatalog } from "../adapters/package-consumer-asset-catalog.js";
import { compileConsumerIntegration } from "../application/use-cases/plan-consumer-integration.js";
import type {
  ConsumerIntegrationIssue,
  ConsumerIntegrationPlanV1
} from "../domain/model.js";

export interface ConsumerIntegrationExecutionV1 {
  readonly schemaVersion: 1;
  readonly command: "consumer.apply" | "consumer.check" | "consumer.plan" | "consumer.recover";
  readonly outcome: "applied" | "blocked" | "change-required" | "current" | "recovered";
  readonly issues: readonly ConsumerIntegrationIssue[];
  readonly plan?: ConsumerIntegrationPlanV1;
  readonly receipt?: KnownFileTransactionReceiptV1;
}

async function compile(options: {
  readonly consumerRoot: string;
  readonly integrationProfilePath?: string;
}): Promise<{
  readonly root: string;
  readonly plan: ConsumerIntegrationPlanV1;
  readonly mutationPlan?: Parameters<typeof applyKnownFileTransaction>[0]["plan"];
}> {
  const input = await readConsumerIntegrationInput(options);
  const assetCatalog = await loadPackageConsumerAssetCatalog();
  const compiled = compileConsumerIntegration({
    desired: input.desired,
    snapshot: input.snapshot,
    assetCatalog
  });
  return {
    root: input.root,
    ...compiled
  };
}

async function recoveryIssue(consumerRoot: string): Promise<ConsumerIntegrationIssue | undefined> {
  const inspection = await inspectKnownFileTransactionBarrier({ consumerRoot });
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

export async function checkConsumerIntegration(options: {
  readonly consumerRoot: string;
  readonly integrationProfilePath?: string;
}): Promise<ConsumerIntegrationExecutionV1> {
  const issue = await recoveryIssue(options.consumerRoot);
  if (issue !== undefined) {return blockedExecution("consumer.check", issue);}
  const { plan } = await compile(options);
  return Object.freeze({
    schemaVersion: 1,
    command: "consumer.check",
    outcome: plan.outcome,
    issues: plan.issues,
    plan
  });
}

export async function planNodeConsumerIntegration(options: {
  readonly consumerRoot: string;
  readonly integrationProfilePath?: string;
  readonly to: string;
}): Promise<ConsumerIntegrationExecutionV1> {
  const issue = await recoveryIssue(options.consumerRoot);
  if (issue !== undefined) {return blockedExecution("consumer.plan", issue);}
  const { plan } = await compile(options);
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
}

export async function applyConsumerIntegration(options: {
  readonly consumerRoot: string;
  readonly expect: string;
  readonly integrationProfilePath?: string;
}): Promise<ConsumerIntegrationExecutionV1> {
  const issue = await recoveryIssue(options.consumerRoot);
  if (issue !== undefined) {return blockedExecution("consumer.apply", issue);}
  const { root, plan, mutationPlan } = await compile(options);
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
  const receipt = await applyKnownFileTransaction({
    consumerRoot: root,
    plan: mutationPlan
  });
  const after = await compile(options);
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
}

export async function recoverConsumerIntegration(options: {
  readonly consumerRoot: string;
}): Promise<ConsumerIntegrationExecutionV1> {
  const receipt = await recoverKnownFileTransaction({
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
