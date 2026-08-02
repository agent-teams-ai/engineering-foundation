import { compareBinaryStrings } from "./binary-string-comparator.js";
import { CapabilityInputError } from "./capability-runtime.js";
import { assertSchema } from "./schema-catalog.js";
import { loadStrictYamlFile } from "./strict-yaml.js";

const FOUNDATION_CONFIG_PATH = "foundation.config.yaml";
const PUBLIC_API_COMPATIBILITY_CAPABILITY =
  "package.public-api-compatibility" as const;
const JSON_SCHEMA_RELEASES_CAPABILITY =
  "contract.json-schema-releases" as const;
const PROTOBUF_EVOLUTION_CAPABILITY =
  "contract.protobuf-evolution" as const;
const DOCUMENTATION_LOCAL_REFERENCES_CAPABILITY =
  "documentation.local-references" as const;
const ARCHITECTURE_DECISIONS_CAPABILITY =
  "governance.architecture-decisions" as const;
const REPOSITORY_AGENT_WORKFLOW_CAPABILITY =
  "repository.agent-workflow" as const;
const SUPPRESSION_GOVERNANCE_CAPABILITY =
  "quality.suppression-governance" as const;
const REPOSITORY_SECURITY_BASELINE_CAPABILITY =
  "repository.security-baseline" as const;
const SOURCE_DEPENDENCIES_CAPABILITY =
  "architecture.source-dependencies" as const;
const WORKSPACE_DEPENDENCY_DECLARATIONS_CAPABILITY =
  "workspace.dependency-declarations" as const;
const SUPPORTED_CAPABILITY_IDS = [
  JSON_SCHEMA_RELEASES_CAPABILITY,
  PROTOBUF_EVOLUTION_CAPABILITY,
  DOCUMENTATION_LOCAL_REFERENCES_CAPABILITY,
  ARCHITECTURE_DECISIONS_CAPABILITY,
  PUBLIC_API_COMPATIBILITY_CAPABILITY,
  REPOSITORY_AGENT_WORKFLOW_CAPABILITY,
  REPOSITORY_SECURITY_BASELINE_CAPABILITY,
  SUPPRESSION_GOVERNANCE_CAPABILITY,
  SOURCE_DEPENDENCIES_CAPABILITY,
  WORKSPACE_DEPENDENCY_DECLARATIONS_CAPABILITY
] as const;

type SupportedCapabilityId = (typeof SUPPORTED_CAPABILITY_IDS)[number];

interface DeclaredCapability {
  readonly id: SupportedCapabilityId;
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

function isSupportedCapabilityId(value: string): value is SupportedCapabilityId {
  return SUPPORTED_CAPABILITY_IDS.some((candidate) => candidate === value);
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
    if (!isSupportedCapabilityId(id)) {
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
