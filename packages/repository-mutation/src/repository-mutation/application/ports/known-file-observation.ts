import type { PortablePathIdentity } from "../../../path-identity.js";
import type { BoundedRegularFileRead } from "../../../transaction-coordination/application-api.js";

export interface KnownFileTerminalDirectory {
  readonly identity: PortablePathIdentity;
  readonly path: string;
}

export interface KnownFileObservationPort {
  readonly readBoundedRegularFile: (path: string, maximumBytes: number) => Promise<BoundedRegularFileRead>;
  readonly assertTerminalEvidenceDirectory: (authority: KnownFileTerminalDirectory) => Promise<void>;
}
