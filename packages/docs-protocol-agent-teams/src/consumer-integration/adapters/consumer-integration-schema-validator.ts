import { readFile } from "node:fs/promises";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

const validators = new Map<string, Promise<ValidateFunction>>();

async function validator(
  id: "docs-consumer-integration-execution" | "docs-consumer-integration-profile" |
    "docs-consumer-integration-profile-v2" | "docs-consumer-upgrade-execution"
): Promise<ValidateFunction> {
  const existing = validators.get(id);
  if (existing !== undefined) {return existing;}
  const loading = (async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    if (id === "docs-consumer-integration-execution" || id === "docs-consumer-upgrade-execution") {
      const [plan, mutationReceipt] = await Promise.all([
        readFile(new URL(
          "../../../schemas/docs-consumer-integration-plan/v1.schema.json",
          import.meta.url
        ), "utf8"),
        readFile(new URL(
          "../../../../repository-mutation/schemas/known-file-transaction-receipt/v1.schema.json",
          import.meta.url
        ), "utf8")
      ]);
      ajv.addSchema(JSON.parse(plan) as object);
      ajv.addSchema(JSON.parse(mutationReceipt) as object);
    }
    const schemaUrl = new URL(id === "docs-consumer-integration-profile-v2"
      ? "../../../schemas/docs-consumer-integration-profile/v2.schema.json"
      : `../../../schemas/${id}/v1.schema.json`, import.meta.url);
    return ajv.compile(JSON.parse(await readFile(schemaUrl, "utf8")) as object);
  })();
  validators.set(id, loading);
  return loading;
}

async function assertSchema(
  id: "docs-consumer-integration-execution" | "docs-consumer-integration-profile" |
    "docs-consumer-integration-profile-v2" | "docs-consumer-upgrade-execution",
  value: unknown
): Promise<void> {
  const validate = await validator(id);
  if (validate(value)) {return;}
  const problems = (validate.errors ?? [])
    .slice(0, 8)
    .map(({ instancePath, message }) => `${instancePath || "/"} ${message ?? "is invalid"}`)
    .join("; ")
    .slice(0, 1000);
  throw new TypeError(`${id}${id.endsWith("-v2") ? "" : "/v1"} validation failed: ${problems}`);
}

export function assertConsumerIntegrationProfileSchema(value: unknown): Promise<void> {
  const version = typeof value === "object" && value !== null && "schemaVersion" in value
    ? (value as { readonly schemaVersion?: unknown }).schemaVersion
    : undefined;
  return assertSchema(version === 2 ? "docs-consumer-integration-profile-v2" : "docs-consumer-integration-profile", value);
}

export function assertConsumerIntegrationExecutionSchema(value: unknown): Promise<void> {
  return assertSchema("docs-consumer-integration-execution", value);
}

export function assertConsumerUpgradeExecutionSchema(value: unknown): Promise<void> {
  return assertSchema("docs-consumer-upgrade-execution", value);
}
