import type { AuditFileIdentity } from "../../contract/public-api-audit.js";
export type { AuditFileIdentity } from "../../contract/public-api-audit.js";
import type { PublicApiSnapshot } from "./public-api.js";

export const PUBLIC_API_AUDIT_PROFILE = "foundation:public-api-audit:declaration-graph:1";
export type AuditSubject = "A" | "C";
export interface AuditIdentity {
  readonly subject: AuditSubject;
  readonly packageName: string;
  readonly exportPath: string;
  readonly canonicalReference: string;
}
export interface AuditDiagnostic {
  readonly source: "compiler" | "extractor" | "input";
  readonly id: string;
  readonly severity: string;
  readonly text: string;
  readonly file?: string;
  readonly line?: number;
}
export interface AuditReference {
  readonly text: string;
  readonly canonicalReference: string | null;
  readonly resolution: "local" | "same-subject-dependency" | "verified-external-library" | "unresolved" | "ambiguous";
  readonly target?: AuditIdentity;
  readonly library?: { readonly symbol: string; readonly declarations: readonly string[] };
}
export interface AuditDeclaration {
  readonly displayName: string;
  readonly identity: AuditIdentity;
  readonly kind: string;
  readonly parentReference: string;
  readonly parentKind: string;
  readonly excerpt: string;
  /** Relative to the modeled container; null means the mixin does not apply. */
  readonly isExported: boolean | null;
  readonly public: boolean;
  readonly references: readonly AuditReference[];
}
export interface AuditObservation {
  readonly subject: AuditSubject;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly exportPath: string | null;
  readonly modelExpected: boolean;
  readonly toolchain: string;
  readonly normalizationProfile: typeof PUBLIC_API_AUDIT_PROFILE;
  readonly compilerEnvironment: string;
  readonly compilerOptions: Readonly<Record<string, unknown>>;
  readonly configurationDependencies: readonly AuditFileIdentity[];
  readonly sourceFiles: readonly AuditFileIdentity[];
  readonly externalDeclarations: readonly AuditFileIdentity[];
  readonly diagnostics: readonly AuditDiagnostic[];
  readonly compilerDiagnosticsCollected: boolean;
  readonly invocation: {
    readonly outcome: "completed" | "exception" | "not-invoked";
    readonly succeeded: boolean;
    readonly errorCount: number | null;
    readonly warningCount: number | null;
    readonly exception?: string;
  };
  readonly modelPresent: boolean;
  readonly modelDigest?: string;
  readonly items: readonly AuditDeclaration[];
  readonly inputBytesRevalidated: boolean;
  readonly unsupported: readonly string[];
  /** Historical field vocabulary mapped from observed public items; no reconstructed B graph. */
  readonly storedSurface?: PublicApiSnapshot;
}
export function auditIdentityKey(identity: AuditIdentity): string {
  return JSON.stringify([identity.subject, identity.packageName, identity.exportPath, identity.canonicalReference]);
}
