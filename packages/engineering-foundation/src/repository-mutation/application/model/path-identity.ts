export interface PortablePathIdentity {
  readonly birthtimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
}

export type PathIdentityMatch = "different" | "match" | "missing";
