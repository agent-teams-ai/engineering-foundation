import { createVerifiedGrowthObservation } from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/reviewrouter/verified-growth-observation.js";
import assert from 'node:assert/strict';
import test from 'node:test';
import { isGrowthDecision } from '../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/validate-growth-decision.js';
import { createHash } from 'node:crypto';
import { compareGrowthSurfaces, growthGroupFingerprint, growthTransitionFingerprint } from '../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/compare-growth-surfaces.js';
import { evaluateGrowthAdmission, growthDecisionDigest } from '../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/evaluate-growth-admission.js';
import { growthDimensions } from '../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/growth-observation.js';
import { admitSdkGrowth } from '../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/use-cases/admit-sdk-growth.js';
import { growthObservationReference } from '../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/normalize-growth-observation.js';
import { GovernanceAcceptedDecisionEvidenceAcl } from '../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/governance/governance-accepted-decision-evidence-acl.js';
const digest = `sha256:${'a'.repeat(64)}`;
const valid = () => ({ contractRevision: 'foundation:sdk-growth:c0:5', decisionId: 'ADR-1', ownerRef: 'owner/team', stability: 'supported', transitions: [digest], coordinates: [{ packageName: 'example', exportPath: '.', resolutionBranch: [], subject: {kind: 'package'} }], changeFingerprint: digest, consumerEvidenceRefs: [{ useCase: 'test', repository: 'consumer', source: {tree: 'a'.repeat(40), contentDigest: digest, commit: null}, artifactDigest: null }], exposureRationale: 'consumer use', compatibilityRationale: 'additive', lifecycle: {kind: 'ordinary'} });
const fingerprint = { sha256: value => createHash('sha256').update(value).digest('hex') };
const otherDigest = `sha256:${'b'.repeat(64)}`;
const policyVersion = 'foundation:sdk-growth:policy:1';
const coordinate = (symbol = 'A', exportPath = '.') => ({ packageName: 'example', exportPath, resolutionBranch: [], subject: { kind: 'typed', canonicalReference: symbol } });
const entry = (symbol, value = digest, path = '.') => ({ coordinate: coordinate(symbol, path), value: {state: 'present', digest: value} });
const observation = entries => ({ contractRevision: 'foundation:sdk-growth:c0:5', observationVersion: 'foundation:sdk-growth:observation:1', repository: 'fixture', sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), topologyDigest: digest, lockDigest: digest, toolchainDigest: digest, artifactDigests: [digest], tool: { version: '1', artifactDigest: digest, extractorVersion: 'pinned' }, coverage: [{ packageName: 'example', classification: 'governed', dimensions: growthDimensions.map(dimension => ({ dimension, status: dimension === 'decision' ? 'unavailable' : 'complete', reasons: [dimension === 'decision' ? 's2-pending' : 'fixture-observed'] })) }], entries });
const compare = (before, after) => compareGrowthSurfaces({trustedBefore: {status:'available',value: observation(before)}, candidateAfter:{status:'available',value: observation(after)}}, fingerprint);
const decisionFor = (transitions, decisionId = 'ADR-1') => ({...valid(), decisionId, transitions: transitions.map(x => x.fingerprint), coordinates: transitions.map(x => x.coordinate), changeFingerprint: growthGroupFingerprint(transitions.map(x => x.fingerprint), fingerprint)});
const authorityFor = decision => ({decisionId: decision.decisionId, ownerRef: decision.ownerRef, decisionDigest: growthDecisionDigest(decision, fingerprint)});
const evaluate = (comparison, decisions = [], changes = {}) => evaluateGrowthAdmission({comparison, decisions, authority: [...new Map(decisions.filter(isGrowthDecision).map(d => [d.decisionId,authorityFor(d)])).values()], compatibility:'complete', ...changes}, fingerprint);
const codes = result => result.diagnostics.map(x => x.code);

