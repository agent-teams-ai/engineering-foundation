import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parseStrictJson } from "@agent-teams/repository-mutation";
import { bindUnselectedCohortV3, type UnselectedCohortV3, type PackedManagedRuntimePolicy } from "../application-api.js";

export function parseRecord(source: string): Record<string, unknown> {
  const value = parseStrictJson(source);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Cohort v3 JSON input must be an object.");
  }
  return value as Record<string, unknown>;
}

/** Parses a candidate only; no selected authority or dispatcher consumes this result. */
export async function loadUnselectedCohortV3(source: string): Promise<UnselectedCohortV3> {
  if (Buffer.byteLength(source, "utf8") > 1024 * 1024) {
    throw new TypeError("Unselected Cohort v3 exceeds the bounded input size.");
  }
  const schema = parseRecord(await readFile(new URL("../../../schemas/qualified-docs-cohort/v3.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile<UnselectedCohortV3>(schema);
  const candidate = parseRecord(source);
  if (!validate(candidate)) { throw new TypeError(`Invalid unselected Cohort v3: ${JSON.stringify(validate.errors)}`); }
  return bindUnselectedCohortV3(candidate, await loadPackedManagedRuntimePolicy());
}

async function loadPackedManagedRuntimePolicy(): Promise<PackedManagedRuntimePolicy> {
  const policySchema = parseRecord(await readFile(new URL("../../../schemas/managed-runtime-policy/v1.schema.json", import.meta.url), "utf8"));
  const asset = parseRecord(await readFile(new URL("../../../assets/runtime-policy.v1.json", import.meta.url), "utf8"));
  const validatePolicy = new Ajv2020({ strict: true, allErrors: true }).compile(policySchema);
  if (!validatePolicy(asset)) { throw new TypeError("Packed managed runtime policy is invalid."); }
  if (asset.policyId !== "agent-teams.docs-protocol-current-policy" || asset.policyVersion !== "2.0.0" ||
      typeof asset.sourceDigest !== "string") { throw new TypeError("Packed runtime policy identity is invalid."); }
  const managed = asset.managedRuntime as Record<string, unknown> | undefined;
  const lanes = managed?.lanes;
  if (asset.managedCandidate === undefined || managed?.status !== "candidate-unqualified" ||
      Array.isArray(asset.managedCandidate) || typeof asset.managedCandidate !== "object" ||
      (asset.managedCandidate as Record<string, unknown>).selected !== false ||
      typeof lanes !== "object" || lanes === null || Array.isArray(lanes) ||
      !Object.hasOwn(lanes, "node-24-production-default") ||
      !Object.hasOwn(lanes, "node-26-managed-qualified") ||
      typeof managed.pnpm !== "string") {
    throw new TypeError("Packed managed runtime policy is incomplete or selected.");
  }
  return {
    sourceDigest: asset.sourceDigest,
    pnpm: managed.pnpm,
    lanes: lanes as PackedManagedRuntimePolicy["lanes"],
  };
}
