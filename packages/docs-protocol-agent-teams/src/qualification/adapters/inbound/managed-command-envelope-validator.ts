import { readFile } from "node:fs/promises";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import type { DocsCommandOutcome, DocsDiagnostic } from "@agent-teams/docs-protocol";

export interface ManagedQualificationEnvelope<Result = unknown> {
  readonly schemaVersion: 2;
  readonly protocol: {
    readonly id: "agent-teams.docs-protocol";
    readonly version: 1;
  };
  readonly command: "docs.qualify";
  readonly outcome: DocsCommandOutcome;
  readonly diagnostics: readonly DocsDiagnostic[];
  readonly result: Result;
}

let validatorPromise: Promise<ValidateFunction> | undefined;

async function validator(): Promise<ValidateFunction> {
  if (validatorPromise !== undefined) {return validatorPromise;}
  validatorPromise = (async () => {
    const [envelopeSource, receiptSource, integrationSource] = await Promise.all([
      readFile(new URL("../../../../schemas/docs-protocol-command-envelope/v2.schema.json", import.meta.url), "utf8"),
      readFile(new URL("../../../../schemas/docs-protocol-qualification-receipt/v2.schema.json", import.meta.url), "utf8"),
      readFile(new URL("../../../../schemas/docs-consumer-integration-profile/v2.schema.json", import.meta.url), "utf8")
    ]);
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    ajv.addSchema(JSON.parse(integrationSource) as object);
    ajv.addSchema(JSON.parse(receiptSource) as object);
    return ajv.compile(JSON.parse(envelopeSource) as object);
  })();
  return validatorPromise;
}

export async function assertManagedQualificationEnvelopeSchema(value: unknown): Promise<void> {
  const validate = await validator();
  if (validate(value)) {return;}
  const problems = (validate.errors ?? [])
    .slice(0, 8)
    .map(({ instancePath, message }) => `${instancePath || "/"} ${message ?? "is invalid"}`)
    .join("; ")
    .slice(0, 1000);
  throw new TypeError(`Managed qualification output does not match its adapter schema: ${problems}`);
}
