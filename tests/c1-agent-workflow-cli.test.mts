import assert from 'node:assert/strict';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fixture, git, lint, typecheck, policyInput, execute } from './c1-test-support.mts';

// Point this at the installed candidate's actual dist/cli.js for archive proof.
// The unintegrated checkpoint must fail these tests, not skip or fake a route.
const cli=process.env['C1_CANDIDATE_CLI']??fileURLToPath(new URL('../packages/engineering-foundation/dist/cli.js',import.meta.url));
async function declare(root:string) {
  await writeFile(join(root,'foundation.config.yaml'),'schemaVersion: 1\nproject:\n  id: c1-disposable-test\ncapabilities:\n  repository.agent-workflow:\n    configPath: workflow.yaml\n');
}
async function invoke(root:string,subcommand:string) {
  return execute(process.execPath,[cli,'agent-workflow',subcommand,'--consumer',root,'--format','json'],{cwd:root});
}

// RED: adding the route can replace historical v1, or rejection can happen
// after scripts execute. The actual child marker independently detects effects.
void test('C1 candidate CLI preserves changed v1 and rejects v1 on successor without scripts',async()=>fixture(async subject=>{
  await declare(subject.root);
  const marker=join(subject.output,'old-script-ran');
  await writeFile(join(subject.root,'lint.mts'),`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'old v1 executed');\n`);
  const old={schemaVersion:1,instructions:policyInput([lint]).instructions,scripts:{changed:'check:changed',fast:'lint',full:'lint'},changedChecks:[{id:'lint',script:'lint',extensions:['.ts'],passPaths:false}],fullScanPaths:['tool-control']};
  await writeFile(join(subject.root,'workflow.yaml'),JSON.stringify(old));
  await git(subject.root,'add','.');await git(subject.root,'commit','-m','test: historical v1 CLI');
  await writeFile(join(subject.root,'src.ts'),'export const value=2;\n');
  const historical=await invoke(subject.root,'changed');
  assert.equal(historical.exitCode,0,historical.stderr||historical.stdout);
  assert.equal((JSON.parse(historical.stdout) as {outcome:string}).outcome,'passed');
  assert.equal(await readFile(marker,'utf8'),'old v1 executed');await rm(marker);
  const successor=await invoke(subject.root,'check-changed');
  assert.equal(successor.exitCode,1);
  assert.match(successor.stdout+successor.stderr,/Migrate changedChecks/u);
  await assert.rejects(access(marker));
  const schema=await execute(process.execPath,[cli,'schema','repository-agent-workflow/v1'],{cwd:subject.root});
  assert.equal(schema.exitCode,0);assert.equal((JSON.parse(schema.stdout) as {properties:{schemaVersion:{const:number}}}).properties.schemaVersion.const,1);
}));

// RED: candidate wiring can omit v2 schema, pass invalid source, or fabricate
// Host-qualified facets from mutable successful native commands.
void test('C1 candidate v2 CLI runs native compiler and retains mutable feedback limitations',async()=>fixture(async subject=>{
  await declare(subject.root);
  await writeFile(join(subject.root,'workflow.yaml'),JSON.stringify(policyInput([typecheck],['typecheck'])));
  await git(subject.root,'add','.');await git(subject.root,'commit','-m','test: v2 CLI migration');
  await writeFile(join(subject.root,'src.ts'),'export const value: number = "actual native type error";\n');
  const invalid=await invoke(subject.root,'check-changed');assert.equal(invalid.exitCode,1);
  const rejected=JSON.parse(invalid.stdout) as {outcome:string;steps:{commands:{exitCode:number|null}[]}[]};
  assert.equal(rejected.outcome,'failed',invalid.stdout);assert.equal(rejected.steps[0]?.commands[0]?.exitCode,1);
  await writeFile(join(subject.root,'src.ts'),'export const value: number = 2;\n');
  const valid=await invoke(subject.root,'check-changed');assert.equal(valid.exitCode,0,valid.stdout+valid.stderr);
  const feedback=JSON.parse(valid.stdout) as {reportSchemaVersion:number;outcome:string;inputCustody:{binding:string};coverage:{state:string}[];steps:{qualifiedFacets:string[]}[]};
  assert.equal(feedback.reportSchemaVersion,2);assert.equal(feedback.outcome,'feedback-only');assert.equal(feedback.inputCustody.binding,'unverified');
  assert.ok(feedback.coverage.every(row=>row.state!=='checked'));assert.ok(feedback.steps.every(step=>step.qualifiedFacets.length===0));
  const schema=await execute(process.execPath,[cli,'schema','repository-agent-workflow/v2'],{cwd:subject.root});assert.equal(schema.exitCode,0);assert.equal((JSON.parse(schema.stdout) as {properties:{schemaVersion:{const:number}}}).properties.schemaVersion.const,2);
}));
