import { FilesystemPublicApiAuditInputs } from "../../outbound/filesystem/public-api-audit-inputs.js";
import { MicrosoftPublicApiObserver } from "../../outbound/api-extractor/microsoft-public-api-observer.js";
import { NodeChangeFingerprint } from "../../outbound/crypto/node-change-fingerprint.js";
import { auditPublicApi } from "../../../application/use-cases/audit-public-api.js";

export type PublicApiAuditSchemaAssertion = (schemaId: "package-public-api-audit-request/v1" | "package-public-api-audit-report/v1" | "package-public-api-baseline/v1", input: unknown, phase: string) => Promise<void>;
export async function runPublicApiAudit(input: Parameters<typeof auditPublicApi>[0], assertSchema: PublicApiAuditSchemaAssertion) {
  const report = await auditPublicApi(input, {
    inputs: new FilesystemPublicApiAuditInputs(
      (request) => assertSchema("package-public-api-audit-request/v1", request, "public-api-audit"),
      (baseline) => assertSchema("package-public-api-baseline/v1", baseline, "public-api-audit")
    ),
    observer: new MicrosoftPublicApiObserver(), fingerprint: new NodeChangeFingerprint()
  });
  await assertSchema("package-public-api-audit-report/v1", report, "public-api-audit");
  return report;
}
