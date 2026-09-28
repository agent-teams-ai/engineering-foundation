import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { bindUnselectedCohortV3, type ManagedSuccessorProfile, type PackedManagedRuntimePolicy } from "../application-api.js";
import { parseJsonRecord } from "./strict-json-record.js";

/** Loads only the closed successor data seam. Operational readers remain version 3. */
export async function loadUnselectedManagedProfileV4(source: string): Promise<ManagedSuccessorProfile> {
  if (Buffer.byteLength(source, "utf8") > 1024 * 1024) {
    throw new TypeError("Managed profile v4 exceeds the bounded input size.");
  }
  const schema = parseJsonRecord(await readFile(new URL("../../../schemas/docs-consumer-integration-profile/v4.schema.json", import.meta.url), "utf8"));
  const cohort = parseJsonRecord(await readFile(new URL("../../../schemas/qualified-docs-cohort/v3.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajv.addSchema(cohort);
  const validate = ajv.compile<ManagedSuccessorProfile>(schema);
  const profile = parseJsonRecord(source);
  if (!validate(profile)) { throw new TypeError(`Invalid managed profile v4: ${JSON.stringify(validate.errors)}`); }
  bindUnselectedCohortV3(profile.cohort, await loadPackedManagedRuntimePolicy());
  return profile;
}

async function loadPackedManagedRuntimePolicy(): Promise<PackedManagedRuntimePolicy> {
  const policySchema = parseJsonRecord(await readFile(new URL("../../../schemas/managed-runtime-policy/v1.schema.json", import.meta.url), "utf8"));
  const asset = parseJsonRecord(await readFile(new URL("../../../assets/runtime-policy.v1.json", import.meta.url), "utf8"));
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
