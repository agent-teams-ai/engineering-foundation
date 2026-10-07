/** Private managed-runtime observation contract. Observations are evidence, never execution authority. */
export interface RuntimeTuple {
  readonly nodeVersion: string;
  readonly pnpmVersion: string;
  readonly platform: "linux" | "macos" | "windows";
  readonly architecture: "x64" | "arm64";
}
export interface ManagedRuntimeHandle { readonly kind: "managed-runtime-handle" }
export interface RuntimeFileIdentity {
  readonly realpath: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mode: number;
  readonly device: string;
  readonly inode: string;
  readonly birthtimeNs: string;
  readonly ctimeNs: string;
  readonly mtimeNs: string;
}
export interface RuntimeObservation {
  readonly kind: "managed-runtime-observation";
  readonly tuple: RuntimeTuple;
  readonly node: RuntimeFileIdentity;
  readonly pnpm: {
    readonly manifest: RuntimeFileIdentity;
    readonly entry: RuntimeFileIdentity;
    readonly packageTreeDigest: string;
  };
  readonly launcher: { readonly kind: "direct-node" };
  readonly containment: "cooperative-posix-process-group";
}
export type RuntimeRefusalCode = "invalid-selection" | "unsupported-platform" |
  "unsupported-launcher" | "runtime-mismatch" | "identity-changed" | "spawn-failed" |
  "cancelled" | "deadline" | "output-limit" | "invalid-output" |
  "process-failed" | "cleanup-failed" | "liveness-uncertain";
export interface ProcessFacts {
  readonly spawned: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly cancelled: boolean;
  readonly timedOut: boolean;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly directChild: "not-started" | "reaped" | "unconfirmed";
  readonly group: "not-started" | "empty-observed" | "unconfirmed";
  readonly streams: "not-started" | "closed" | "unconfirmed";
}
export interface RuntimeDebt {
  readonly code: "cleanup-failed" | "liveness-uncertain";
  readonly attemptId: string;
  readonly evidencePath: string | null;
  readonly facts: ProcessFacts;
}
export type RuntimeObservationResult =
  | { readonly outcome: "observed"; readonly observation: RuntimeObservation; readonly facts: ProcessFacts }
  | { readonly outcome: "refused"; readonly code: RuntimeRefusalCode; readonly facts: ProcessFacts; readonly debt: RuntimeDebt | null };
export interface ManagedRuntimeObservationPort {
  observe(input: { readonly runtime: ManagedRuntimeHandle; readonly expected: RuntimeTuple;
    readonly signal: AbortSignal }): Promise<RuntimeObservationResult>;
}

/** Source-private contracts; physical custody and settlement remain Host effects. */
export interface ManagedAttemptInput {
  /** Host must supply the same physical external namespace to every contender for a consumer. */
  readonly externalRoot: string;
  /** Exclusion within that namespace is keyed by the consumer directory's device and inode. */
  readonly consumerRoot: string;
  readonly controllerBuildDigest: string;
  readonly role: "source" | "target";
  readonly runtime: ManagedRuntimeHandle;
  readonly signal: AbortSignal;
  readonly preparationDigest?: string;
}
export type ManagedAttemptClose =
  | { readonly outcome: "closed" }
  | { readonly outcome: "debt"; readonly debt: RuntimeDebt };
export interface ManagedRuntimeAttemptHandle {
  readonly ["token"]: string;
  readonly evidencePath: string;
  readonly ownedRoot: string;
  close(): Promise<ManagedAttemptClose>;
}
export type AttemptAcquisition =
  | { readonly outcome: "acquired"; readonly attempt: ManagedRuntimeAttemptHandle }
  | { readonly outcome: "refused"; readonly code: RuntimeRefusalCode; readonly debt: RuntimeDebt | null };
export interface OwnedInstallationRoot {
  readonly kind: "managed-owned-installation-root";
}
export interface ManagedPnpmInstallInput {
  readonly root: OwnedInstallationRoot;
  readonly runtime: ManagedRuntimeHandle;
  readonly mode: "prepare" | "frozen-offline";
  readonly expectedManifestDigest: string;
  readonly expectedWorkspaceDigest: string;
  readonly expectedLockDigest: string | null;
  readonly signal: AbortSignal;
}
export type ManagedPnpmInstallResult =
  | { readonly outcome: "installed"; readonly facts: ProcessFacts;
      readonly runtime: RuntimeObservation; readonly lockDigest: string;
      readonly virtualStoreLockDigest: string }
  | { readonly outcome: "refused"; readonly code: RuntimeRefusalCode;
      readonly facts: ProcessFacts; readonly debt: RuntimeDebt | null;
      readonly diagnosticTailBase64?: string };
