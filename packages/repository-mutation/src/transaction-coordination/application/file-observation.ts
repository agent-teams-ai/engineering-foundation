import type { PortablePathIdentity } from "../../path-identity.js";

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

export interface TerminalEvidenceDirectoryAuthority {
  readonly identity: PortablePathIdentity;
  readonly path: string;
}
