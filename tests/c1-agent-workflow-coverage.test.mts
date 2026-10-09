import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import test from 'node:test';
import { fixture, git, lint, tests, typecheck, policyInput, sha, execute } from './c1-test-support.mts';
import { runCheckChangedAgentWorkflow } from '../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/application/use-cases/run-check-changed-agent-workflow.js';
import { createMutableCheckInputCustody } from '../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/outbound/filesystem/mutable-check-input-custody.js';
import type { CoverageCheckRunner } from '../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/application/ports/check-changed.js';

// RED: lint exit zero could incorrectly supply tests/typecheck. The oracle is
// independent: real compiler + real Node assertion must execute on source delta.
void test('C1 complete repository facets require real compiler and executed tests', async()=>fixture(async subject=>{
  await writeFile(join(subject.root,'src.ts'),'export const value: number = 2;\n');
  const {custody}=await subject.freeze();
  const report=await runCheckChangedAgentWorkflow({consumerRoot:subject.root,configPath:'workflow.json'}, {custody,runner:subject.runner(),loadPolicy:subject.loadPolicy});
  assert.equal(report.outcome,'passed',JSON.stringify(report));
  assert.deepEqual(report.coverage.map(row=>[row.facet,row.state]),[['lint','checked'],['tests','checked'],['typecheck','checked']]);
  assert.equal(report.steps.find(step=>step.id==='tests')?.observation?.executed,1);
  assert.equal(report.steps.find(step=>step.id==='typecheck')?.commands[0]?.exitCode,0);
  assert.ok(report.steps.every(step=>step.durationMs>0));
  await assert.rejects(access(join(subject.output,'pre-sentinel')));
  await assert.rejects(access(join(subject.output,'post-sentinel')));
}));

// RED: a declared but absent facet or an empty plan used to become passed.
void test('C1 missing facet and successful no-op cannot claim coverage',async()=>fixture(async subject=>{
  await writeFile(join(subject.root,'workflow.json'),JSON.stringify(policyInput([lint])));
  subject.files['workflow.json']=sha(await readFile(join(subject.root,'workflow.json')));
  await writeFile(join(subject.root,'src.ts'),'export const value: number = 3;\n');
  let report=await runCheckChangedAgentWorkflow({consumerRoot:subject.root,configPath:'workflow.json'},{custody:(await subject.freeze()).custody,runner:subject.runner(),loadPolicy:subject.loadPolicy});
  assert.equal(report.outcome,'uncovered');
  assert.deepEqual([...new Set(report.coverage.filter(row=>row.state==='uncovered').map(row=>row.facet))],['tests','typecheck']);
  await writeFile(join(subject.root,'workflow.json'),JSON.stringify(policyInput([tests],['tests'])));
  await writeFile(join(subject.root,'mode.txt'),'noop');
  for(const path of ['workflow.json','mode.txt']) {subject.files[path]=sha(await readFile(join(subject.root,path)));}
  report=await runCheckChangedAgentWorkflow({consumerRoot:subject.root,configPath:'workflow.json'},{custody:(await subject.freeze()).custody,runner:subject.runner(),loadPolicy:subject.loadPolicy});
  assert.equal(report.outcome,'uncovered'); assert.equal(report.steps.length,1); assert.equal(report.steps[0]?.observation,null);
}));

// RED: empty, skipped-only or a failed assertion can be mistaken for successful
// testing; assertion failure must not disappear through a broader retry.
void test('C1 real empty skipped and assertion failures never supply tests',async()=>fixture(async subject=>{
  for(const mode of ['empty','skipped','failed']) {
    await writeFile(join(subject.root,'workflow.json'),JSON.stringify(policyInput([tests],['tests'])));
    await writeFile(join(subject.root,'mode.txt'),mode==='empty'?'empty':'positive');
    await writeFile(join(subject.root,'suite.mts'),mode==='skipped'?"import test from 'node:test'; test.skip('skipped fixture',()=>{});\n":"import test from 'node:test'; import assert from 'node:assert/strict'; test('failing fixture',()=>assert.fail('independent failure'));\n");
    for(const path of ['workflow.json','mode.txt','suite.mts']) {subject.files[path]=sha(await readFile(join(subject.root,path)));}
    const report=await runCheckChangedAgentWorkflow({consumerRoot:subject.root,configPath:'workflow.json'},{custody:(await subject.freeze()).custody,runner:subject.runner(),loadPolicy:subject.loadPolicy});
    assert.equal(report.outcome,mode==='failed'?'failed':'uncovered',JSON.stringify(report));
    assert.equal(report.steps.length,1);
    assert.ok(report.coverage.every(row=>row.state==='uncovered'));
  }
}));

