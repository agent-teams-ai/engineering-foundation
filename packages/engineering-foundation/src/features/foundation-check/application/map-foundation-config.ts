import { compareBinaryStrings } from "../../../binary-string-comparator.js";
import { CapabilityInputError } from "../../validation-reporting/api.js";

import type { DeclaredCapability, FoundationSettings } from "./settings.js";

function inputError(message: string): never {
  throw new CapabilityInputError({
    code: "FOUNDATION_CONFIG_INVALID",
    message,
    phase: "foundation-config",
    retryable: false
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    inputError(`${field} must be an object.`);
  }
  return value;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") {
    inputError(`${field} must be a string.`);
  }
  return value;
}

/** Maps schema-validated, inert input; this function has no filesystem authority. */
export function mapFoundationConfig(
  input: unknown,
  supportedCapabilityIds: ReadonlySet<string>
): FoundationSettings {
  const root = record(input, "foundation config");
  const project = record(root["project"], "project");
  const capabilities = record(root["capabilities"], "capabilities");
  const declaredCapabilities: DeclaredCapability[] = [];
  for (const [id, declarationInput] of Object.entries(capabilities)) {
    if (!supportedCapabilityIds.has(id)) {
      inputError(`Unsupported capability declaration: ${id}.`);
    }
    const declaration = record(declarationInput, `capabilities.${id}`);
    declaredCapabilities.push({
      id,
      configPath: string(declaration["configPath"], `capabilities.${id}.configPath`)
    });
  }
  return Object.freeze({
    projectId: string(project["id"], "project.id"),
    declaredCapabilities: Object.freeze(
      declaredCapabilities.toSorted((left, right) => compareBinaryStrings(left.id, right.id))
    )
  });
}
