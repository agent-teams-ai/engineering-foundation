import type { FileHandle, mkdir } from "node:fs/promises";
import type { PortablePathIdentity, PathIdentityMatch } from "../../../path-identity.js";
import type { KnownFileMutationPort } from "../../application/ports/known-file-mutation.js";
import type {
  KnownFileObservationPort, KnownFileTerminalDirectory
} from "../../application/ports/known-file-observation.js";

/** Exact physical capabilities selected by module composition for file operations. */
export interface KnownFileCoordination extends KnownFileMutationPort, KnownFileObservationPort {
  readonly readBoundedRegularFileHandle: (handle: FileHandle, path: string, maximumBytes: number) => ReturnType<KnownFileObservationPort["readBoundedRegularFile"]>;
  readonly captureFileHandleIdentity: (handle: FileHandle) => Promise<PortablePathIdentity>;
  readonly pathMatchesRegularFileIdentity: (path: string, expected: PortablePathIdentity) => Promise<PathIdentityMatch>;
  readonly ensureTerminalEvidenceDirectory: (path: string, overrides?: { readonly mkdir?: typeof mkdir }) => Promise<KnownFileTerminalDirectory>;
  readonly ensureMutationStateDirectory: (root: string) => Promise<string>;
  readonly pruneMutationStateDirectory: (root: string) => Promise<void>;
}

// Released Node/qualification callbacks bind this exact exported type symbol.
export type { BoundedRegularFileRead } from "../../../path-identity.js";
