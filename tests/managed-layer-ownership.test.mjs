import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { validateModule, classify } from '../scripts/feature-modules/profile.mjs';
import { observeDependencies, validateSurfaces, validateObservations, validateTopology } from '../scripts/feature-modules/dependencies.mjs';
import { indexSurfaces, surfaceBindings } from '../scripts/feature-modules/surfaces.mjs';
import { OxcSourceDependencyParser } from '../packages/engineering-foundation/dist/capabilities/source-dependencies/adapters/outbound/oxc/oxc-source-dependency-parser.js';

const repositoryRoot=fileURLToPath(new URL('..',import.meta.url));
const profile=JSON.parse(await readFile(new URL('../architecture/foundation/feature-modules.json',import.meta.url),'utf8'));
const module=profile.modules.find(item=>item.id==='docs-protocol-agent-teams');
const policy=YAML.parse(await readFile(new URL('../architecture/foundation/source-dependencies.yaml',import.meta.url),'utf8'));
const problems=[];
const files=await validateModule(repositoryRoot,module,problems);
const observed=await observeDependencies(repositoryRoot,'architecture/foundation/source-dependencies.yaml');
const own=(path)=>path.startsWith(module.sourceRoot+'/');
const surfaceProblems=[];
const surfaces=await validateSurfaces({ repositoryRoot,profile,policy,files:[...observed.sourceSnapshots.keys()],...observed },surfaceProblems);
const local=observed.observations.filter(o=>own(o.path)&&o.result.kind!=='workspace-package');
validateObservations(profile,policy,observed.observations,problems,surfaces);
const topologyProblems=[];
validateTopology({modules:[module]}, {schemaVersion:2,boundaries:policy.boundaries.filter(b=>b.id.startsWith('docs-protocol-agent-teams.'))},topologyProblems);
const generated=`${module.sourceRoot}/consumer-integration/generated/canonical-assets.ts`;
assert.equal(classify(generated,profile).feature.id,'consumer-integration');
assert.equal(classify(generated,profile).layer.role,'application');
assert.equal(classify(generated,profile).provenance,'generated');
const appPath=`${module.sourceRoot}/consumer-integration/application/policies/consumer-integration-assets.ts`;
const parser=new OxcSourceDependencyParser();
const ownSurfaceProblems=surfaceProblems.filter(p=>p.message.includes(module.sourceRoot));
const report={ownSurfaceProblems,scope:'Managed module ownership, generated provenance, local layer graph and declared feature topology; package and repository-wide adoption are separate.',files:files.length,problems,topologyProblems,sourceDiagnostics:observed.diagnostics.filter(d=>JSON.stringify(d).includes('docs-protocol-agent-teams')),localObservations:local.length};
test("managed owners, generated provenance and real thin process assembly conform", () => {
  assert.deepEqual(problems,[]);
  assert.deepEqual(topologyProblems,[]);
  assert.deepEqual(ownSurfaceProblems,[]);
  assert.deepEqual(report.sourceDiagnostics,[]);
});
function checkCase(name, path, source, result, expectedCodes) {
  test(name, () => {
  const references=parser.parse({path,source}).references;
  assert.equal(references.length,1,name);
  const reference=references[0];
  const observation={...result,path,reference};
  const snapshots=new Map(observed.sourceSnapshots); snapshots.set(path,source);
  const issues=[];
  const sources=indexSurfaces([...snapshots.keys()],issues,snapshots);
  const observations=[...observed.observations.filter(o=>o.path!==path),observation];
  const bindings=surfaceBindings(profile,policy,observations,sources);
  validateObservations(profile,policy,observations,issues,{sources,bindings});
  // The complete real graph above checks primitive caller liveness. Replacing a
  // source here can remove those uses; these cases assert only the synthetic edge.
  const edgeIssues=issues.filter(problem=>problem.message.startsWith(`${path} -> `));
  assert.deepEqual([...new Set(edgeIssues.map(p=>p.code))].toSorted(),expectedCodes.toSorted(),name);
  });
}
const mutation=observed.observations.find(o=>o.path===`${module.sourceRoot}/consumer-integration/composition/known-file-transaction.ts`&&o.reference.specifier==='@agent-teams/repository-mutation');
const crypto=observed.observations.find(o=>own(o.path)&&o.reference.specifier==='node:crypto');
assert.ok(mutation);assert.ok(crypto);
checkCase('pure known-file compiler from supported package root',appPath,
 'import { compileKnownFileTransactionPlan } from "@agent-teams/repository-mutation"; export const compile = compileKnownFileTransactionPlan;',mutation,[]);
checkCase('concrete package inspection rejected in application',appPath,
 'import { inspectKnownFileTransactionBarrier } from "@agent-teams/repository-mutation"; export const inspect = inspectKnownFileTransactionBarrier;',mutation,['layer-direction']);
checkCase('type-only concrete inspection rejected in application',appPath,
 'import type { KnownFileTransactionBarrierInspection } from "@agent-teams/repository-mutation"; export type Observation = KnownFileTransactionBarrierInspection;',mutation,['layer-direction']);
checkCase('re-export cannot hide concrete inspection',appPath,
 'export { inspectKnownFileTransactionBarrier } from "@agent-teams/repository-mutation";',mutation,['layer-direction']);
checkCase('generated application data does not exempt concrete imports',generated,
 'export { inspectKnownFileTransactionBarrier } from "@agent-teams/repository-mutation";',mutation,['layer-direction']);
checkCase('fixed-byte SHA256 remains a pure application operation',appPath,
 'import { createHash } from "node:crypto"; export function digest(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }',crypto,[]);
checkCase('random UUID is not fixed-byte hashing',appPath,
 'import { randomUUID } from "node:crypto"; export const id = randomUUID();',crypto,['inner-infrastructure']);