// RED: a clean repository or exclusively excluded files could report checked.
void test('C1 no changes and explicit exclusions are not checked',async()=>fixture(async subject=>{
  let report=await runCheckChangedAgentWorkflow({consumerRoot:subject.root,configPath:'workflow.json'},{custody:(await subject.freeze()).custody,runner:subject.runner(),loadPolicy:subject.loadPolicy});
  assert.equal(report.outcome,'not-checked'); assert.equal(report.reason,'no-changes'); assert.equal(report.steps.length,0);
  const policy={...policyInput([lint]),exclusions:[{path:'notes.md',reason:'consumer explicitly excludes personal notes'}]};
  await writeFile(join(subject.root,'workflow.json'),JSON.stringify(policy));
  subject.files['workflow.json']=sha(await readFile(join(subject.root,'workflow.json')));
  await git(subject.root,'add','.'); await git(subject.root,'commit','-m','test: exclusion policy');
  await writeFile(join(subject.root,'notes.md'),'notes');
  report=await runCheckChangedAgentWorkflow({consumerRoot:subject.root,configPath:'workflow.json'},{custody:(await subject.freeze()).custody,runner:subject.runner(),loadPolicy:subject.loadPolicy});
  assert.equal(report.outcome,'not-checked'); assert.equal(report.steps.length,0); assert.equal(report.coverage[0]?.state,'explicitly-skipped');
}));

// RED: a mutable source can be promoted by matching hash brackets. This control
// runs the same real commands but always retains unverified custody.
void test('C1 mutable successful checks remain feedback only',async()=>fixture(async subject=>{
  await writeFile(join(subject.root,'src.ts'),'export const value: number = 4;\n');
  const report=await runCheckChangedAgentWorkflow({consumerRoot:subject.root,configPath:'workflow.json'},{custody:createMutableCheckInputCustody(execute),runner:subject.runner(),loadPolicy:subject.loadPolicy});
  assert.equal(report.outcome,'feedback-only'); assert.equal(report.inputCustody.binding,'unverified');
}));

// RED: an explicit failing prerequisite could be ignored, or substituted pnpm /
// effective lifecycle settings could be admitted as a pinned command.
void test('C1 prerequisite and executable configuration substitutions reject',async()=>fixture(async subject=>{
  const check={...tests,prerequisites:['prerequisite']};
  await writeFile(join(subject.root,'workflow.json'),JSON.stringify(policyInput([check],['tests'])));
  subject.files['workflow.json']=sha(await readFile(join(subject.root,'workflow.json')));
  let report=await runCheckChangedAgentWorkflow({consumerRoot:subject.root,configPath:'workflow.json'},{custody:(await subject.freeze()).custody,runner:subject.runner(),loadPolicy:subject.loadPolicy});
  assert.equal(report.outcome,'failed'); assert.deepEqual(report.steps[0]?.commands.map(command=>[command.script,command.exitCode]),[['prerequisite',7]]);
  assert.equal(report.steps[0]?.observation,null);
  report=await runCheckChangedAgentWorkflow({consumerRoot:subject.root,configPath:'workflow.json'},{custody:(await subject.freeze()).custody,runner:subject.runner(undefined,{...subject.tool,entrypointSha256:'0'.repeat(64)}),loadPolicy:subject.loadPolicy});
  assert.equal(report.outcome,'failed'); assert.equal(report.steps.length,0);
  // Executable closure has admitted original package.json bytes, so a changed
  // lifecycle setting in an enclosing config cannot retain admission.
  await writeFile(join(subject.root,'.npmrc'),'enable-pre-post-scripts=false\n');
  subject.files['.npmrc']=sha(await readFile(join(subject.root,'.npmrc')));
  const frozen=await subject.freeze();
  const runner=subject.runner(async(lease)=>{await writeFile(join(lease.executionRoot,'.npmrc'),'enable-pre-post-scripts=true\n');});
  report=await runCheckChangedAgentWorkflow({consumerRoot:subject.root,configPath:'workflow.json'},{custody:frozen.custody,runner,loadPolicy:subject.loadPolicy});
  assert.equal(report.outcome,'stale'); assert.equal(report.steps.length,0);
  await assert.rejects(access(join(subject.output,'pre-sentinel')));
}));

