import type { GrowthCancellation, GrowthDigest } from "../model/growth-observation.js";
export type { GrowthDigest } from "../model/growth-observation.js";

/** One replaceable report slot, not a release baseline or authority receipt.
 * The writer observes and fences the preimage when caller CAS is omitted.
 * Explicit null requires an absent slot; a digest requires those bytes.
 * Identical bytes replay successfully even with a stale caller preimage. */
export interface GrowthReportWriter {
  write(request: {
    readonly path: string;
    readonly contents: string;
    readonly expectedPreimage?: GrowthDigest | null;
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
