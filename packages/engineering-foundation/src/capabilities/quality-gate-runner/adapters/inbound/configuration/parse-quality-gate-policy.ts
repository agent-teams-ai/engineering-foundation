import type {
  NormalizedQualityGatePolicy,
  NormalizedQualityGateProfile,
  QualityGateTask
} from "../../../application/model/quality-gate.js";
import {
  QualityGateGraphError,
  validateQualityGatePolicy
} from "../../../application/policies/validate-quality-gate-graph.js";
import { configurationInputError as inputError } from "../../../application/configuration-input.js";


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

function profile(
  value: unknown,
  index: number,
  schemaVersion: 1 | 2
): NormalizedQualityGateProfile {
  const field = `profiles[${index}]`;
  const input = record(value, field);
  const tasks = input["tasks"];
  if (!Array.isArray(tasks)) {
    inputError(`${field}.tasks must be an array.`);
  }
  return Object.freeze({
    id: string(input["id"], `${field}.id`),
    packageManager: schemaVersion === 1
      ? "pnpm"
      : packageManager(input["packageManager"], `${field}.packageManager`),
    concurrency: integer(input["concurrency"], `${field}.concurrency`),
    tasks: Object.freeze(tasks.map((entry, taskIndex) => task(entry, index, taskIndex)))
  });
}

function packageManager(value: unknown, field: string): "bun" | "pnpm" {
  if (value !== "bun" && value !== "pnpm") {
    inputError(`${field} must be "bun" or "pnpm".`);
  }
  return value;
}

export function parseQualityGatePolicy(input: unknown): NormalizedQualityGatePolicy {
  const root = record(input, "quality gate runner config");
  const rawSchemaVersion = root["schemaVersion"];
  const schemaVersionValue = rawSchemaVersion === undefined
    ? 1
    : integer(rawSchemaVersion, "schemaVersion");
  if (schemaVersionValue !== 1 && schemaVersionValue !== 2) {
    inputError("schemaVersion must be 1 or 2.");
  }
  const schemaVersion = schemaVersionValue;
  const profiles = root["profiles"];
  if (!Array.isArray(profiles)) {
    inputError("profiles must be an array.");
  }
  const policy: NormalizedQualityGatePolicy = Object.freeze({
    profiles: Object.freeze(
      profiles.map((entry, index) => {
        const parsed = profile(entry, index, schemaVersion);
        return Object.freeze(
          schemaVersion === 1
            ? { ...parsed, packageManager: "pnpm" as const }
            : parsed
        );
      })
    )
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
