import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSchema } from '../packages/engineering-foundation/dist/schema-catalog.js';
import { loadStrictYamlFile } from '../packages/engineering-foundation/dist/features/configuration-input/node.js';
import { loadCapabilityConfig } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/inbound/configuration/load-capability-config.js';
import { createPublicApiCompatibilityDependencies, createPublicApiArtifactDependencies } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/module.js';
import { preflightPublicApiPromotions } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/use-cases/preflight-public-api-promotions.js';
import { readAcceptedArchitectureDecisionEvidence } from '../packages/engineering-foundation/dist/capabilities/governance-architecture-decisions/module.js';
import { AjvJsonSchemaReleaseInspector } from '../packages/engineering-foundation/dist/capabilities/contract-json-schema-releases/module.js';
import { readContainedRegularFile } from '../packages/engineering-foundation/dist/source-inventory/node.js';
import type { FoundationCheckReport } from '../packages/engineering-foundation/dist/features/validation-reporting/api.js';
import { assertNativeMigrationOrdinaryMismatchReport, assertNativeMigrationOrdinaryReport, assertNativeMigrationReview, migrationBytes, migrationDigest, observeNativeMigration, prepareNativeMigrationPromotion } from './public-api-native-migration.ts';
import { acquireNativeMigrationInputs, readNativeMigrationIntent } from './public-api-native-migration-inputs.ts';
import { assertVersionSnapshotUnchanged, readVersionRunIdentity, verifyVersionWorkflow } from './public-api-native-migration-version.ts';
import { runCommand } from './pack-test-support.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const configPath = 'architecture/foundation/public-api-compatibility.yaml';
function fail(message: string): never { throw new Error(`Native migration driver: ${message}`); }
export interface MigrationArguments { readonly mode: 'qualify' | 'apply-version'; readonly ordinaryReport?: string; readonly migrationReport?: string }
export function parseMigrationArguments(args: readonly string[]): MigrationArguments {
  const mode = args[0]; if (mode !== 'qualify' && mode !== 'apply-version') {fail('expected qualify or apply-version');}
  const values = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i]!; const value = args[i + 1];
    if (mode !== 'qualify' || !['--ordinary-report', '--migration-report'].includes(key) || values.has(key) || value === undefined || value.startsWith('--')) {fail('unsupported or duplicate driver option');}
    values.set(key, value);
  }
  return { mode, ...(values.has('--ordinary-report') ? { ordinaryReport: values.get('--ordinary-report')! } : {}), ...(values.has('--migration-report') ? { migrationReport: values.get('--migration-report')! } : {}) };
}
export function assertReportDestination(repositoryRoot: string, path: string): string {
  const destination = resolve(path); const within = relative(repositoryRoot, destination);
  if (within === '' || (!within.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && within !== '..' && !isAbsolute(within))) {fail('report destinations must be outside the source checkout');}
  return destination;
}
export interface OrdinaryResult { readonly stdout: string; readonly stderr: string; readonly exitCode: number }
export function ordinaryFailureResult(error: unknown): OrdinaryResult {
  if (!(error instanceof Error) || error.name !== 'CommandExecutionError' || !('code' in error) || !Number.isInteger(error.code) ||
      !('stdout' in error) || typeof error.stdout !== 'string' || !('stderr' in error) || typeof error.stderr !== 'string' ||
      !('timedOut' in error) || error.timedOut !== false || !('signal' in error) || error.signal !== null ||
      !('terminationConfirmed' in error) || error.terminationConfirmed !== true) {throw error;}
  return { stdout: error.stdout, stderr: error.stderr, exitCode: error.code as number };
}
async function ordinaryCheck(): Promise<OrdinaryResult> {
  try { return { ...await runCommand(process.execPath, [join(root, 'packages/engineering-foundation/dist/cli.js'), 'check', '--consumer', root, '--format', 'json'], root, { timeoutMs: 600_000 }), exitCode: 0 }; }
  catch (error) { return ordinaryFailureResult(error); }
}
async function writeReport(path: string, bytes: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  assertReportDestination(await realpath(root), join(await realpath(dirname(path)), 'report'));
  await writeFile(path, bytes, { flag: 'wx' });
}
async function readPolicy() {
  const policy = await loadCapabilityConfig({ readYaml: loadStrictYamlFile, assertSchema }, root, configPath);
  if (policy.schemaVersion !== 1) {fail('the named migration requires its exact reviewed v1 policy');}
  return policy;
}
const readAccepted = (input: Parameters<typeof readAcceptedArchitectureDecisionEvidence>[0]) => readAcceptedArchitectureDecisionEvidence(input, assertSchema);
function inspector() { return new AjvJsonSchemaReleaseInspector({ read: readContainedRegularFile }); }

