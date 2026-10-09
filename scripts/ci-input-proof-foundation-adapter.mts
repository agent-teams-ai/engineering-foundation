import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  executeFixedFull,
  type CheckCommand,
  type ProcessReport,
} from './ci-input-proof-full.mts';

export type { CheckCommand, ProcessReport } from './ci-input-proof-full.mts';

export type InputProofRelation = Readonly<
  | { status: 'compatible-inputs'; changedContentPaths: readonly string[] }
  | { status: 'rejected'; reason: string }
>;
export type CompareInputInventories = (
  before: unknown,
  after: unknown,
  permittedContentChanges: unknown,
) => InputProofRelation;
export type InputLeafShape = Readonly<{
  path: string;
  type: 'file' | 'symlink' | 'gitlink';
  mode: '100644' | '100755' | '120000' | '160000';
  membership: 'closed' | 'structural';
  content: string;
}>;
export type LeafInventoryShape = Readonly<{
  version: 1;
  digestScheme: 'git-object-sha1' | 'sha256';
  inputs: readonly InputLeafShape[];
}>;
export type ScopeCategory =
  | 'source' | 'helpers' | 'fixtures' | 'config' | 'lock' | 'toolchain' | 'installedGraph';
export type Observation = Readonly<{
  schemaVersion: 1;
  boundaryId: string;
  scopeId: 'foundation.ci-input-proof.focus.v1';
  scope: Readonly<Record<ScopeCategory, readonly string[]>>;
  inventory: LeafInventoryShape;
}>;
export type MergeTuple = Readonly<{
  headSha: string;
  baseSha: string;
  mergeTuple: string;
}>;
export type FoundationPilotRequest = Readonly<{
  schemaVersion: 1;
  pilotId: 'foundation.ci-input-proof.focus.v1';
  tuple: MergeTuple;
  before: Observation;
  current: Observation;
  permittedContentChanges: readonly string[];
  full: CheckCommand;
}>;
export type FoundationPilotRequestInput = Readonly<{
  schemaVersion: number;
  pilotId: string;
  tuple: unknown;
  before: Observation;
  current: Observation;
  permittedContentChanges: unknown;
  full: unknown;
}>;
export type CandidateOmitObservation = Readonly<{
  status: 'eligible' | 'not-eligible';
  reason: string;
  relation: InputProofRelation | Readonly<{ status: 'unavailable'; reason: string }>;
  observationIssues: readonly string[];
  changedContentPaths: readonly string[];
}>;
export type AdapterReport = Readonly<{
  schemaVersion: 1;
  tuple: MergeTuple & Readonly<{ digest: string }>;
  candidateOmitObservation: CandidateOmitObservation;
  execution: Readonly<{
    status: 'passed' | 'failed' | 'unavailable';
    full: ProcessReport;
  }>;
  omission: Readonly<{
    status: 'not-attempted';
    reason: 'shadow-executes-full';
    reportedSeparatelyFromPass: true;
  }>;
  selection: Readonly<{
    decision: 'full';
    reason: 'shadow-no-admitted-omission-policy';
    independentlyExecutable: true;
  }>;
  authority: Readonly<{
    mode: 'control-shadow';
    admittedOmissionPolicy: false;
    packageResolutionClosure: 'unsupported';
    savedCheck: false;
  }>;
  optimizer: Readonly<{
    status: 'unavailable';
    reason: 'no-admitted-optimizer-policy';
    omissionAuthority: false;
  }>;
  timingsMs: Readonly<{
    comparison: number;
    optimizer: number;
    full: number;
    total: number;
    clock: 'performance.now';
  }>;
}>;
export type AdapterResult = Readonly<{
  report: AdapterReport;
  exitCode: number;
}>;

const scopeCategories: readonly ScopeCategory[] = Object.freeze([
  'source', 'helpers', 'fixtures', 'config', 'lock', 'toolchain', 'installedGraph',
]);
const maxTimeoutMs = 180_000;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

function tupleDigest(tuple: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(tuple))).digest('hex');
}