const available = value => ({status:'available',value});
const snapshot = (items = []) => ({schemaVersion:1,packageName:'example',packageVersion:'1.0.0',extractorVersion:'pinned',entrypoints:[{exportPath:'.',items}]});
const packageSnapshot = (packageName, items, extractorVersion = 'pinned') => ({schemaVersion:1,packageName,packageVersion:'1.0.0',extractorVersion,entrypoints:[{exportPath:'.',items}]});
function useCaseFixture() {
 const before = observation([]), after = observation([entry('A')]);
 const { contractRevision: _contract, observationVersion: _version, coverage: _coverage, entries: _entries, ...invocation } = after;
 const artifact = {...snapshot(),extractorVersion:'package-artifact-inventory/1'};
 const current = snapshot([{canonicalReference:'A',kind:'Function',parentKind:'EntryPoint',signature:'export function A(): void;'}]);
 const comparison = compare([], [entry('A')]), decision = decisionFor(comparison.transitions);
 const reference = growthObservationReference(before,fingerprint);
 const context = {trustedBase:available(before), trustedBaseReference:available(reference), retainedHistory:available({targetSurfaceDigest:reference.surfaceDigest,receiptDigest:digest}), released:[{
  packageName:'example', policy:{packageName:'example',packageRoot:'packages/example',manifestPath:'packages/example/package.json',tsconfigPath:'packages/example/tsconfig.json',releasedBaselinePath:'architecture/public-api/example.json',approvedBreakingChanges:[],entrypoints:[{exportPath:'.',declarationEntryPoint:'dist/index.d.ts'}],nonTypeExports:[]},
  releaseEvidence:available({packageName:'example',packageVersion:'1.0.0',declaredBump:'minor'}), qualification:{receiptDigest:digest}, evidence:{kind:'released',typed:available(snapshot()),artifact:available(artifact)}
 }], packedCandidates:[{packageName:'example',observation:after,coverage:after.coverage[0]}],
 decisions:[decision],acceptedBreakingDecisions:{acceptedDecisionIds:[],acceptedDecisionPaths:[],growthDecisionAuthority:available([authorityFor(decision)])},authority:{status:'verified',receiptDigest:digest}};
 const execution = {identity:invocation,surface:available(after),compatibilitySnapshots:[{packageName:'example',typed:{kind:'typed',snapshot:available(current)},artifact:{kind:'artifact',snapshot:available(artifact)}}]};
 const calls = [];
 const cancellation = {throwIfCancelled() {}};
 const input = {invocation,context:{trustedBasePath:'base.json',decisionsPath:'decisions.json',released:[{packageName:'example',kind:'released',observationPath:'released.json'}]},cancellation};
 const dependencies = {fingerprint,observation:{async observe(value,token) { calls.push(['observation',value,token]); return execution; }},context:{async read(value,token) { calls.push(['context',value,token]); return context; }}};
 return {input,dependencies,execution,context,calls};
}

function configureCrossPackageDefaultAliasFixture(fixture, reversePackages = false) {
 const aliasPackageName = 'example';
 const bindingPackageName = '@fixture/core';
 const aliasReference = `${aliasPackageName}!AnyFactoryHandle:type`;
 const targetReference = `${aliasPackageName}!FactoryHandle:interface`;
 const alias = signature => ({canonicalReference:aliasReference,kind:'TypeAlias',parentReference:`${aliasPackageName}!`,parentKind:'EntryPoint',signature});
 const target = {canonicalReference:targetReference,kind:'Interface',parentReference:`${aliasPackageName}!`,parentKind:'EntryPoint',
  signature:'export interface FactoryHandle<C, D extends ModuleDeclaration = ModuleDeclaration, I = unknown>'};
 const binding = {canonicalReference:`${bindingPackageName}!ModuleDeclaration:interface`,kind:'Interface',parentReference:`${bindingPackageName}!`,parentKind:'EntryPoint',signature:'export interface ModuleDeclaration'};
 const releasedAlias = snapshot([alias('export type AnyFactoryHandle<C> = FactoryHandle<C, ModuleDeclaration, unknown>;'),target]);
 const currentAlias = snapshot([alias('export type AnyFactoryHandle<C> = FactoryHandle<C>;'),target]);
 const releasedBinding = packageSnapshot(bindingPackageName,[binding]);
 const currentBinding = packageSnapshot(bindingPackageName,[binding]);
 fixture.context.released[0].evidence.typed = available(releasedAlias);
 fixture.context.released[0].evidence.artifact = available({...releasedAlias,extractorVersion:'package-artifact-inventory/1'});
 fixture.execution.compatibilitySnapshots[0].typed.snapshot = available(currentAlias);
 fixture.execution.compatibilitySnapshots[0].artifact.snapshot = available({...currentAlias,extractorVersion:'package-artifact-inventory/1'});
 const bindingPolicy = {...fixture.context.released[0].policy,packageName:bindingPackageName,
  packageRoot:'packages/core',manifestPath:'packages/core/package.json',tsconfigPath:'packages/core/tsconfig.json',releasedBaselinePath:'architecture/public-api/core.json'};
 const releasedRow = {packageName:bindingPackageName,policy:bindingPolicy,
  releaseEvidence:available({packageName:bindingPackageName,packageVersion:'1.0.0'}),qualification:{receiptDigest:digest},
  evidence:{kind:'released',typed:available(releasedBinding),artifact:available({...releasedBinding,extractorVersion:'package-artifact-inventory/1'})}};
 const currentRow = {packageName:bindingPackageName,typed:{kind:'typed',snapshot:available(currentBinding)},
  artifact:{kind:'artifact',snapshot:available({...currentBinding,extractorVersion:'package-artifact-inventory/1'})}};
 fixture.context.released.push(releasedRow);
 fixture.execution.compatibilitySnapshots.push(currentRow);
 for (const surface of [fixture.context.trustedBase.value,fixture.execution.surface.value]) {
  surface.coverage.push({...structuredClone(surface.coverage[0]),packageName:bindingPackageName});
 }
 const reference = growthObservationReference(fixture.context.trustedBase.value,fingerprint);
 fixture.context.trustedBaseReference = available(reference);
 fixture.context.retainedHistory = available({targetSurfaceDigest:reference.surfaceDigest,receiptDigest:digest});
 if (reversePackages) {
  fixture.context.released.reverse();
  fixture.execution.compatibilitySnapshots.reverse();
 }
}

