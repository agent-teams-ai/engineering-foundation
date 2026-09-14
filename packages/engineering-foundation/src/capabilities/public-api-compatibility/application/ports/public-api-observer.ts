import type { AuditDeclarationInput, PublicApiAuditRequest } from "../../contract/public-api-audit.js";
import type { AuditObservation, AuditSubject } from "../model/public-api-observation.js";
import type { PublicApiSnapshot } from "../model/public-api.js";

export interface PublicApiObserver {
  observe(input: {
    readonly consumerRoot: string;
    readonly subject: AuditSubject;
    readonly declarations: AuditDeclarationInput;
    readonly signal?: AbortSignal;
  }): Promise<readonly AuditObservation[]>;
}
/** Monotonic reservations owned by one audit invocation, including failed reads. */
export interface AuditInputBudget { bytes: number; files: number }
/** Requires a caller-frozen input namespace (including ancestors) for the whole
 * invocation. Digests authenticate supplied content, not filesystem containment
 * against concurrent writers. Revalidation is best-effort mutation detection.
 */
export interface PublicApiAuditInputs {
  load(consumerRoot: string, configPath: string): Promise<{ readonly request: PublicApiAuditRequest; readonly digest: string }>;
  baseline(consumerRoot: string, input: PublicApiAuditRequest["subjects"]["B"]["baselines"][number], budget: AuditInputBudget): Promise<PublicApiSnapshot>;
  revalidate(consumerRoot: string, request: PublicApiAuditRequest): Promise<void>;
}