function ownRecord(value: unknown, keys: readonly string[]): Map<string, unknown> | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }
  const actualKeys = Reflect.ownKeys(value);
  if (actualKeys.length !== keys.length) {
    return null;
  }
  const fields = new Map<string, unknown>();
  for (const key of actualKeys) {
    if (typeof key !== 'string' || !keys.includes(key)) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      return null;
    }
    fields.set(key, descriptor.value);
  }
  return fields;
}

function ownStrings(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return null;
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) {
    return null;
  }
  const strings: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') {
      return null;
    }
    strings.push(descriptor.value);
  }
  return strings;
}

function denseValues(value: unknown): readonly unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return null;
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) {
    return null;
  }
  const values: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      return null;
    }
    values.push(descriptor.value);
  }
  return values;
}

function validateTuple(value: unknown): MergeTuple | null {
  const fields = ownRecord(value, ['headSha', 'baseSha', 'mergeTuple']);
  if (fields === null) {
    return null;
  }
  const headSha = fields.get('headSha');
  const baseSha = fields.get('baseSha');
  const mergeTuple = fields.get('mergeTuple');
  if (![headSha, baseSha, mergeTuple].every(entry => typeof entry === 'string' && entry.length > 0)) {
    return null;
  }
  return Object.freeze({
    headSha: headSha as string,
    baseSha: baseSha as string,
    mergeTuple: mergeTuple as string,
  });
}

function validateCommand(value: unknown, field: string, issues: string[]): CheckCommand | null {
  const fields = ownRecord(value, ['command', 'args', 'cwd', 'timeoutMs']);
  if (fields === null) {
    issues.push(`${field}:malformed`);
    return null;
  }
  const command = fields.get('command');
  const args = ownStrings(fields.get('args'));
  const cwd = fields.get('cwd');
  const timeoutMs = fields.get('timeoutMs');
  if (typeof command !== 'string' || !isAbsolute(command)) {
    issues.push(`${field}:command-not-absolute`);
  }
  if (args === null) {
    issues.push(`${field}:args-malformed`);
  }
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    issues.push(`${field}:cwd-not-absolute`);
  }
  if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs)
      || timeoutMs <= 0 || timeoutMs > maxTimeoutMs) {
    issues.push(`${field}:timeout-invalid`);
  }
  if (issues.some(issue => issue.startsWith(`${field}:`))
      || typeof command !== 'string' || args === null || typeof cwd !== 'string'
      || typeof timeoutMs !== 'number') {
    return null;
  }
  return Object.freeze({
    command,
    args: Object.freeze([...args]),
    cwd,
    timeoutMs,
  });
}

function collectScopedPaths(value: unknown, field: string, issues: string[]): Set<string> {
  const scope = ownRecord(value, scopeCategories);
  const paths = new Set<string>();
  if (scope === null) {
    issues.push(`${field}:scope-malformed`);
    return paths;
  }
  for (const category of scopeCategories) {
    const categoryPaths = ownStrings(scope.get(category));
    if (categoryPaths === null || categoryPaths.length === 0) {
      issues.push(`${field}:incomplete-${category}`);
      continue;
    }
    for (const path of categoryPaths) {
      if (path.length === 0 || paths.has(path)) {
        issues.push(`${field}:invalid-scope`);
      }
      paths.add(path);
    }
  }
  return paths;
}

function collectInventoryPaths(value: unknown, field: string, issues: string[]): Set<string> {
  const inventory = ownRecord(value, ['version', 'digestScheme', 'inputs']);
  const paths = new Set<string>();
  if (inventory === null) {
    issues.push(`${field}:inventory-malformed`);
    return paths;
  }
  if (inventory.get('version') !== 1 || typeof inventory.get('digestScheme') !== 'string') {
    issues.push(`${field}:inventory-shape`);
  }
  const leaves = denseValues(inventory.get('inputs'));
  if (leaves === null) {
    issues.push(`${field}:inputs-malformed`);
    return paths;
  }
  for (const leaf of leaves) {
    const leafFields = ownRecord(leaf, ['path', 'type', 'mode', 'membership', 'content']);
    const path = leafFields?.get('path');
    if (leafFields === null || typeof path !== 'string' || path.length === 0 || paths.has(path)) {
      issues.push(`${field}:invalid-input`);
      continue;
    }
    paths.add(path);
  }
  return paths;
}

