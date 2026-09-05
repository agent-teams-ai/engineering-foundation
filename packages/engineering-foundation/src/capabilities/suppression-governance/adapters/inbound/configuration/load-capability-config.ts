import { isoDateToEpochDay } from "../../../application/model/iso-date.js";
import type {
  SuppressionGovernancePolicy,
  SuppressionWaiver,
  WaiverableDirective
} from "../../../application/model/suppression-governance.js";

import { configurationInputError as inputError, assertConfigRepositoryRelativePath } from "../../../application/configuration-input.js";

export interface SuppressionConfigurationDependencies {
  readonly readYaml: (consumerRoot: string, configPath: string, phase: string, signal?: AbortSignal) => Promise<unknown>;
  readonly assertSchema: (schemaId: "quality-suppression-governance/v1", input: unknown, phase: string) => Promise<void>;
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
  if (!Number.isInteger(value)) {
    inputError(`${field} must be an integer.`);
  }
  return value as number;
}

function strings(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    inputError(`${field} must be an array of strings.`);
  }
  return Object.freeze(value as string[]);
}

function pathInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function mapWaiver(value: unknown, index: number): SuppressionWaiver {
  const field = `waivers[${index}]`;
  const waiver = record(value, field);
  const path = string(waiver["path"], `${field}.path`);
  assertConfigRepositoryRelativePath(path);
  const createdOn = string(waiver["createdOn"], `${field}.createdOn`);
  const expiresOn = string(waiver["expiresOn"], `${field}.expiresOn`);
  const createdDay = isoDateToEpochDay(createdOn);
  const expiryDay = isoDateToEpochDay(expiresOn);
  if (createdDay === undefined || expiryDay === undefined) {
    inputError(`${field} contains an invalid calendar date.`);
  }
  if (createdDay > expiryDay) {
    inputError(`${field}.createdOn must not be after expiresOn.`);
  }
  return Object.freeze({
    id: string(waiver["id"], `${field}.id`),
    path,
    line: integer(waiver["line"], `${field}.line`),
    directive: string(waiver["directive"], `${field}.directive`) as WaiverableDirective,
    rules: Object.freeze(strings(waiver["rules"], `${field}.rules`).toSorted()),
    owner: string(waiver["owner"], `${field}.owner`),
    reason: string(waiver["reason"], `${field}.reason`),
    createdOn,
    expiresOn,
    decisionRef: string(waiver["decisionRef"], `${field}.decisionRef`)
  });
}

function validatePolicy(policy: SuppressionGovernancePolicy): void {
  const waiverIds = new Set<string>();
  const waiverLocations = new Set<string>();
  for (const waiver of policy.waivers) {
    if (waiverIds.has(waiver.id)) {
      inputError(`Waiver ID is duplicated: ${waiver.id}.`);
    }
    waiverIds.add(waiver.id);
    const location = `${waiver.path}:${waiver.line}`;
    if (waiverLocations.has(location)) {
      inputError(`Only one waiver may own a source line: ${location}.`);
    }
    waiverLocations.add(location);
    if (!policy.governedRoots.some((root) => pathInside(waiver.path, root))) {
      inputError(`Waiver path is outside governed roots: ${waiver.path}.`);
    }
  }
}

export async function loadCapabilityConfig(
  dependencies: SuppressionConfigurationDependencies,
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal
): Promise<SuppressionGovernancePolicy> {
  const input = await dependencies.readYaml(
    consumerRoot,
    configPath,
    "suppression-governance-config",
    signal
  );
  await dependencies.assertSchema(
    "quality-suppression-governance/v1",
    input,
    "suppression-governance-config"
  );
  const root = record(input, "suppression governance config");
  const governedRoots = strings(root["governedRoots"], "governedRoots");
  for (const governedRoot of governedRoots) {
    assertConfigRepositoryRelativePath(governedRoot);
  }
  const waiverInputs = root["waivers"];
  if (!Array.isArray(waiverInputs)) {
    inputError("waivers must be an array.");
  }
  const policy: SuppressionGovernancePolicy = Object.freeze({
    governedRoots: Object.freeze([...governedRoots]),
    nonWaivableRulePrefixes: Object.freeze(
      strings(root["nonWaivableRulePrefixes"], "nonWaivableRulePrefixes")
    ),
    waivers: Object.freeze(waiverInputs.map(mapWaiver))
  });
  validatePolicy(policy);
  return policy;
}
