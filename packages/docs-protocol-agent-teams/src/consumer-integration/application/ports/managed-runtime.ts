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
interface RuntimeObservation {
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