// RED: abort or persistent drift must never become successful coverage.
void test('C1 cancellation and stale closure cannot pass',async()=>fixture(async subject=>{
  await writeFile(join(subject.root,'src.ts'),'export const value: number = 5;\n');
  const cancellation=new AbortController(); cancellation.abort();
  const report=await runCheckChangedAgentWorkflow({consumerRoot:subject.root,configPath:'workflow.json',signal:cancellation.signal},{custody:(await subject.freeze()).custody,runner:subject.runner(),loadPolicy:subject.loadPolicy});
  assert.equal(report.outcome,'cancelled'); assert.equal(report.steps.length,0);
  const frozen=await subject.freeze();
  const inner=subject.runner();
  const runner:CoverageCheckRunner={run:async input=>{const result=await inner.run(input);await writeFile(join(input.lease.executionRoot,'src.ts'),'export const value: number = "bad";\n');return result;}};
  const stale=await runCheckChangedAgentWorkflow({consumerRoot:subject.root,configPath:'workflow.json'},{custody:frozen.custody,runner,loadPolicy:subject.loadPolicy});
  assert.equal(stale.outcome,'stale'); assert.ok(stale.coverage.every(row=>row.state==='stale'));
}));

// RED: invalid→valid→invalid between equal hash brackets can create false PASS.
// A real child barrier starts before mutation, then invokes the native project
// compiler against the admitted closure, with outputs and synchronization outside.
void test('C1 frozen influencing closure rejects real ABA while mutable remains unverified',{timeout:60_000},async()=>fixture(async subject=>{
  const fs=await import('node:fs');
  const output=subject.output;
  const compilerPath=join(dirname(dirname(subject.tool.nodeExecutable)),'node_modules/typescript/bin/tsc');
  subject.scripts['typecheck']=`${JSON.stringify(subject.tool.nodeExecutable)} compile.mts`;
  await writeFile(join(subject.root,'package.json'),JSON.stringify({type:'module',packageManager:'pnpm@11.20.0',scripts:subject.scripts}));
  await writeFile(join(subject.root,'workflow.json'),JSON.stringify(policyInput([typecheck],['typecheck'])));
  const invalid='export const value: number = "independent invalid input";\n';
  await writeFile(join(subject.root,'compile.mts'),`import {watch,writeFileSync,existsSync} from 'node:fs'; import {spawnSync} from 'node:child_process';
const output=${JSON.stringify(output)};
async function barrier(name){if(existsSync(output+'/'+name))return;await new Promise(resolve=>{const watcher=watch(output,()=>{if(existsSync(output+'/'+name)){watcher.close();resolve();}});});}
writeFileSync(output+'/ready','started');await barrier('gate');
const result=spawnSync(${JSON.stringify(subject.tool.nodeExecutable)},[${JSON.stringify(compilerPath)},'--project','tsconfig.json','--pretty','false'],{encoding:'utf8'});
writeFileSync(output+'/compiler-diagnostic',result.stdout);writeFileSync(output+'/done',String(result.status));await barrier('ack');process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.status??1;\n`);
  for(const path of ['package.json','workflow.json','compile.mts']) {subject.files[path]=sha(await readFile(join(subject.root,path)));}
  await git(subject.root,'add','.');await git(subject.root,'commit','-m','test: ABA barrier');
  await writeFile(join(subject.root,'src.ts'),invalid);
  for(const frozen of [true,false]) {
    const {rm}=await import('node:fs/promises');
    for(const path of ['ready','gate','done','ack']) {await rm(join(output,path),{force:true});}
    const custody=frozen?(await subject.freeze()).custody:createMutableCheckInputCustody(execute);
    async function waitFile(name:string) {
      const path=join(output,name);try {await access(path);return;}catch{}
      await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{watcher.close();reject(new Error('TEST ABA barrier timed out'));},20_000);const watcher=fs.watch(output,()=>{void access(path).then(()=>{clearTimeout(timer);watcher.close();resolve();return null;},()=>null);});});
    }
    const ready=waitFile('ready');
    const operation=runCheckChangedAgentWorkflow({consumerRoot:subject.root,configPath:'workflow.json'},{custody,runner:subject.runner(),loadPolicy:subject.loadPolicy});
    await ready; await writeFile(join(subject.root,'src.ts'),'export const value: number = 10;\n');
    const done=waitFile('done');await writeFile(join(output,'gate'),'continue');await done;
    const compilerExit=Number(await readFile(join(output,'done'),'utf8'));
    await writeFile(join(subject.root,'src.ts'),invalid);await writeFile(join(output,'ack'),'restored');
    const report=await operation;
    assert.equal(report.outcome,frozen?'failed':'feedback-only',JSON.stringify(report));
    assert.equal(compilerExit,frozen?1:0);
    if(frozen) {assert.match(await readFile(join(output,'compiler-diagnostic'),'utf8'),/error TS2322/u);}
    assert.equal(await readFile(join(subject.root,'src.ts'),'utf8'),invalid);
    if(!frozen) {assert.equal(report.inputCustody.binding,'unverified');}
  }
}));

