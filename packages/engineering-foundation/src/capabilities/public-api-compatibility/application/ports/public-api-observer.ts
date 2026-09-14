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
/** Mutable counters owned by one audit invocation, never by a shared adapter. */
export interface AuditInputBudget { bytes: number; files: number }
export interface PublicApiAuditInputs {
  load(consumerRoot: string, configPath: string): Promise<{ readonly request: PublicApiAuditRequest; readonly digest: string }>;
  baseline(consumerRoot: string, input: PublicApiAuditRequest["subjects"]["B"]["baselines"][number], budget: AuditInputBudget): Promise<PublicApiSnapshot>;
  revalidate(consumerRoot: string, request: PublicApiAuditRequest): Promise<void>;
}