function registerGrowthAdmissionRegressionCases() {
  test('raw context candidate fields cannot rewrite the S1 payload or its digest', async () => {
    const f = useCaseFixture();
    const original = structuredClone(f.execution);
    f.context.packedCandidates = [{ packageName: 'example', observation: observation([]), coverage: observation([]).coverage[0] }];
    const result = await admitSdkGrowth(f.input, f.dependencies);
    assert.deepEqual(result.observation, original);
    assert.deepEqual(growthObservationReference(result.observation.surface.value, fingerprint), growthObservationReference(original.surface.value, fingerprint));
  });

  test('SDK qualification uses cross-package stable default bindings independent of package order', async () => {
   const results = [];
   for (const reversePackages of [false,true]) {
    const f = useCaseFixture();
    configureCrossPackageDefaultAliasFixture(f,reversePackages);
    const result = await admitSdkGrowth(f.input,f.dependencies);
    assert.equal(result.compatibility.status,'complete',JSON.stringify(result.compatibility));
    assert.deepEqual(result.compatibility.diagnostics,[]);
    assert.equal(result.admission.status,'admitted');
    results.push(result.compatibility);
   }
   assert.deepEqual(results[1],results[0]);
  });

  test('decision order cannot change overlap evidence', () => {
    const comparison = compare([], [entry('A')]);
    const decisions = [decisionFor(comparison.transitions, 'ADR-2'), decisionFor(comparison.transitions, 'ADR-1')];
    const result = evaluate(comparison, decisions);
    assert.equal(result.status, 'rejected');
    assert.deepEqual(result.admittedTransitions, []);
    assert.deepEqual(result.diagnostics.filter(x => x.code === 'growth-decision-overlap').map(x => x.subject), ['ADR-2']);
    assert.deepEqual(evaluate(comparison, decisions.toReversed()), result);
  });
  test('duplicate IDs reject all records before owner matching regardless of order', () => {
    const comparison = compare([], [entry('A')]);
    const first = decisionFor(comparison.transitions);
    const changed = {...first, exposureRationale: 'different approval'};
    const authority = [authorityFor(first)];
    const result = evaluate(comparison, [first, changed], {authority});
    assert.equal(result.status, 'rejected');
    assert.deepEqual(result.admittedTransitions, []);
    assert.ok(codes(result).includes('growth-decision-duplicate'));
    assert.ok(!codes(result).includes('growth-owner-evidence-unavailable'));
    assert.deepEqual(evaluate(comparison, [changed, first], {authority}), result);
    assert.equal(evaluate(comparison, [first, first], {authority}).status, 'rejected');
  });
  test('sparse observations budget actual transitions rather than combined coordinates', () => {
    const shared = Array.from({length: 99_999}, (_, i) => entry(`S${i}`));
    const comparison = compare([...shared, entry('old')], [...shared, entry('new')]);
    assert.equal(comparison.status, 'complete');
    assert.equal(comparison.transitions.length, 2);
    assert.deepEqual(comparison.transitions.map(x => x.coordinate.subject.canonicalReference), ['new', 'old']);
  });
  test('transition budget accepts the exact limit and rejects one extra transition', () => {
    const before = Array.from({length: 50_000}, (_, i) => entry(`L${i}`));
    const after = Array.from({length: 50_000}, (_, i) => entry(`R${i}`));
    assert.equal(compare(before, after).transitions.length, 100_000);
    assert.deepEqual(compare(before, [...after, entry('extra')]), {
      status: 'incomplete', reasons: ['growth-transition-budget-exhausted'], findings: []
    });
  });
  test('decision count and cumulative claim budgets return deterministic incomplete evidence', () => {
    const comparison = compare([], [entry('A')]);
    const expected = {status: 'incomplete', admittedTransitions: [], releaseEligible: false,
      diagnostics: [{code: 'growth-decision-budget-exhausted', subject: 'decisions',
        remediation: 'Supply at most 10000 decisions and 100000 total transition claims.'}]};
    const run = decisions => evaluateGrowthAdmission({comparison, decisions, authority: [], compatibility: 'complete'}, fingerprint);
    const d = decisionFor(comparison.transitions);
    assert.ok(!codes(run(Array(10_000).fill(d))).includes('growth-decision-budget-exhausted'));
    assert.deepEqual(run(Array(10_001).fill(d)), expected);
    const claims = Array.from({length: 50_001}, (_, i) => `sha256:${i.toString(16).padStart(64, '0')}`);
    const first = {...d, transitions: claims.slice(0, 50_000)};
    const second = {...d, decisionId: 'ADR-2', transitions: claims.slice(0, 50_000)};
    assert.ok(!codes(run([first, second])).includes('growth-decision-budget-exhausted'));
    const over = {...second, transitions: claims};
    assert.deepEqual(run([first, over]), expected);
    assert.deepEqual(run([over, first]), expected);
  });
 }