// RED: the current Host feedback composition could grant qualified facets,
// skip the real native compiler, or accidentally enable implicit lifecycle.
void test('C1 mutable adapter runs real commands with no qualified facets',async()=>fixture(async subject=>{
  const {createMutablePnpmCheckRunner}=await import('../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/outbound/pnpm/mutable-pnpm-check-runner.js');
  const {createAgentWorkflowCheckChangedCommand}=await import('../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/inbound/cli/check-changed-command.js');
  await writeFile(join(subject.root,'workflow.json'),JSON.stringify(policyInput([typecheck],['typecheck'])));
  await writeFile(join(subject.root,'src.ts'),'export const value: number = 6;\n');
  let text='',exit=-1;
  const command=createAgentWorkflowCheckChangedCommand({custody:createMutableCheckInputCustody(execute),runner:createMutablePnpmCheckRunner({npmExecPath:join(subject.tool.packageRoot,'bin/pnpm.mjs')},execute),loadPolicy:subject.loadPolicy,writeReport:value=>{text=value;},setExitCode:value=>{exit=value;}});
  await command({consumerRoot:subject.root,configPath:'workflow.json',format:'json'});
  const report=JSON.parse(text) as {outcome:string;coverage:{state:string}[];steps:{qualifiedFacets:string[];commands:{script:string;exitCode:number|null}[]}[]};
  assert.equal(exit,0);assert.equal(report.outcome,'feedback-only');assert.ok(report.coverage.every(row=>row.state==='uncovered'));assert.deepEqual(report.steps[0]?.qualifiedFacets,[]);assert.deepEqual(report.steps[0]?.commands.map(c=>[c.script,c.exitCode]),[['typecheck',0]]);
  await writeFile(join(subject.root,'src.ts'),'export const value: number = "native error";\n');
  await command({consumerRoot:subject.root,configPath:'workflow.json',format:'json'});
  assert.equal(exit,1);assert.equal((JSON.parse(text) as {outcome:string}).outcome,'failed');
}));
