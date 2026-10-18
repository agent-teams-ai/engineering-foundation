import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { ContainedFileReadError, readContainedRegularFile } from '../packages/engineering-foundation/dist/source-inventory/node.js';
import { assertSchema } from '../packages/engineering-foundation/dist/schema-catalog.js';
import { PUBLIC_API_COMPATIBILITY_RULES } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/rules.js';
import { publicApiBaselineAnchorPath } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/public-api.js';
import { preflightPublicApiPromotions } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/use-cases/preflight-public-api-promotions.js';
import type { promotePublicApiBaselines } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/use-cases/promote-public-api-baselines.js';
import type { PublicApiRepository } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/ports/public-api-repository.js';
import type { FoundationCheckReport, FoundationDiagnostic } from '../packages/engineering-foundation/dist/features/validation-reporting/api.js';
import { migrationBytes, migrationDigest, nativeMigrationFrom, nativeMigrationTo, nativeMigrationPackageNames as packageNames, nativeMigrationToolDifference, type MigrationDigest, type NativeMigrationObservation } from './public-api-native-migration-observation.ts';
export { observeNativeMigration, migrationBytes, migrationDigest } from './public-api-native-migration-observation.ts';
export type { NativeMigrationObservation, NativeMigrationPackageInput, NativeMigrationPackageObservation, NativeMigrationToolDifference, MigrationDigest } from './public-api-native-migration-observation.ts';

const operation = 'foundation:public-api-native-migration:review:1';
const hashPattern = /^sha256:[a-f0-9]{64}$/u;
function fail(message: string): never { throw new Error(`Native public API migration: ${message}`); }
type PromotionDependencies = Parameters<typeof promotePublicApiBaselines>[1];
type Policy = Parameters<typeof promotePublicApiBaselines>[0]['policy'];
type WriteDescription = Awaited<ReturnType<PublicApiRepository['describeReleasedBaselineWrite']>>;

export interface NativeMigrationReview {
  readonly kind: typeof operation;
  readonly from: typeof nativeMigrationFrom;
  readonly to: typeof nativeMigrationTo;
  readonly baselineSourceCommit: string;
  readonly policyDigest: MigrationDigest;
  readonly toolDiffDigest: MigrationDigest;
  readonly packages: readonly {
    readonly packageName: string; readonly baselinePath: string;
    readonly baselineDigest: MigrationDigest; readonly archiveDigest: MigrationDigest;
    readonly archiveIntegrity: string; readonly configDigest: MigrationDigest;
    readonly releasedInputsDigest: MigrationDigest; readonly nativeReleasedDigest: MigrationDigest;
  }[];
}

function assertPackageReview(row: NativeMigrationObservation['packages'][number], pin: NativeMigrationReview['packages'][number], policy: Policy['packages'][number]): void {
  if (!isDeepStrictEqual(Object.keys(pin).toSorted(), ['packageName', 'baselinePath', 'baselineDigest', 'archiveDigest', 'archiveIntegrity', 'configDigest', 'releasedInputsDigest', 'nativeReleasedDigest'].toSorted())) { fail('unknown migration package review field'); }
  if (pin.baselinePath !== publicApiBaselineAnchorPath(policy.packageName) || pin.baselinePath !== policy.releasedBaselinePath) { fail('baseline anchor differs from reviewed migration'); }
  for (const key of ['baselineDigest', 'archiveDigest', 'configDigest', 'releasedInputsDigest', 'nativeReleasedDigest'] as const) {
    if (!hashPattern.test(pin[key]) || pin[key] !== row[key]) { fail(`reviewed ${key} differs for ${policy.packageName}`); }
  }
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/u.test(pin.archiveIntegrity) || pin.archiveIntegrity !== row.archiveIntegrity || row.nativeReleasedDigest !== migrationDigest(migrationBytes(row.nativeReleased))) { fail('released archive/snapshot identity differs'); }
  if (row.nativeCandidate.extractorVersion !== nativeMigrationTo || row.nativeCandidate.packageName !== policy.packageName) { fail('candidate is not the native observation of the governed package'); }
}

/** Content review only. The protected version workflow owns write authority;
 * neither this object nor a successful local report is an authorization grant. */