function registerRawDecisionBudgetCases() {
  const expected = {status: 'incomplete', admittedTransitions: [], releaseEligible: false,
    diagnostics: [{code: 'growth-decision-budget-exhausted', subject: 'decisions',
      remediation: 'Supply at most 10000 decisions and 100000 total transition claims.'}]};
  const run = decisions => evaluateGrowthAdmission({comparison: compare([], [entry('A')]),
    decisions, authority: [], compatibility: 'complete'}, fingerprint);
  test('one oversized raw decision exhausts the budget before metadata validation', () => {
    const oversized = {...valid(), transitions: Array(100_001).fill(digest)};
    assert.deepEqual(run([oversized]), expected);
    assert.deepEqual(run([oversized]), run([oversized]));
    const sparse = [];
    sparse.length = 0xffffffff;
    assert.deepEqual(run([{...oversized, transitions: sparse}]), expected);
  });
  test('malformed records count toward cumulative raw claim exhaustion in any order', () => {
    const malformed = {...valid(), ownerRef: '', transitions: Array(50_000).fill(digest)};
    const other = {...valid(), transitions: Array(50_000).fill(digest)};
    assert.ok(!codes(run([malformed, other])).includes('growth-decision-budget-exhausted'));
    const overflow = {...other, transitions: [...other.transitions, digest]};
    assert.deepEqual(run([malformed, overflow]), expected);
    assert.deepEqual(run([overflow, malformed]), expected);
  });
}

