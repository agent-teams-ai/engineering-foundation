import type { PublicApiItem } from "../model/public-api.js";

/** A syntax-only proof. Absence or inability to prove never relaxes comparison. */
export interface PublicApiSignatureEquivalence {
  readonly equivalent: (
    released: PublicApiItem,
    current: PublicApiItem,
    extractorVersions: { readonly released: string; readonly current: string },
  ) => Promise<boolean>;
}