export function assertNativeMigrationReview(observation: NativeMigrationObservation, review: NativeMigrationReview, policy: Policy): void {
  if (!isDeepStrictEqual(Object.keys(review).toSorted(), ['kind', 'from', 'to', 'baselineSourceCommit', 'policyDigest', 'toolDiffDigest', 'packages'].toSorted())) {fail('unknown migration review field');}
  if (review.kind !== operation || review.from !== nativeMigrationFrom || review.to !== nativeMigrationTo || !/^[a-f0-9]{40}$/u.test(review.baselineSourceCommit)) {fail('unsupported named migration');}
  for (const names of [policy.packages.map(x => x.packageName), observation.packages.map(x => x.packageName), review.packages.map(x => x.packageName)]) {
    if (!isDeepStrictEqual(names.toSorted(), packageNames)) {fail('the complete closed eight-package inventory is required');}
  }
  if (observation.policyDigest !== migrationDigest(migrationBytes(policy)) || review.policyDigest !== observation.policyDigest) {fail('policy differs from reviewed migration');}
  const actualDiff = nativeMigrationToolDifference(observation.packages);
  if (!isDeepStrictEqual(actualDiff, observation.toolDiff) || migrationDigest(migrationBytes(actualDiff)) !== observation.toolDiffDigest || review.toolDiffDigest !== observation.toolDiffDigest) {fail('entire tool difference differs from reviewed bytes');}
  for (const p of policy.packages) {
    const row = observation.packages.find(x => x.packageName === p.packageName)!;
    const pin = review.packages.find(x => x.packageName === p.packageName)!;
    assertPackageReview(row, pin, p);
  }
}

function assertPublicApiMismatchCapability(capability: FoundationCheckReport['capabilities'][number], report: FoundationCheckReport, expectedDiagnostics: readonly FoundationDiagnostic[]): void {
  if (capability.outcome !== 'violations' || !isDeepStrictEqual(capability.summary, report.summary) || !isDeepStrictEqual(capability.diagnostics.toSorted((a, b) => a.subject.localeCompare(b.subject)), expectedDiagnostics.toSorted((a, b) => a.subject.localeCompare(b.subject)))) { fail('ordinary diagnostic shapes, subjects or paths differ'); }
}

export async function assertNativeMigrationOrdinaryReport(options: {
  readonly report: unknown; readonly exitCode: number;
  readonly observation: NativeMigrationObservation; readonly review: NativeMigrationReview; readonly policy: Policy;
  readonly expectedCapabilities: readonly { readonly capabilityId: string; readonly capabilityConfigSchemaVersion: number }[];
}): Promise<void> {
  const input = structuredClone(options);
  assertNativeMigrationReview(input.observation, input.review, input.policy);
  await assertNativeMigrationOrdinaryMismatchReport(input);
  if (input.observation.typedDiagnostics.length !== 0 || input.observation.artifactDiagnostics.length !== 0) {fail('native candidate compatibility is incomplete or rejected');}
}

/** Early negative admission only; it cannot qualify a migration without the
 * independent actual archive/candidate observation checked by the full assertion. */
export async function assertNativeMigrationOrdinaryMismatchReport(options: {
  readonly report: unknown; readonly exitCode: number; readonly policy: Policy;
  readonly expectedCapabilities: readonly { readonly capabilityId: string; readonly capabilityConfigSchemaVersion: number }[];
}): Promise<void> {
  const input = structuredClone(options);
  await assertSchema('foundation-check-report/v1', input.report, 'public-api-native-migration');
  const report = input.report as FoundationCheckReport;
  if (input.exitCode !== 1 || report.coverage !== 'full' || report.outcome !== 'violations' || report.problem !== undefined || !isDeepStrictEqual(report.summary, { errors: packageNames.length, warnings: 0, infos: 0 })) {fail('ordinary full report is not the exact retained mismatch result');}
  const expectedInventory = input.expectedCapabilities.toSorted((a, b) => a.capabilityId.localeCompare(b.capabilityId));
  const observedInventory = report.capabilities.map(({ capabilityId, capabilityConfigSchemaVersion }) => ({ capabilityId, capabilityConfigSchemaVersion })).toSorted((a, b) => a.capabilityId.localeCompare(b.capabilityId));
  if (expectedInventory.length === 0 || new Set(expectedInventory.map(x => x.capabilityId)).size !== expectedInventory.length || !isDeepStrictEqual(expectedInventory, observedInventory)) {fail('ordinary full capability inventory changed');}
  const rule = PUBLIC_API_COMPATIBILITY_RULES.baselineToolMismatch;
  const expectedDiagnostics: FoundationDiagnostic[] = input.policy.packages.map(p => ({ ruleId: rule.id, severity: rule.severity, subject: p.packageName, message: `Released baseline uses API Extractor ${nativeMigrationFrom}; current adapter uses ${nativeMigrationTo}.`, location: { path: p.releasedBaselinePath }, relatedLocations: [], evidence: [], remediation: rule.remediation, requiresArchitectureReview: rule.requiresArchitectureReview }));
  let foundPublicApi = false;
  for (const capability of report.capabilities) {
    if (capability.problem !== undefined) {fail('ordinary capability has an execution/input problem');}
    if (capability.capabilityId === 'package.public-api-compatibility') {
      foundPublicApi = true;
      assertPublicApiMismatchCapability(capability, report, expectedDiagnostics);
    } else if (capability.outcome !== 'passed' || capability.diagnostics.length !== 0 || !isDeepStrictEqual(capability.summary, { errors: 0, warnings: 0, infos: 0 })) {fail(`ordinary nonmigration diagnostic retained: ${capability.capabilityId}`);}
  }
  if (!foundPublicApi) {fail('native candidate compatibility is incomplete or rejected');}
}