export function registerGrowthAdmissionCases() {
  registerRawDecisionBudgetCases();
  registerGrowthAdmissionRegressionCases();
  test('closed metadata accepts supported ordinary decisions without removal dates', () => assert.equal(isGrowthDecision(valid()), true));
  for (const [name, mutate] of [
   ['missing owner', x => { delete x.ownerRef; }],
   ['empty owner', x => { x.ownerRef = ' '; }],
   ['duplicate transitions', x => { x.transitions.push(digest); }],
   ['malformed digest', x => { x.changeFingerprint = 'bad'; }],
   ['unknown field', x => { x.approved = true; }],
   ['missing consumer evidence', x => { x.consumerEvidenceRefs = []; }],
   ['malformed coordinate', x => { x.coordinates[0].resolutionBranch = [{index:-1}]; }],
   ['missing migration conditions', x => { x.lifecycle = {kind:'removal'}; }],
   ['invented ordinary removal date', x => { x.lifecycle.removalDate = '2030-01-01'; }],
  ]) { test(name, () => { const value = valid(); mutate(value); assert.equal(isGrowthDecision(value), false); }); }

  test('addition without a decision rejects', () => {
   const result = evaluate(compare([], [entry('A')]));
   assert.equal(result.status, 'rejected');
   assert.deepEqual(codes(result), ['growth-transition-unadmitted']);
  });
  test('exact decisions admit their transitions, leaving another addition unadmitted', () => {
   const comparison = compare([], [entry('A'), entry('B')]);
   const decision = decisionFor(comparison.transitions.slice(0,1));
   const partial = evaluate(comparison, [decision]);
   assert.equal(partial.status, 'rejected');
   assert.equal(partial.diagnostics.find(x => x.code === 'growth-transition-unadmitted').subject, comparison.transitions[1].fingerprint);
   const complete = evaluate(comparison, [decision, decisionFor(comparison.transitions.slice(1), 'ADR-2')]);
   assert.equal(complete.status, 'admitted');
   assert.equal(complete.admittedTransitions.length, 2);
   assert.equal(complete.releaseEligible, false);
  });
  for (const [label, before, after] of [['before', [entry('A',otherDigest)], [entry('A',otherDigest)]], ['after', [], [entry('A',otherDigest)]]]) {
   test(`same decision ID cannot admit changed ${label} digest`, () => {
    const decision = decisionFor(compare([], [entry('A')]).transitions);
    const result = evaluate(compare(before, after), [decision]);
    assert.equal(result.status, 'rejected');
    assert.ok(codes(result).includes('growth-decision-stale'));
   });
  }
  test('count-preserving rename is remove plus add', () => {
   const result = compare([entry('A')], [entry('B')]);
   assert.equal(result.transitions.length, 2);
   assert.deepEqual(result.transitions.map(x => [x.coordinate.subject.canonicalReference,x.before.state,x.after.state]), [['A','present','absent'],['B','absent','present']]);
  });
  test('same symbol on two subpaths has distinct coordinates', () => {
   const result = compare([], [entry('A'), entry('A',digest,'./extra')]);
   assert.equal(new Set(result.transitions.map(x => x.fingerprint)).size, 2);
  });
  test('resolution target changes a value without changing the coordinate', () => {
   const branch = { ...coordinate(), resolutionBranch:[{condition:'import'}], subject:{kind:'export-branch'} };
   const result = compare([{coordinate:branch,value:{state:'present',digest}}], [{coordinate:branch,value:{state:'present',digest:otherDigest}}]);
   assert.equal(result.transitions.length, 1);
   assert.deepEqual(result.transitions[0].coordinate, branch);
   assert.equal(result.transitions[0].before.digest,digest);
   assert.equal(result.transitions[0].after.digest,otherDigest);
  });
  test('policy version changes atomic and group identity', () => {
   const transition = compare([], [entry('A')]).transitions[0];
   assert.notEqual(growthTransitionFingerprint({...transition,policyVersion:'foundation:sdk-growth:policy:2'},fingerprint), transition.fingerprint);
   assert.notEqual(growthGroupFingerprint([transition.fingerprint],fingerprint,'foundation:sdk-growth:policy:2'),growthGroupFingerprint([transition.fingerprint],fingerprint));
  });
  test('atomic payload matches independently specified canonical bytes', () => {
   const transition = compare([], [entry('A')]).transitions[0];
   const bytes = `{"after":{"digest":"${digest}","state":"present"},"before":{"state":"absent"},"coordinate":{"exportPath":".","packageName":"example","resolutionBranch":[],"subject":{"canonicalReference":"A","kind":"typed"}},"domain":"foundation:sdk-growth:transition:1","policyVersion":"${policyVersion}"}`;
   assert.equal(transition.fingerprint,`sha256:${fingerprint.sha256(bytes)}`);
  });
  test('input order, source commit and decision metadata do not change transition identity', () => {
   const a = compare([], [entry('A'),entry('B')]);
   const b = compare([], [entry('B'),entry('A')]);
   assert.deepEqual(a,b);
   const decision = decisionFor(a.transitions);
   assert.equal(growthDecisionDigest(decision,fingerprint),growthDecisionDigest({...decision,coordinates:decision.coordinates.toReversed(),transitions:decision.transitions.toReversed()},fingerprint));
   const after = observation([entry('A'),entry('B')]); after.sourceCommit='c'.repeat(40);
   const changed = compareGrowthSurfaces({trustedBefore:{status:'available',value:observation([])},candidateAfter:{status:'available',value:after}},fingerprint);
   assert.deepEqual(a.transitions,changed.transitions);
   assert.notEqual(a.after,changed.after);
  });
  for (const [label, mutate, code] of [
   ['duplicate ID', d => [d,d], 'growth-decision-duplicate'],
   ['overlapping decisions', d => [d,{...d,decisionId:'ADR-2'}], 'growth-decision-overlap'],
   ['malformed metadata', d => [{...d,ownerRef:''}], 'growth-decision-malformed'],
   ['overbroad transition set', d => [{...d,transitions:[...d.transitions,otherDigest]}], 'growth-decision-stale'],
   ['underbroad coordinate set', d => [{...d,coordinates:d.coordinates.slice(0,1)}], 'growth-decision-coordinate-mismatch'],
   ['mismatched group', d => [{...d,changeFingerprint:otherDigest}], 'growth-decision-fingerprint-mismatch'],
  ]) {
   test(`${label} rejects`, () => {
    const c = compare([], [entry('A'),entry('B')]), d = decisionFor(c.transitions);
    const result = evaluate(c,mutate(d));
    assert.equal(result.status,'rejected'); assert.ok(codes(result).includes(code));
   });
  }
  test('decision bytes and accepted ID alone do not prove owner authority', () => {
   const c = compare([], [entry('A')]), d = decisionFor(c.transitions);
   assert.equal(evaluate(c,[d],{authority:[]}).status,'incomplete');
   assert.equal(evaluate(c,[{...d,exposureRationale:'changed'}],{authority:[authorityFor(d)]}).status,'incomplete');
  });
  test('admission cannot override release compatibility failure', () => {
   const c = compare([], [entry('A')]);
   const result = evaluate(c,[decisionFor(c.transitions)],{compatibility:'rejected'});
   assert.equal(result.status,'rejected'); assert.ok(codes(result).includes('growth-compatibility-rejected'));
   assert.deepEqual(result.admittedTransitions,[]);
  });
  test('unavailable trusted input is incomplete, never an empty baseline', () => {
   const c = compareGrowthSurfaces({trustedBefore:{status:'unavailable',reasons:['shallow-history']},candidateAfter:{status:'available',value:observation([entry('A')])}},fingerprint);
   assert.equal(c.status,'incomplete'); assert.deepEqual(c.findings,[]);
   assert.equal(evaluate(c).status,'incomplete');
  });
  test('limited coverage cannot prove absence or equality', () => {
   const before = observation([]); before.coverage[0].dimensions.find(x => x.dimension==='typed').status='limited';
   const c = compareGrowthSurfaces({trustedBefore:{status:'available',value:before},candidateAfter:{status:'available',value:observation([entry('A')])}},fingerprint);
   assert.equal(c.status,'incomplete'); assert.deepEqual(c.findings,[]);
  });
  test('duplicate observation coordinates and no-change atomic claims are invalid', () => {
   assert.throws(() => compare([], [entry('A'),entry('A')]), /duplicate/u);
   assert.throws(() => growthTransitionFingerprint({coordinate:coordinate(),before:{state:'absent'},after:{state:'absent'},policyVersion},fingerprint),/no-change/u);
  });

  test('one S1 execution supplies admission and unchanged v1 compatibility branches', async () => {
   const f = useCaseFixture(); const result = await admitSdkGrowth(f.input,f.dependencies);
   assert.equal(result.admission.status,'admitted'); assert.equal(result.compatibility.status,'complete');
   assert.deepEqual(f.calls.map(x => x[0]),['observation','context']);
   assert.ok(f.calls.every(x => x[2] === f.input.cancellation));
   assert.deepEqual(f.calls[0][1],f.input.invocation);
  });
  test('actual retained v1 breaking change rejects despite exact growth approval', async () => {
   const f = useCaseFixture();
   f.context.released[0].evidence.typed.value.entrypoints[0].items = [{canonicalReference:'A',kind:'Function',parentKind:'EntryPoint',signature:'export function A(value: string): void;'}];
   const result = await admitSdkGrowth(f.input,f.dependencies);
   assert.equal(result.admission.status,'rejected');
   assert.equal(result.compatibility.status,'rejected'); assert.ok(result.compatibility.diagnostics.length > 0);
  });
  for (const [name, mutate, reason] of [
   ['envelope identity', f => { f.execution.identity = {...f.execution.identity,sourceCommit:'c'.repeat(40)}; }, 'growth-execution-identity-mismatch'],
   ['surface identity', f => { f.execution.surface.value.sourceTree='c'.repeat(40); }, 'growth-surface-identity-mismatch'],
   ['duplicate handoff', f => { f.execution.compatibilitySnapshots.push(f.execution.compatibilitySnapshots[0]); }, 'duplicate-growth-collection-key'],
   ['missing handoff', f => { f.execution.compatibilitySnapshots=[]; }, 'growth-compatibility-topology-mismatch'],
   ['substituted branch', f => { f.execution.compatibilitySnapshots[0].typed=f.execution.compatibilitySnapshots[0].artifact; }, 'growth-compatibility-branch-mismatch'],
   ['stale retained reference', f => { f.context.trustedBaseReference.value.surfaceDigest=otherDigest; }, 'growth-trusted-base-reference-mismatch']
  ]) { test(`S2 rejects ${name}`, async () => {
   const f=useCaseFixture(); mutate(f);
   await assert.rejects(admitSdkGrowth(f.input,f.dependencies), error => error.reason === reason);
  }); }
  for (const [name, mutate] of [
   ['shallow retained history', f => { f.context.retainedHistory={status:'unavailable',reasons:['shallow-history']}; }],
   ['retained chain target changed', f => { f.context.retainedHistory.value.targetSurfaceDigest=otherDigest; }],
   ['candidate authority', f => { f.context.authority={status:'unverified',reasons:['candidate-input']}; }],
   ['missing initial history', f => { f.context.released[0].evidence={kind:'initial-unreleased',history:{status:'unavailable',reasons:['missing-history']}}; }],
   ['unqualified initial history digest', f => { f.context.released[0].evidence={kind:'initial-unreleased',history:available(digest)}; delete f.context.released[0].qualification; }],
   ['mismatched initial history qualification', f => { f.context.released[0].evidence={kind:'initial-unreleased',history:available(digest)}; f.context.released[0].qualification={receiptDigest:otherDigest}; }],
   ['unavailable artifact branch', f => { f.execution.compatibilitySnapshots[0].artifact.snapshot={status:'unavailable',reasons:['lost-archive']}; }]
  ]) { test(`${name} remains incomplete`, async () => {
   const f=useCaseFixture(); mutate(f);
   const result = await admitSdkGrowth(f.input,f.dependencies);
   assert.equal(result.admission.status,'incomplete'); assert.equal(result.admission.releaseEligible,false);
   assert.deepEqual(result.released,f.context.released);
  }); }
  for (const boundary of ['observation','context']) {
   test(`cancellation during ${boundary} propagates original reason`, async () => {
    const f=useCaseFixture(), reason=new Error('cancelled'), controller=new AbortController();
    f.input.cancellation={signal:controller.signal,throwIfCancelled(){controller.signal.throwIfAborted();}};
    let entered;
    const started = new Promise(resolve => {entered=resolve;});
    f.dependencies[boundary][boundary === 'observation' ? 'observe' : 'read'] = async (_value, token) => {
     entered(); await new Promise((_resolve,reject) => { token.signal.addEventListener('abort',() => reject(new Error('io-aborted')),{once:true}); });
    };
    const running=admitSdkGrowth(f.input,f.dependencies);
    await started; controller.abort(reason);
    await assert.rejects(running,error => error === reason);
    if (boundary === 'observation') { assert.equal(f.calls.length,0); }
   });
   test(`${boundary} errors are preserved`, async () => {
    const f=useCaseFixture(), failure=new Error('unexpected');
    f.dependencies[boundary][boundary === 'observation' ? 'observe' : 'read'] = async () => {throw failure;};
    await assert.rejects(admitSdkGrowth(f.input,f.dependencies),error => error === failure);
   });
  }

  test('same decision ID with changed present before digest rejects', () => {
   const original = compare([entry('A')],[entry('A',otherDigest)]);
   const changed = compare([entry('A',`sha256:${'c'.repeat(64)}`)],[entry('A',otherDigest)]);
   assert.equal(evaluate(changed,[decisionFor(original.transitions)]).status,'rejected');
  });
  test('retained absent-to-A decision cannot authorize later A-to-B or collapsed absent-to-B', () => {
   const first = compare([], [entry('A')]); const d = decisionFor(first.transitions);
   assert.equal(evaluate(compare([entry('A')],[entry('A',otherDigest)]),[d]).status,'rejected');
   assert.equal(evaluate(compare([],[entry('A',otherDigest)]),[d]).status,'rejected');
  });
  for (const kind of ['typed', 'data', 'wildcard-member']) {
   test(`packed-only ${kind} cannot bypass release compatibility`, async () => {
    const f = useCaseFixture();
    f.execution.surface.value.entries = [];
    f.execution.compatibilitySnapshots[0].typed.snapshot = available(snapshot());
    const packed = structuredClone(f.context.packedCandidates[0]);
    packed.observation.entries = [{ coordinate: { ...coordinate('PackedOnly'), subject: kind === 'typed'
      ? { kind, canonicalReference: 'PackedOnly' } : { kind, member: 'dist/packed.json' } }, value: { state: 'present', digest } }];
    f.context.packedCandidates = [packed];
    f.dependencies.observation = createVerifiedGrowthObservation(f.dependencies.observation, { packedCandidates: () => f.context.packedCandidates, resolution: () => ({ grant: { metadataRoots: [] } }) });
    const comparison = compareGrowthSurfaces({ trustedBefore: f.context.trustedBase, candidateAfter: available(packed.observation) }, fingerprint);
    const decision = decisionFor(comparison.transitions);
    f.context.decisions = [decision];
    f.context.acceptedBreakingDecisions.growthDecisionAuthority = available([authorityFor(decision)]);
    delete f.context.released[0].releaseEvidence.value.declaredBump;
    const result = await admitSdkGrowth(f.input, f.dependencies);
    assert.equal(result.comparison.status, 'complete');
    assert.equal(result.comparison.transitions.length, 1);
    assert.equal(result.compatibility.status, 'incomplete');
    assert.ok(result.compatibility.reasons.includes(`example:${kind === 'typed' ? 'typed' : 'artifact'}:compatibility-evidence-unavailable`));
    assert.equal(result.admission.status, 'incomplete');
    assert.equal(result.admission.releaseEligible, false);
   });
  }

  test('removed package release obligations cannot disappear from context', async () => {
   const f=useCaseFixture();
   const before=f.context.trustedBase.value;
   before.coverage.push({...structuredClone(before.coverage[0]),packageName:'old-package'});
   before.entries.push({...entry('old'),coordinate:{...coordinate('old'),packageName:'old-package'}});
   const reference=growthObservationReference(before,fingerprint);
   f.context.trustedBaseReference=available(reference);
   f.context.retainedHistory=available({targetSurfaceDigest:reference.surfaceDigest,receiptDigest:digest});
   const c=compareGrowthSurfaces({trustedBefore:available(before),candidateAfter:f.execution.surface},fingerprint);
   const d=decisionFor(c.transitions); f.context.decisions=[d]; f.context.acceptedBreakingDecisions.growthDecisionAuthority=available([authorityFor(d)]);
   const result=await admitSdkGrowth(f.input,f.dependencies);
   assert.equal(result.admission.status,'incomplete');
   assert.ok(result.comparison.reasons.includes('growth-release-topology-mismatch'));
  });

  test('existing governance ACL preserves v1 and does not invent exact owner approval', async () => {
   const retained={acceptedDecisionIds:['ADR-1'],acceptedDecisionPaths:['docs/decisions/1.md']};
   const adapter=new GovernanceAcceptedDecisionEvidenceAcl(async () => retained);
   const request={consumerRoot:'.',baselinePath:'baseline.json',governanceConfigPath:'governance.yaml'};
   assert.equal(await adapter.readAcceptedDecisionEvidence(request),retained);
   const extended=await adapter.readAcceptedDecisionEvidence({...request,growthDecisions:[valid()]});
   assert.deepEqual(extended.acceptedDecisionIds,retained.acceptedDecisionIds);
   assert.equal(extended.growthDecisionAuthority.status,'unavailable');
   assert.deepEqual(extended.growthDecisionAuthority.reasons,['governance-exact-growth-owner-binding-unavailable']);
  });
  test('growth approval cannot establish private-only support classification', () => {
    const before = observation([entry('A')]), after = observation([entry('A')]);
    after.coverage[0].classification = 'private-only';
    const comparison = compareGrowthSurfaces({trustedBefore:available(before),candidateAfter:available(after)},fingerprint);
    assert.equal(evaluate(comparison).status,'incomplete');
    assert.ok(comparison.reasons.some(reason => reason.includes('private-classification-unqualified')));
  });

  test('group payload matches independent canonical bytes and excludes input order', () => {
    const bytes = `{"domain":"foundation:sdk-growth:group:1","policyVersion":"${policyVersion}","transitions":["${digest}","${otherDigest}"]}`;
    assert.equal(growthGroupFingerprint([otherDigest,digest],fingerprint),`sha256:${fingerprint.sha256(bytes)}`);
    assert.throws(() => growthGroupFingerprint([digest,digest],fingerprint),/duplicate/u);
  });
  test('release evidence from another package is an invariant failure', async () => {
    const f=useCaseFixture(); f.context.released[0].releaseEvidence.value.packageName='other';
    await assert.rejects(admitSdkGrowth(f.input,f.dependencies),error => error.reason === 'growth-release-evidence-package-mismatch');
  });

}
