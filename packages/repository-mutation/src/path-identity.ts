export interface PortablePathIdentity {
  readonly birthtimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
}

export type PathIdentityMatch = "different" | "match" | "missing";

export type BoundedRegularFileRead =
  | {
      readonly outcome: "read";
      readonly bytes: Buffer;
      readonly identity: PortablePathIdentity;
      readonly linkCount: bigint;
      readonly mode: number;
    }
  | { readonly outcome: "changed" }
  | { readonly outcome: "invalid" };