export interface NativeMigrationPlan {
  readonly kind: 'foundation:public-api-native-migration:version-plan:1';
  readonly writes: readonly WriteDescription[];
  /** A local write operation, called only by the existing version workflow. */
  apply(): Promise<void>;
}

/** Reuse normal typed/artifact promotion policy with native A as the logical
 * released surface. The physical writer observes and caches actual B bytes.
 * Every package and both surfaces validate before the first mutation. */
export async function prepareNativeMigrationPromotion(options: {
  readonly consumerRoot: string; readonly policy: Policy; readonly observation: NativeMigrationObservation;
  readonly review: NativeMigrationReview; readonly signal?: AbortSignal;
}, dependencies: { readonly typed: PromotionDependencies; readonly artifacts: PromotionDependencies }): Promise<NativeMigrationPlan> {
  // Readonly types do not prevent a caller from mutating the original carrier
  // while an asynchronous read is pending. Keep one private authoritative view.
  const input = { consumerRoot: options.consumerRoot, policy: structuredClone(options.policy), observation: structuredClone(options.observation), review: structuredClone(options.review), ...(options.signal === undefined ? {} : { signal: options.signal }) };
  assertNativeMigrationReview(input.observation, input.review, input.policy);
  const actualTyped = dependencies.typed.repository;
  const physical = new Map<string, Buffer>();
  const pending: { description: WriteDescription; write: () => Promise<void> }[] = [];
  const scheduled = new Set<string>();
  for (const p of input.policy.packages) {
    const observed = input.observation.packages.find(x => x.packageName === p.packageName)!;
    await actualTyped.readReleasedBaseline(input.consumerRoot, p, input.signal, 'release-promotion');
    const bytes = Buffer.from(await readContainedRegularFile({ root: input.consumerRoot, candidate: join(input.consumerRoot, p.releasedBaselinePath), maxBytes: 32 * 1024 * 1024 }));
    const digest = migrationDigest(bytes);
    if (digest !== observed.baselineDigest && !bytes.equals(migrationBytes(observed.nativeCandidate))) {fail(`physical baseline is neither exact B nor exact postimage: ${p.packageName}`);}
    physical.set(p.packageName, bytes);
  }
  const scheduleTyped: PublicApiRepository['writeReleasedBaseline'] = async (root, p, snapshot, signal, mode = 'replace') => {
    const row = input.observation.packages.find(x => x.packageName === p.packageName)!;
    if (mode !== 'replace' || !isDeepStrictEqual(snapshot, row.nativeCandidate)) {fail('typed promotion differs from actual candidate observation');}
    if (scheduled.has(p.packageName)) {fail('duplicate typed promotion');}
    scheduled.add(p.packageName);
    if (physical.get(p.packageName)!.equals(migrationBytes(snapshot))) {return;}
    const capturedPolicy = structuredClone(p);
    const capturedSnapshot = structuredClone(snapshot);
    const description = await actualTyped.describeReleasedBaselineWrite(root, capturedPolicy, capturedSnapshot, mode);
    if (description.preimageDigest !== migrationDigest(physical.get(p.packageName)!)) {fail('logical A was substituted for physical baseline preimage');}
    pending.push({ description, write: () => actualTyped.writeReleasedBaseline(root, capturedPolicy, capturedSnapshot, signal, mode) });
  };
  const typedRepository: PublicApiRepository = {
    readReleasedBaseline: async (_root, p) => input.observation.packages.find(x => x.packageName === p.packageName)!.nativeReleased,
    readReleaseEvidence: actualTyped.readReleaseEvidence.bind(actualTyped),
    describeReleasedBaselineWrite: actualTyped.describeReleasedBaselineWrite.bind(actualTyped),
    writeReleasedBaseline: scheduleTyped
  };
  const typed: PromotionDependencies = { ...dependencies.typed, repository: typedRepository, extractor: { extract: async (...args) => {
    const current = await dependencies.typed.extractor.extract(...args);
    const expected = input.observation.packages.find(x => x.packageName === args[1].packageName)!.nativeCandidate;
    if (!isDeepStrictEqual(current, expected)) {fail('candidate changed since native migration observation');}
    return current;
  } } };
  const artifactRepository = dependencies.artifacts.repository;
  const artifacts: PromotionDependencies = { ...dependencies.artifacts, repository: {
    readReleasedBaseline: artifactRepository.readReleasedBaseline.bind(artifactRepository),
    readReleaseEvidence: artifactRepository.readReleaseEvidence.bind(artifactRepository),
    describeReleasedBaselineWrite: artifactRepository.describeReleasedBaselineWrite.bind(artifactRepository),
    writeReleasedBaseline: async (...args) => {
      const capturedPolicy = structuredClone(args[1]);
      const capturedSnapshot = structuredClone(args[2]);
      const description = await artifactRepository.describeReleasedBaselineWrite(args[0], capturedPolicy, capturedSnapshot, args[4] ?? 'replace');
      pending.push({ description, write: () => artifactRepository.writeReleasedBaseline(args[0], capturedPolicy, capturedSnapshot, args[3], args[4]) });
    }
  } };
  await preflightPublicApiPromotions(input, [typed, artifacts]);
  // The normal promoter intentionally skips same-version/no-change packages.
  // This named migration must still replace every remaining legacy typed B.
  for (const p of input.policy.packages) {
    if (!scheduled.has(p.packageName)) {
      const row = input.observation.packages.find(x => x.packageName === p.packageName)!;
      await scheduleTyped(input.consumerRoot, p, row.nativeCandidate, input.signal, 'replace');
    }
  }
  if (new Set(pending.map(x => x.description.destination)).size !== pending.length) {fail('duplicate migration destination');}
  const checks = new Map(pending.map(item => [item.description.destination, item.description]));
  // Exact postimages already present during preparation are still part of the
  // complete migration. They must not drift back to B while other files write.
  for (const p of input.policy.packages) {
    if (!checks.has(p.releasedBaselinePath)) {checks.set(p.releasedBaselinePath, { destination: p.releasedBaselinePath, operation: 'replace', preimageDigest: migrationDigest(physical.get(p.packageName)!), proposedDigest: migrationDigest(migrationBytes(input.observation.packages.find(row => row.packageName === p.packageName)!.nativeCandidate)) });}
  }
  const writes = pending.map(x => Object.freeze({ ...x.description }));
  return Object.freeze({ kind: 'foundation:public-api-native-migration:version-plan:1' as const, writes: Object.freeze(writes), async apply() {
    // Preflight all paths before any mutation; each owning writer additionally
    // retains its exact cached preimage check at the individual write boundary.
    const complete = new Set<string>();
    for (const description of checks.values()) {
      let bytes: Buffer | undefined;
      try { bytes = Buffer.from(await readContainedRegularFile({ root: input.consumerRoot, candidate: join(input.consumerRoot, description.destination), maxBytes: 32 * 1024 * 1024 })); }
      catch (error) {
        if (description.operation !== 'create' || !(error instanceof ContainedFileReadError) || error.failure !== 'missing') {throw error;}
      }
      const digest = bytes === undefined ? null : migrationDigest(bytes);
      if (digest === description.proposedDigest) { complete.add(description.destination); continue; }
      if (digest !== description.preimageDigest) {fail('baseline preimage changed before migration application');}
    }
    for (const item of pending) {
      if (!complete.has(item.description.destination)) { await item.write(); }
    }
  } });
}
