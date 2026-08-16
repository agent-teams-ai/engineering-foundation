import { readFile } from "node:fs/promises";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

const validators = new Map<string, Promise<ValidateFunction>>();

async function validator(
  id: "docs-consumer-integration-execution" | "docs-consumer-integration-profile"
): Promise<ValidateFunction> {
  const existing = validators.get(id);
  if (existing !== undefined) {return existing;}
  const loading = (async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    if (id === "docs-consumer-integration-profile") {
      const cohortUrl = new URL(
        "../../../schemas/qualified-docs-cohort/v1.schema.json",
        import.meta.url
      );
      ajv.addSchema(JSON.parse(await readFile(cohortUrl, "utf8")) as object);
    }
    if (id === "docs-consumer-integration-execution") {
      const [plan, mutationPlan, mutationReceipt] = await Promise.all([
        readFile(new URL(
          "../../../schemas/docs-consumer-integration-plan/v1.schema.json",
          import.meta.url
        ), "utf8"),
        readFile(new URL(
          "../../../../engineering-foundation/schemas/known-file-transaction-plan/v1.schema.json",
          import.meta.url
        ), "utf8"),
        readFile(new URL(
          "../../../../engineering-foundation/schemas/known-file-transaction-receipt/v1.schema.json",
          import.meta.url
        ), "utf8")
      ]);
      ajv.addSchema(JSON.parse(plan) as object);
      ajv.addSchema(JSON.parse(mutationPlan) as object);
      ajv.addSchema(JSON.parse(mutationReceipt) as object);
    }
    const schemaUrl = new URL(`../../../schemas/${id}/v1.schema.json`, import.meta.url);
    return ajv.compile(JSON.parse(await readFile(schemaUrl, "utf8")) as object);
  })();
  validators.set(id, loading);
  return loading;
}

async function assertSchema(
  id: "docs-consumer-integration-execution" | "docs-consumer-integration-profile",
  value: unknown
): Promise<void> {
  const validate = await validator(id);
  if (validate(value)) {return;}
  const problems = (validate.errors ?? [])
    .slice(0, 8)
    .map(({ instancePath, message }) => `${instancePath || "/"} ${message ?? "is invalid"}`)
    .join("; ")
    .slice(0, 1000);
  throw new TypeError(`${id}/v1 validation failed: ${problems}`);
}

export function assertConsumerIntegrationProfileSchema(value: unknown): Promise<void> {
  return assertSchema("docs-consumer-integration-profile", value);
}

export function assertConsumerIntegrationExecutionSchema(value: unknown): Promise<void> {
  return assertSchema("docs-consumer-integration-execution", value);
}