function observationIssues(observation: unknown, field: string): readonly string[] {
  const issues: string[] = [];
  const root = ownRecord(observation, ['schemaVersion', 'boundaryId', 'scopeId', 'scope', 'inventory']);
  if (root === null) {
    return Object.freeze([`${field}:malformed`]);
  }
  if (root.get('schemaVersion') !== 1) {
    issues.push(`${field}:unsupported-schema`);
  }
  if (typeof root.get('boundaryId') !== 'string' || root.get('boundaryId') === '') {
    issues.push(`${field}:boundary-missing`);
  }
  if (root.get('scopeId') !== 'foundation.ci-input-proof.focus.v1') {
    issues.push(`${field}:scope-id`);
  }
  const scoped = collectScopedPaths(root.get('scope'), field, issues);
  const inventoryPaths = collectInventoryPaths(root.get('inventory'), field, issues);
  if (scoped.size !== inventoryPaths.size || [...scoped].some(path => !inventoryPaths.has(path))) {
    issues.push(`${field}:scope-inventory-drift`);
  }
  return Object.freeze([...new Set(issues)]);
}

function crossObservationIssues(before: unknown, current: unknown): readonly string[] {
  const issues: string[] = [];
  const beforeRoot = ownRecord(before, ['schemaVersion', 'boundaryId', 'scopeId', 'scope', 'inventory']);
  const currentRoot = ownRecord(current, ['schemaVersion', 'boundaryId', 'scopeId', 'scope', 'inventory']);
  if (beforeRoot === null || currentRoot === null) {
    return Object.freeze([]);
  }
  if (beforeRoot.get('boundaryId') === currentRoot.get('boundaryId')) {
    issues.push('observation:boundary-not-distinct');
  }
  if (beforeRoot.get('scopeId') !== currentRoot.get('scopeId')
      || JSON.stringify(stableValue(beforeRoot.get('scope')))
        !== JSON.stringify(stableValue(currentRoot.get('scope')))) {
    issues.push('observation:scope-drift');
  }
  return Object.freeze(issues);
}

function parseRelation(value: unknown): InputProofRelation | Readonly<{ status: 'unavailable'; reason: string }> {
  const fields = ownRecord(value, ['status', 'changedContentPaths']);
  const rejected = ownRecord(value, ['status', 'reason']);
  if (fields !== null && fields.get('status') === 'compatible-inputs') {
    const changedContentPaths = ownStrings(fields.get('changedContentPaths'));
    if (changedContentPaths !== null) {
      return Object.freeze({
        status: 'compatible-inputs',
        changedContentPaths: Object.freeze([...changedContentPaths]),
      });
    }
  }
  if (rejected !== null && rejected.get('status') === 'rejected'
      && typeof rejected.get('reason') === 'string' && rejected.get('reason') !== '') {
    return Object.freeze({ status: 'rejected', reason: rejected.get('reason') as string });
  }
  if (typeof value !== 'object' || value === null || !('status' in value)) {
    return Object.freeze({ status: 'unavailable', reason: 'malformed-comparator-result' });
  }
  return Object.freeze({ status: 'unavailable', reason: 'malformed-comparator-result' });
}

function candidateObservation(
  relation: InputProofRelation | Readonly<{ status: 'unavailable'; reason: string }>,
  issues: readonly string[],
): CandidateOmitObservation {
  if (issues.length > 0) {
    return Object.freeze({
      status: 'not-eligible',
      reason: `incomplete-observation:${issues.join(',')}`,
      relation,
      observationIssues: issues,
      changedContentPaths: Object.freeze([]),
    });
  }
  if (relation.status === 'rejected') {
    return Object.freeze({
      status: 'not-eligible',
      reason: `input-proof-rejected:${relation.reason}`,
      relation,
      observationIssues: issues,
      changedContentPaths: Object.freeze([]),
    });
  }
  if (relation.status === 'unavailable') {
    return Object.freeze({
      status: 'not-eligible',
      reason: `input-proof-unavailable:${relation.reason}`,
      relation,
      observationIssues: issues,
      changedContentPaths: Object.freeze([]),
    });
  }
  const changedContentPaths = Object.freeze([...relation.changedContentPaths]);
  return Object.freeze({
    status: changedContentPaths.length === 0 ? 'eligible' : 'not-eligible',
    reason: changedContentPaths.length === 0
      ? 'equal-inventories'
      : `structural-drift:${changedContentPaths.join(',')}`,
    relation,
    observationIssues: issues,
    changedContentPaths,
  });
}

