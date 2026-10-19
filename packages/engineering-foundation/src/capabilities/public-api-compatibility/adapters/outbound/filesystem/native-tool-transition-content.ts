import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { publicApiFileFailure } from '../../../application/policies/public-api-evidence-errors.js';
import type { PublicApiSourceEvidence } from '../../../application/ports/public-api-evidence.js';
import type { PublicApiCompatibilityPolicy } from '../../../application/model/public-api.js';
import type { NativeTransitionContent } from '../../../application/ports/native-tool-transition.js';
import { nativeTransitionError as fail, type NativeMigrationObservation, type NativeMigrationReview, type MigrationDigest } from '../../../application/model/native-tool-transition.js';
export const migrationBytes = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export const migrationDigest = (bytes: Uint8Array): MigrationDigest => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export function createNativeTransitionContent(evidence: PublicApiSourceEvidence): NativeTransitionContent { return Object.freeze({
 bytes: migrationBytes, digest: migrationDigest, same: isDeepStrictEqual,
 async read(root: string, path: string) {
  try { return await evidence.files.read({root, candidate: join(root, path), maxBytes: 32 * 1024 * 1024}); }
  catch(error) { if (publicApiFileFailure(error) === 'missing') { return; } throw error; }
 }
}); }

export async function assertPhysicalNativeBaselines(input: { readonly consumerRoot: string; readonly policy: PublicApiCompatibilityPolicy; readonly review: NativeMigrationReview; readonly observation?: NativeMigrationObservation }, content: NativeTransitionContent): Promise<void> {
 for (const p of input.policy.packages) {
  const pin = input.review.packages.find(row => row.packageName === p.packageName);
  if (pin === undefined) { fail('physical baseline is outside the reviewed inventory'); }
  const bytes = await content.read(input.consumerRoot, p.releasedBaselinePath);
  if (bytes === undefined) { fail('physical baseline is missing'); }
  const postimage = input.observation?.packages.find(row => row.packageName === p.packageName)?.nativeCandidate;
  if (migrationDigest(bytes) !== pin.baselineDigest && (postimage === undefined || !Buffer.from(bytes).equals(migrationBytes(postimage)))) { fail(`physical baseline differs from exact B or exact postimage: ${p.packageName}`); }
 }
}
