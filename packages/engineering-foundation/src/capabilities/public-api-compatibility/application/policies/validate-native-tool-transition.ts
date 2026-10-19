import type { PublicApiCompatibilityPolicy } from '../model/public-api.js';
import { publicApiBaselineAnchorPath } from '../model/public-api.js';
import { nativeTransitionError as fail, nativeMigrationFrom, nativeMigrationTo, nativeMigrationToolDifference, type NativeMigrationReview, type NativeMigrationObservation } from '../model/native-tool-transition.js';
import type { NativeTransitionContent } from '../ports/native-tool-transition.js';
const operation = 'foundation:public-api-native-migration:review:1';
const hashPattern = /^sha256:[a-f0-9]{64}$/u;
function assertPackageReview(row: NativeMigrationObservation['packages'][number], pin: NativeMigrationReview['packages'][number], policy: PublicApiCompatibilityPolicy['packages'][number], content: NativeTransitionContent): void {
  if (!content.same(Object.keys(pin).toSorted(), ['packageName', 'baselinePath', 'baselineDigest', 'archiveDigest', 'archiveIntegrity', 'configDigest', 'releasedInputsDigest', 'nativeReleasedDigest'].toSorted())) { fail('unknown migration package review field'); }
  if (pin.baselinePath !== publicApiBaselineAnchorPath(policy.packageName) || pin.baselinePath !== policy.releasedBaselinePath) { fail('baseline anchor differs from reviewed migration'); }
  for (const key of ['baselineDigest', 'archiveDigest', 'configDigest', 'releasedInputsDigest', 'nativeReleasedDigest'] as const) {
    if (!hashPattern.test(pin[key]) || pin[key] !== row[key]) { fail(`reviewed ${key} differs for ${policy.packageName}`); }
  }
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/u.test(pin.archiveIntegrity) || pin.archiveIntegrity !== row.archiveIntegrity || row.nativeReleasedDigest !== content.digest(content.bytes(row.nativeReleased))) { fail('released archive/snapshot identity differs'); }
  if (row.nativeCandidate.extractorVersion !== nativeMigrationTo || row.nativeCandidate.packageName !== policy.packageName) { fail('candidate is not the native observation of the governed package'); }
}

/** Content review only. The existing trusted release operator owns write authority;
 * neither this object nor a successful local report is an authorization grant. */
export function assertNativeMigrationReview(observation: NativeMigrationObservation, review: NativeMigrationReview, policy: PublicApiCompatibilityPolicy, content: NativeTransitionContent): void {
  if (!content.same(Object.keys(review).toSorted(), ['kind', 'from', 'to', 'baselineSourceCommit', 'policyDigest', 'toolDiffDigest', 'packages'].toSorted())) {fail('unknown migration review field');}
  if (!content.same([review.kind, review.from, review.to], [operation, nativeMigrationFrom, nativeMigrationTo]) || !/^[a-f0-9]{40}$/u.test(review.baselineSourceCommit)) {fail('unsupported named migration');}
  const packageNames = policy.packages.map(x => x.packageName).toSorted();
  if (packageNames.length === 0 || new Set(packageNames).size !== packageNames.length) { fail('the complete unique governed package inventory is required'); }
  for (const names of [observation.packages.map(x => x.packageName), review.packages.map(x => x.packageName)]) {
    if (!content.same(names.toSorted(), packageNames)) { fail('the complete governed package inventory is required'); }
  }
  if (observation.policyDigest !== content.digest(content.bytes(policy)) || review.policyDigest !== observation.policyDigest) {fail('policy differs from reviewed migration');}
  const actualDiff = nativeMigrationToolDifference(observation.packages);
  if (!content.same(actualDiff, observation.toolDiff) || content.digest(content.bytes(actualDiff)) !== observation.toolDiffDigest || review.toolDiffDigest !== observation.toolDiffDigest) {fail('entire tool difference differs from reviewed bytes');}
  for (const p of policy.packages) {
    const row = observation.packages.find(x => x.packageName === p.packageName)!;
    const pin = review.packages.find(x => x.packageName === p.packageName)!;
    assertPackageReview(row, pin, p, content);
  }
}
