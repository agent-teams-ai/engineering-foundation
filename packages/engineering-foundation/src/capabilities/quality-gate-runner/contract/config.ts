import { CapabilityInputError } from "../../../capability-runtime.js";
import { assertSchema } from "../../../schema-catalog.js";
import { loadStrictYamlFile } from "../../../strict-yaml.js";
import type {
  QualityGatePolicy,
  QualityGateProfile,
  QualityGateTask
} from "../application/model/quality-gate.js";
import {
  QualityGateGraphError,
  validateQualityGatePolicy
} from "../application/policies/validate-quality-gate-graph.js";

export const CAPABILITY_ID = "quality.gate-runner" as const;
export const CAPABILITY_CONFIG_SCHEMA_VERSION = 1 as const;

export type QualityGatePolicyLoader = (
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal
) => Promise<QualityGatePolicy>;

function inputError(message: string): never {
  throw new CapabilityInputError({
    code: "QUALITY_GATE_RUNNER_CONFIG_INVALID",
    message,
    phase: "quality-gate-runner-config",
    retryable: false
  });
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    inputError(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") {
    inputError(`${field} must be a string.`);
  }
  return value;
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) {
    inputError(`${field} must be an integer.`);
  }
  return value as number;
}

function ids(value: unknown, field: string): readonly string[] {
  if (value === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(value)) {
    inputError(`${field} must be an array.`);
  }
  return Object.freeze(
    value.map((entry, index) => string(entry, `${field}[${index}]`))
  );
}

function task(value: unknown, profileIndex: number, taskIndex: number): QualityGateTask {
  const field = `profiles[${profileIndex}].tasks[${taskIndex}]`;
  const input = record(value, field);
  const timeoutMs = input["timeoutMs"];
  return Object.freeze({
    id: string(input["id"], `${field}.id`),
    needs: ids(input["needs"], `${field}.needs`),
    after: ids(input["after"], `${field}.after`),
    ...(timeoutMs === undefined ? {} : { timeoutMs: integer(timeoutMs, `${field}.timeoutMs`) })
  });
}

function profile(value: unknown, index: number): QualityGateProfile {
  const field = `profiles[${index}]`;
  const input = record(value, field);
  const tasks = input["tasks"];
  if (!Array.isArray(tasks)) {
    inputError(`${field}.tasks must be an array.`);
  }
  return Object.freeze({
    id: string(input["id"], `${field}.id`),
    concurrency: integer(input["concurrency"], `${field}.concurrency`),
    tasks: Object.freeze(tasks.map((entry, taskIndex) => task(entry, index, taskIndex)))
  });
}

export async function loadQualityGatePolicy(
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal
): Promise<QualityGatePolicy> {
  const input = await loadStrictYamlFile(
    consumerRoot,
    configPath,
    "quality-gate-runner-config",
    signal
  );
  await assertSchema("quality-gate-runner/v1", input, "quality-gate-runner-config");
  const root = record(input, "quality gate runner config");
  const profiles = root["profiles"];
  if (!Array.isArray(profiles)) {
    inputError("profiles must be an array.");
  }
  const policy: QualityGatePolicy = Object.freeze({
    packageManager: "pnpm",
    profiles: Object.freeze(profiles.map(profile))
  });
  try {
    validateQualityGatePolicy(policy);
  } catch (error) {
    if (error instanceof QualityGateGraphError) {
      inputError(error.message);
    }
    throw error;
  }
  return policy;
}
