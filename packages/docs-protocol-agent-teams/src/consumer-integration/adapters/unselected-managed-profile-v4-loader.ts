import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { bindUnselectedCohortV3, type ManagedSuccessorProfile, type UnselectedCohortV3 } from "../application-api.js";
import { parseJsonRecord } from "./strict-json-record.js";
import { loadPackedManagedRuntimePolicy } from "./unselected-cohort-v3-loader.js";

/** Loads only the closed successor data seam. Operational readers remain version 3. */
export async function loadUnselectedManagedProfileV4(source: string): Promise<ManagedSuccessorProfile> {
  if (Buffer.byteLength(source, "utf8") > 1024 * 1024) {
    throw new TypeError("Managed profile v4 exceeds the bounded input size.");
  }
  const schema = parseJsonRecord(await readFile(new URL("../../../schemas/docs-consumer-integration-profile/v4.schema.json", import.meta.url), "utf8"), "Managed profile v4 schema");
  const cohort = parseJsonRecord(await readFile(new URL("../../../schemas/qualified-docs-cohort/v3.schema.json", import.meta.url), "utf8"), "Qualified cohort v3 schema");
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajv.addSchema(cohort);
  const validate = ajv.compile<ManagedSuccessorProfile>(schema);
  const profile = parseJsonRecord(source, "Managed profile v4");
  if (!validate(profile)) { throw new TypeError(`Invalid managed profile v4: ${JSON.stringify(validate.errors)}`); }
  // The binder reads core fields only; the schema forbids full-cohort lifecycle fields here.
  bindUnselectedCohortV3(profile.cohort as UnselectedCohortV3, await loadPackedManagedRuntimePolicy());
  return profile;
}
