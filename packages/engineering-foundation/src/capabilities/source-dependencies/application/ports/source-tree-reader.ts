import type { SourceFileSnapshot } from "../model/source-file-snapshot.js";

export interface SourceTreeReader {
  read(
    consumerRoot: string,
    governedRoots: readonly string[],
    signal?: AbortSignal
  ): Promise<readonly SourceFileSnapshot[]>;
}
