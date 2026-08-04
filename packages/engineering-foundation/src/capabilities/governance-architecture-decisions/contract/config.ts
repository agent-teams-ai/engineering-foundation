import { CapabilityInputError } from "../../../capability-runtime.js";
import { assertSchema } from "../../../schema-catalog.js";
import { assertRepositoryRelativePath, loadStrictYamlFile } from "../../../strict-yaml.js";
import type {
  ArchitectureDecisionIndexPolicy,
  ArchitectureDecisionPolicy,
  ArchitectureDecisionStatus
} from "../application/model/architecture-decision.js";

export const CAPABILITY_ID = "governance.architecture-decisions" as const;
export const CAPABILITY_CONFIG_SCHEMA_VERSION = 1 as const;

const STATUSES = ["proposed", "accepted", "superseded"] as const;

function inputError(message: string): never {
  throw new CapabilityInputError({
    code: "ARCHITECTURE_DECISION_GOVERNANCE_CONFIG_INVALID",
    message,
    phase: "architecture-decision-governance-config",
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

function strings(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    inputError(`${field} must be an array of strings.`);
  }
  return value as readonly string[];
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      inputError(`${field} contains unsupported property: ${key}.`);
    }
  }
}

function pathInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function indexPolicy(value: unknown): ArchitectureDecisionIndexPolicy {
  const index = record(value, "index");
  onlyKeys(index, ["path", "sections"], "index");
  const path = string(index["path"], "index.path");
  assertRepositoryRelativePath(path, "architecture-decision-governance-config");
  const sectionInput = record(index["sections"], "index.sections");
  onlyKeys(sectionInput, STATUSES, "index.sections");
  const sections = Object.fromEntries(
    STATUSES.map((status) => [
      status,
      string(sectionInput[status], `index.sections.${status}`)
    ])
  ) as Record<ArchitectureDecisionStatus, string>;
  if (new Set(Object.values(sections).map((section) => section.trim().toLocaleLowerCase("en-US"))).size !== STATUSES.length) {
    inputError("index.sections values must be distinct.");
  }
  return Object.freeze({ path, sections: Object.freeze(sections) });
}

export async function loadCapabilityConfig(
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal
): Promise<ArchitectureDecisionPolicy> {
  const input = await loadStrictYamlFile(
    consumerRoot,
    configPath,
    "architecture-decision-governance-config",
    signal
  );
  await assertSchema(
    "governance-architecture-decisions/v1",
    input,
    "architecture-decision-governance-config"
  );
  const root = record(input, "architecture decision governance config");
  onlyKeys(root, ["schemaVersion", "adrRoots", "index", "acceptedBaselinePath"], "config");
  if (root["schemaVersion"] !== CAPABILITY_CONFIG_SCHEMA_VERSION) {
    inputError(`schemaVersion must be ${CAPABILITY_CONFIG_SCHEMA_VERSION}.`);
  }
  const adrRoots = strings(root["adrRoots"], "adrRoots");
  if (adrRoots.length === 0) {
    inputError("adrRoots must not be empty.");
  }
  const distinctRoots = new Set<string>();
  for (const adrRoot of adrRoots) {
    assertRepositoryRelativePath(adrRoot, "architecture-decision-governance-config");
    if (distinctRoots.has(adrRoot)) {
      inputError(`adrRoots contains a duplicate path: ${adrRoot}.`);
    }
    distinctRoots.add(adrRoot);
  }
  const index = indexPolicy(root["index"]);
  if (!adrRoots.some((adrRoot) => pathInside(index.path, adrRoot))) {
    inputError("index.path must be inside one configured adrRoots directory.");
  }
  const acceptedBaselinePath = string(
    root["acceptedBaselinePath"],
    "acceptedBaselinePath"
  );
  assertRepositoryRelativePath(
    acceptedBaselinePath,
    "architecture-decision-governance-config"
  );
  if (acceptedBaselinePath !== "architecture/decisions/accepted-decisions.json") {
    inputError(
      "acceptedBaselinePath must use the stable architecture/decisions/accepted-decisions.json anchor."
    );
  }
  return Object.freeze({
    acceptedBaselinePath,
    adrRoots: Object.freeze([...adrRoots].toSorted()),
    index
  });
}
