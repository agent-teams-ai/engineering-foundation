import type { SourceCensusReader } from "../../../capabilities/source-dependencies/api.js";
import type { WorkspaceInventoryReader } from "../../../workspace-inventory/api.js";
import type { QualitySourceAuthority } from "./profile.js";

/** Existing owners supply validated policy facts; quality does not parse their contracts. */
interface QualityAuthorityReader {
  source(consumerRoot: string, path: string, signal?: AbortSignal): Promise<QualitySourceAuthority>;
  suppressions(consumerRoot: string, path: string, signal?: AbortSignal): Promise<{
    readonly governedRoots: readonly string[];
  }>;
}

export interface QualityObservationPorts {
  readonly census: SourceCensusReader;
  readonly inventory: WorkspaceInventoryReader;
  readonly authority: QualityAuthorityReader;
}