export async function runCiInputProofAdapter(
  request: FoundationPilotRequestInput,
  compare: CompareInputInventories,
): Promise<AdapterResult> {
  const started = performance.now();
  const tuple = validateTuple(request.tuple);
  const issues = Object.freeze([
    ...(request.schemaVersion === 1 ? [] : ['request:unsupported-schema']),
    ...(request.pilotId === 'foundation.ci-input-proof.focus.v1' ? [] : ['request:wrong-pilot']),
    ...(tuple === null ? ['tuple:malformed'] : []),
    ...(ownStrings(request.permittedContentChanges) === null ? ['permissions:malformed'] : []),
    ...observationIssues(request.before, 'before'),
    ...observationIssues(request.current, 'current'),
    ...crossObservationIssues(request.before, request.current),
  ]);
  let relation: InputProofRelation | Readonly<{ status: 'unavailable'; reason: string }>;
  const comparisonStarted = performance.now();
  if (issues.length > 0) {
    relation = Object.freeze({ status: 'unavailable', reason: 'observation-incomplete' });
  } else {
    try {
      relation = parseRelation(compare(request.before.inventory, request.current.inventory, request.permittedContentChanges));
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
      relation = Object.freeze({ status: 'unavailable', reason: typeof code === 'string' ? code : 'comparator-failed' });
    }
  }
  const comparisonMs = performance.now() - comparisonStarted;
  const candidate = candidateObservation(relation, issues);

  const optimizerReport: AdapterReport['optimizer'] = Object.freeze({
    status: 'unavailable' as const,
    reason: 'no-admitted-optimizer-policy' as const,
    omissionAuthority: false as const,
  });

  const fullIssues: string[] = [];
  const fullSpec = validateCommand(request.full, 'full', fullIssues);
  const fullStarted = performance.now();
  const full = fullSpec === null
    ? Object.freeze({
        status: 'unavailable' as const,
        exitCode: null,
        signal: null,
        errorCode: null,
        outputTruncated: false,
        reason: fullIssues.join(','),
      })
    : (await executeFixedFull(fullSpec)).report;
  const fullMs = fullSpec === null ? 0 : performance.now() - fullStarted;
  const report: AdapterReport = Object.freeze({
    schemaVersion: 1,
    tuple: Object.freeze({
      ...(tuple ?? Object.freeze({ headSha: '', baseSha: '', mergeTuple: '' })),
      digest: tupleDigest(tuple ?? request.tuple),
    }),
    candidateOmitObservation: candidate,
    execution: Object.freeze({ status: full.status, full }),
    omission: Object.freeze({
      status: 'not-attempted' as const,
      reason: 'shadow-executes-full' as const,
      reportedSeparatelyFromPass: true as const,
    }),
    selection: Object.freeze({
      decision: 'full' as const,
      reason: 'shadow-no-admitted-omission-policy' as const,
      independentlyExecutable: true as const,
    }),
    authority: Object.freeze({
      mode: 'control-shadow' as const,
      admittedOmissionPolicy: false as const,
      packageResolutionClosure: 'unsupported' as const,
      savedCheck: false as const,
    }),
    optimizer: optimizerReport,
    timingsMs: Object.freeze({
      comparison: comparisonMs,
      optimizer: 0,
      full: fullMs,
      total: performance.now() - started,
      clock: 'performance.now' as const,
    }),
  });
  const exitCode = full.status === 'passed'
    ? 0
    : typeof full.exitCode === 'number' && full.exitCode > 0 ? Math.min(full.exitCode, 255) : 1;
  return Object.freeze({ report, exitCode });
}
