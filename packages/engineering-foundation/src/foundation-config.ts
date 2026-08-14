import { compareBinaryStrings } from "./binary-string-comparator.js";
import { CapabilityInputError } from "./capability-runtime.js";
import { CAPABILITY_REGISTRY } from "./composition/capability-registry.js";
import { assertSchema } from "./schema-catalog.js";
import { loadStrictYamlFile } from "./strict-yaml.js";

const FOUNDATION_CONFIG_PATH = "foundation.config.yaml";
interface DeclaredCapability {
  readonly id: string;
  readonly configPath: string;
}

export interface FoundationSettings {
  readonly projectId: string;
  readonly declaredCapabilities: readonly DeclaredCapability[];
}

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

export async function loadFoundationConfig(
  consumerRoot: string,
  signal?: AbortSignal
): Promise<FoundationSettings> {
  const input = await loadStrictYamlFile(
    consumerRoot,
    FOUNDATION_CONFIG_PATH,
    "foundation-config",
    signal
  );
  await assertSchema("foundation-config/v1", input, "foundation-config");

  const root = record(input, "foundation config");
  const project = record(root["project"], "project");
  const capabilities = record(root["capabilities"], "capabilities");
  const declaredCapabilities: DeclaredCapability[] = [];
  for (const [id, declarationInput] of Object.entries(capabilities)) {
    if (!CAPABILITY_REGISTRY.has(id)) {
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
