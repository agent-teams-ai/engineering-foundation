import type { GrowthCancellation, GrowthDigest } from "../model/growth-observation.js";
export type { GrowthDigest } from "../model/growth-observation.js";

/** One replaceable report slot, not a release baseline or authority receipt.
 * Callers retain the expected preimage across retries. Identical bytes replay
 * successfully even if that expected preimage is now stale. */
export interface GrowthReportWriter {
  write(request: {
    readonly path: string;
    readonly contents: string;
    readonly expectedPreimage: GrowthDigest | null;
  }, cancellation: GrowthCancellation): Promise<{
    readonly status: "published" | "replayed";
    readonly digest: GrowthDigest;
  }>;
}

export class GrowthReportWriteError extends Error {
  constructor(readonly kind: "conflict" | "io" | "uncertain", readonly reason: string, options?: ErrorOptions) {
    super(reason, options);
    this.name = "GrowthReportWriteError";
  }
}
