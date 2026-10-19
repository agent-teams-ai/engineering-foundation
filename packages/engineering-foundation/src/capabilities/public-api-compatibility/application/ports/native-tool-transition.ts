import type { MigrationDigest } from '../model/native-tool-transition.js';
/** Content equality/hashing and bounded regular-file IO are selected by the host.
 * A missing file is returned only for ENOENT; all other path failures reject. */
export interface NativeTransitionContent {
  readonly bytes: (value: unknown) => Uint8Array;
  readonly digest: (bytes: Uint8Array) => MigrationDigest;
  readonly same: (left: unknown, right: unknown) => boolean;
  readonly read: (root: string, path: string) => Promise<Uint8Array | undefined>;
}
