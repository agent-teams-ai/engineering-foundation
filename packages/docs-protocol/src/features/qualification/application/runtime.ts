import { createHash } from "node:crypto";
import type { DocsFindQuery, DocsNewRequest } from "../../portable-documentation/application.js";

export function digest(value: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function requireSuccess(label: string, execution: { readonly envelope?: unknown; readonly exitCode: number }): void {
  if (execution.exitCode !== 0) {
    throw new Error(`Docs Protocol qualification ${label} failed with exit code ${execution.exitCode}: ${JSON.stringify(execution.envelope ?? {})}.`);
  }
}

export function documentResult(execution: { readonly envelope: { readonly result: unknown }; readonly exitCode: number }): {
  readonly documentPath: string;
  readonly planDigest: string;
  readonly compiled?: { readonly document?: { readonly content?: string; readonly digest?: string } };
  readonly receiptDigest?: string;
  readonly reachability: unknown;
} {
  requireSuccess("document", execution);
  const result = execution.envelope.result as Record<string, unknown>;
  if (typeof result["documentPath"] !== "string" || typeof result["planDigest"] !== "string" || !("reachability" in result)) {
    throw new Error("Docs Protocol qualification expected a successful document result.");
  }
  return {
    documentPath: result["documentPath"],
    planDigest: result["planDigest"],
    ...((typeof result["compiled"] === "object" && result["compiled"] !== null) ? { compiled: result["compiled"] } : {}),
    ...(typeof result["receiptDigest"] === "string" ? { receiptDigest: result["receiptDigest"] } : {}),
    reachability: result["reachability"]
  };
}


export interface PortableQualificationProtocol {
  readonly checkV2: (input: {
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly signal?: AbortSignal;
  }) => Promise<{
    readonly envelope: { readonly result: { readonly kind: "check" } };
    readonly exitCode: 0 | 1 | 2 | 3 | 130;
  }>;
  readonly doctorV2: (input: {
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly signal?: AbortSignal;
  }) => Promise<{
    readonly envelope: {
      readonly outcome:
        | "authority-stale"
        | "cancelled"
        | "conflict"
        | "execution-failure"
        | "invalid-input"
        | "recovery-required"
        | "success"
        | "violation";
      readonly result: {
        readonly environment: {
          readonly installedFoundationBuildIdentity: string;
          readonly installedFoundationVersion: string;
        };
        readonly kind: "doctor";
        readonly transaction:
          | { readonly state: "idle" }
          | { readonly state: "recoverable" }
          | { readonly state: "manual-recovery-required" };
      };
    };
    readonly exitCode: 0 | 1 | 2 | 3 | 130;
  }>;
  readonly findV2: (input: {
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly query: DocsFindQuery;
    readonly signal?: AbortSignal;
  }) => Promise<{
    readonly envelope: {
      readonly result: {
        readonly kind: "find";
        readonly documents: readonly { readonly id: string }[];
      };
    };
    readonly exitCode: 0 | 1 | 2 | 3 | 130;
  }>;
  readonly infoV2: (input: {
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly signal?: AbortSignal;
  }) => Promise<{
    readonly envelope: {
      readonly result: {
        readonly kind: "info";
        readonly projectId: string;
        readonly types: readonly { readonly type: string }[];
      };
    };
    readonly exitCode: 0 | 1 | 2 | 3 | 130;
  }>;
  readonly newDocumentV2: (input: DocsNewRequest) => Promise<{
    readonly envelope: { readonly result: { readonly kind?: "new" } };
    readonly exitCode: 0 | 1 | 2 | 3 | 130;
  }>;
  readonly recoverV2: (input: {
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly signal?: AbortSignal;
  }) => Promise<{
    readonly envelope: {
      readonly result:
        | {
            readonly kind: "recover";
            readonly transactionState: "no-pending-transaction";
            readonly writeState: "unchanged";
          }
        | {
            readonly kind: "recover";
            readonly transactionState: "manual-required";
            readonly writeState: "unknown";
          }
        | {
            readonly kind: "recover";
            readonly transactionState: "recovered" | "recovery-required";
            readonly writeState: "committed" | "published-recovery-required" | "unchanged" | "unknown";
            readonly receiptDigest: `sha256:${string}`;
            readonly receipt: {
              readonly commit: {
                readonly publication: "none" | "preexisting-exact" | "published" | "unknown";
                readonly state: "committed" | "manual-recovery-required" | "not-published" | "recovery-required";
              };
              readonly directoryMaterialization?: {
                readonly observedCreatedDirectories: readonly string[];
                readonly state: "none-created" | "created-and-retained" | "preserved-unknown";
              };
              readonly outcome:
                | "applied"
                | "already-applied"
                | "authority-stale"
                | "cancelled"
                | "failed-before-publication"
                | "manual-recovery-required"
                | "recovery-required"
                | "rejected";
            };
          };
    };
    readonly exitCode: 0 | 1 | 2 | 3 | 130;
  }>;
}

export function signalOption(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}
