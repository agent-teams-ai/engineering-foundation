import type { GrowthAuthorityPackedEvidence } from "../model/growth-authority.js";
import type { ChangeFingerprint } from "../ports/change-fingerprint.js";
import { exact, invalid } from "./validate-growth-authority-primitives.js";

/** Compare independently read installation bytes with the validated archive. */
export function validateGrowthInstalledInventory(packed: GrowthAuthorityPackedEvidence,
  inventory: readonly { readonly path: string; readonly bytes: Uint8Array }[] | undefined, fingerprint: ChangeFingerprint): void {
  if (inventory === undefined) { invalid("growth-authority-installed-inventory-unavailable"); }
  const observed = inventory.map((file) => ({ path: file.path,
    digest: `sha256:${fingerprint.sha256(file.bytes)}` })).toSorted((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  exact(observed, packed.custodyEvidence.archiveManifest, "growth-authority-installed-inventory-mismatch");
}
