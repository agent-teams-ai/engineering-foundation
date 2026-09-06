import type { PortablePathIdentity } from "../../path-identity.js";


export interface TerminalEvidenceDirectoryAuthority {
  readonly identity: PortablePathIdentity;
  readonly path: string;
}
