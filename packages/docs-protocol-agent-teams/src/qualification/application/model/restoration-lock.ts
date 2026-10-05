/** Independently selected byte bindings; these are not permissions or verified facts. */
export interface ManagedRestorationArchiveBindingV1 {
  readonly sha256: string;
  readonly manifestSha256: string;
  readonly manifestPath: string;
}

export interface ManagedRestorationSelectionV1 {
  readonly originalClosureSha256: string;
  readonly sourceLockSha256: string;
  readonly sourceLockBlob: string;
  readonly archives: Readonly<Record<string, ManagedRestorationArchiveBindingV1>>;
}

export interface ManagedRestorationLockV1Request {
  readonly schemaVersion: 1;
  readonly selection: ManagedRestorationSelectionV1;
  readonly originalClosureBytes: Readonly<Uint8Array>;
  readonly sourceLockBytes: Readonly<Uint8Array>;
  readonly actualLockBytes: Readonly<Uint8Array>;
  readonly archiveBytes: Readonly<Record<string, Readonly<Uint8Array>>>;
}

export interface ManagedRestorationLockV1Diagnostic {
  readonly code: 'input' | 'derivation' | 'mismatch' | 'preservation';
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export interface ManagedRestorationLockV1Provenance {
  readonly originalClosureSha256: string;
  readonly originalPackageManager: 'pnpm@11.20.0';
  readonly sourceLockSha256: string;
  readonly sourceLockBlob: string;
  readonly archives: Readonly<Record<string, ManagedRestorationArchiveBindingV1>>;
  readonly originalSnapshotCount: number;
  readonly managedSnapshotCount: number;
  readonly foreignOnlySnapshotCount: number;
  readonly wholeSnapshotCount: number;
  readonly contextLocators: readonly string[];
  readonly borrowedCoordinates: readonly string[];
  readonly removedSourceCoordinates: readonly string[];
}

/** Conformance evidence only. This result carries no Cohort or restoration authority. */
export type ManagedRestorationLockV1Result = {
  readonly schemaVersion: 1;
} & (
  | {
    readonly conformance: 'conformant';
    /** SHA-256 of domain-separated, recursively key-sorted typed JSON, not YAML bytes. */
    readonly expectedLockDigest: `sha256:${string}`;
    readonly provenance: ManagedRestorationLockV1Provenance;
    readonly diagnostics: readonly [];
  }
  | {
    readonly conformance: 'nonconformant';
    readonly expectedLockDigest?: `sha256:${string}`;
    readonly provenance?: ManagedRestorationLockV1Provenance;
    readonly diagnostics: readonly ManagedRestorationLockV1Diagnostic[];
  }
);

export type ManagedRestorationLockV1 = ManagedRestorationLockV1Request;