async function migrationObservation(temporary: string) {
  const intent = await readNativeMigrationIntent(root); const policy = await readPolicy();
  const historical = await acquireNativeMigrationInputs(root, temporary, intent, policy);
  const observation = await observeNativeMigration({ consumerRoot: root, policy, ...historical });
  assertNativeMigrationReview(observation, intent.review, policy);
  return { intent, policy, observation };
}

/** Reuse the same exact ordinary diagnostic admission before network acquisition.
 * The injected read-only observer permits testing real non-SDK CLI failures;
 * it does not supply a consumer root or grant any mutation authority. */
export async function qualifyOrdinaryResult(options: OrdinaryResult, observe: typeof migrationObservation = migrationObservation) {
  const result = { ...options };
  const parsed: unknown = JSON.parse(result.stdout);
  await assertSchema('foundation-check-report/v1', parsed, 'native-migration-driver');
  const report = parsed as FoundationCheckReport;
  if (result.exitCode === 0) {
    if (report.coverage !== 'full' || report.outcome !== 'passed' || report.problem !== undefined || report.summary.errors !== 0) {fail('ordinary zero exit lacks a successful full report');}
    return { outcome: 'ordinary-passed' as const, report };
  }
  const intent = await readNativeMigrationIntent(root); const policy = await readPolicy();
  await assertNativeMigrationOrdinaryMismatchReport({ report, exitCode: result.exitCode, policy, expectedCapabilities: intent.expectedCapabilities });
  const temporary = await mkdtemp(join(tmpdir(), 'foundation-native-migration-inputs-'));
  try {
    const packet = await observe(temporary);
    await assertNativeMigrationOrdinaryReport({ policy, observation: packet.observation, review: intent.review, report, exitCode: result.exitCode, expectedCapabilities: intent.expectedCapabilities });
    return { outcome: 'named-migration-qualified' as const, report, packet };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function qualify(args: MigrationArguments): Promise<void> {
  const reports = await mkdtemp(join(tmpdir(), 'foundation-native-migration-reports-'));
  const ordinaryPath = assertReportDestination(root, args.ordinaryReport ?? join(reports, 'ordinary.json'));
  const migrationPath = assertReportDestination(root, args.migrationReport ?? join(reports, 'migration.json'));
  if (new Set([ordinaryPath, `${ordinaryPath}.stderr`, `${ordinaryPath}.exit-code`, migrationPath]).size !== 4) {fail('report destinations overlap');}
  const result = await ordinaryCheck();
  await writeReport(ordinaryPath, result.stdout);
  await writeReport(`${ordinaryPath}.stderr`, result.stderr);
  await writeReport(`${ordinaryPath}.exit-code`, `${result.exitCode}\n`);
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  const ordinary = { reportPath: ordinaryPath, stdoutDigest: migrationDigest(Buffer.from(result.stdout)), stderrDigest: migrationDigest(Buffer.from(result.stderr)), exitCode: result.exitCode };
  try {
    const admission = await qualifyOrdinaryResult(result);
    if (admission.outcome === 'ordinary-passed') {
      await writeReport(migrationPath, migrationBytes({ kind: 'foundation:public-api-native-migration:qualification:1', outcome: admission.outcome, migrationApplied: false, ordinary: { ...ordinary, outcome: admission.report.outcome } }));
      return;
    }
    const { packet } = admission;
    await writeReport(migrationPath, migrationBytes({ kind: 'foundation:public-api-native-migration:qualification:1', outcome: admission.outcome, migrationApplied: false, ordinary: { ...ordinary, outcome: admission.report.outcome }, policyDigest: packet.observation.policyDigest, reviewedToolDifferenceDigest: packet.observation.toolDiffDigest, observationDigest: migrationDigest(migrationBytes(packet.observation)), typedDiagnostics: packet.observation.typedDiagnostics, artifactDiagnostics: packet.observation.artifactDiagnostics, packages: packet.observation.packages.map(p => ({ packageName: p.packageName, baselineDigest: p.baselineDigest, archiveDigest: p.archiveDigest, releasedInputsDigest: p.releasedInputsDigest, nativeReleasedDigest: p.nativeReleasedDigest, nativeCandidateDigest: migrationDigest(migrationBytes(p.nativeCandidate)) })) }));
    process.stderr.write(`Named native public API migration qualified; ordinary exit ${result.exitCode} and full report retained at ${ordinaryPath}; qualification at ${migrationPath}.\n`);
  } catch (error) {
    await writeReport(migrationPath, migrationBytes({ kind: 'foundation:public-api-native-migration:qualification:1', outcome: 'rejected', migrationApplied: false, ordinary, reason: error instanceof Error ? error.message : String(error) }));
    throw error;
  }
}

async function applyVersion(): Promise<void> {
  const identity = readVersionRunIdentity({ ...process.env });
  const before = await verifyVersionWorkflow(root, identity);
  const policy = await readPolicy();
  const committedBaselines = await Promise.all(policy.packages.map(async p => {
    const bytes = Buffer.from((await runCommand('git', ['show', `${identity.sha}:${p.releasedBaselinePath}`], root)).stdout);
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    await assertSchema('package-public-api-baseline/v1', value, 'native-migration-driver');
    return { packageName: p.packageName, digest: migrationDigest(bytes), extractorVersion: (value as { extractorVersion: string }).extractorVersion };
  }));
  if (committedBaselines.every(baseline => baseline.extractorVersion !== '7.58.12')) {
    if ((await runCommand('git', ['diff', '--name-only', 'HEAD', '--', 'architecture/public-api'], root)).stdout !== '') {fail('ordinary promotion requires unchanged released baseline inputs');}
    const typed = createPublicApiCompatibilityDependencies(readAccepted, assertSchema);
    const artifacts = await createPublicApiArtifactDependencies(root, policy.packages, typed, inspector());
    // This is the unchanged ordinary promoter and its existing all-surface
    // preflight. Its callback fences the actual write boundary with fresh reads.
    await preflightPublicApiPromotions({ consumerRoot: root, policy }, [typed, artifacts], async () => {
      assertVersionSnapshotUnchanged(before, await verifyVersionWorkflow(root, identity));
    });
    return;
  }
  if (!committedBaselines.every(baseline => baseline.extractorVersion === '7.58.12')) {fail('only the complete closed legacy baseline set may migrate');}
  const intent = await readNativeMigrationIntent(root);
  for (const baseline of committedBaselines) {
    if (intent.review.packages.find(p => p.packageName === baseline.packageName)?.baselineDigest !== baseline.digest) { fail('processed main baselines differ from the exact reviewed B bytes'); }
  }
  const temporary = await mkdtemp(join(tmpdir(), 'foundation-native-migration-version-'));
  try {
    const packet = await migrationObservation(temporary);
    const typed = createPublicApiCompatibilityDependencies(readAccepted, assertSchema);
    const artifacts = await createPublicApiArtifactDependencies(root, policy.packages, typed, inspector());
    const plan = await prepareNativeMigrationPromotion({ consumerRoot: root, policy, observation: packet.observation, review: packet.intent.review }, { typed, artifacts });
    assertVersionSnapshotUnchanged(before, await verifyVersionWorkflow(root, identity));
    await plan.apply();
    process.stdout.write(`${JSON.stringify({ kind: plan.kind, outcome: 'applied-by-version-workflow', writes: plan.writes })}\n`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function nativeMigrationMain(args: readonly string[]): Promise<void> {
  const parsed = parseMigrationArguments(args);
  if (parsed.mode === 'qualify') {await qualify(parsed);} else {await applyVersion();}
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await nativeMigrationMain(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
