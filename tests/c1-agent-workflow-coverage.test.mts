import assert from 'node:assert/strict';
import { existsSync, watch } from 'node:fs';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import test from 'node:test';
import { fixture, git, lint, tests, typecheck, policyInput, sha, execute, custodyFiles } from './c1-test-support.mts';
import { runCheckChangedAgentWorkflow } from '../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/application/use-cases/run-check-changed-agent-workflow.js';
import { createMutableCheckInputCustody } from '../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/outbound/filesystem/mutable-check-input-custody.js';
import type { CoverageCheckRunner } from '../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/application/ports/check-changed.js';

// Shared verbatim with the TEST child: subscribe before the first probe, and
// keep subscription lifetime separate from the child-readiness time budget.
function abaBarrier(probe:()=>boolean, subscribe:(notify:()=>void,fail:(error:unknown)=>void)=>()=>void, context:string,
  clock={set:(expire:()=>void)=>setTimeout(expire,20_000),clear:(timer:ReturnType<typeof setTimeout>)=>clearTimeout(timer)}) {
  let settled=false, closeWatcher:(()=>void)|undefined, timer:ReturnType<typeof setTimeout>|undefined;
  let resolvePromise!:()=>void,rejectPromise!:(error:unknown)=>void;
  const promise=new Promise<void>((resolve,reject)=>{resolvePromise=resolve;rejectPromise=reject;});
  void promise.catch(()=>{});
  function finish(error?:unknown) {
    if(settled){return;}settled=true;closeWatcher?.();
    if(timer!==undefined){clock.clear(timer);}
    if(error===undefined){resolvePromise();}else{rejectPromise(error);}
  }
  const sample=()=>{try{if(probe()){finish();}}catch(error){finish(error);}};
  try{closeWatcher=subscribe(sample,error=>finish(error));if(settled){closeWatcher();}else{sample();}}catch(error){finish(error);}
  return {promise,arm:()=>{if(!settled&&timer===undefined){timer=clock.set(()=>finish(new Error(`${context}: 20s barrier timed out`)));}},close:()=>finish(new Error(`${context}: barrier disposed`))};
}
function armAbaDispatch(executor:typeof execute,node:string,entrypoint:string,arm:()=>void):typeof execute {
  return async(command,args,options)=>{
    if(command===node&&args[0]===entrypoint&&args.at(-2)==='run'&&args.at(-1)==='typecheck'){arm();}
    return executor(command,args,options);
  };
}
async function awaitAbaPhase(barrier:ReturnType<typeof abaBarrier>,operation:Promise<unknown>,context:string):Promise<void> {
  await Promise.race([barrier.promise,operation.then(report=>{throw new Error(`${context}: workflow ended before barrier; report=${(JSON.stringify(report)??String(report)).slice(0,6000)}`);},error=>{throw new Error(`${context}: workflow rejected before barrier; error=${(error instanceof Error?`${error.name}: ${error.message}`:String(error)).slice(0,2000)}`,{cause:error});})]);
}

void test('C1 ABA barriers retain publication and start readiness budget at exact dispatch',async()=>{
  for(const preexisting of [true,false]) {
    let published=preexisting,closes=0,probes=0;
    const barrier=abaBarrier(()=>{probes++;return published;},()=>{published=true;return ()=>{closes++;};},'TEST immediate ready');
    await barrier.promise;barrier.close();assert.equal(probes,1);assert.equal(closes,1);
  }
  let timers=0,clears=0,closes=0;
  let expire!:()=>void;
  const pending=abaBarrier(()=>false,()=>()=>{closes++;},'TEST dispatch ready',{
    set:callback=>{timers++;expire=callback;return 1 as unknown as ReturnType<typeof setTimeout>;},clear:()=>{clears++;}
  });
  const executor=armAbaDispatch(async()=>({exitCode:0,signal:null,stdout:'',stderr:''}),'owned-node','owned-pnpm',pending.arm);
  for(const args of [['owned-pnpm','--version'],['owned-pnpm','config','get','key'],['other-pnpm','run','typecheck']]){await executor('owned-node',args,{cwd:'.'});}
  assert.equal(timers,0,'preflight must not consume child readiness budget');
  await executor('other-node',['owned-pnpm','run','typecheck'],{cwd:'.'});assert.equal(timers,0);
  await executor('owned-node',['owned-pnpm','--isolation','run','typecheck'],{cwd:'.'});
  pending.arm();assert.equal(timers,1,'only actual dispatch arms one deadline');
  expire();await assert.rejects(pending.promise,/TEST dispatch ready: 20s/u);pending.close();assert.equal(clears,1);assert.equal(closes,1);
  for(const operation of [Promise.resolve({outcome:'failed',reason:'preflight'}),Promise.reject(new Error('TEST qualification failure'))]) {
    let closed=0;
    const ready=abaBarrier(()=>false,()=>()=>{closed++;},'TEST frozen ready');
    try{await assert.rejects(awaitAbaPhase(ready,operation,'TEST frozen ready'),/workflow (ended|rejected) before barrier/u);}finally{ready.close();}
    assert.equal(closed,1);
  }
});

// RED: lint exit zero could incorrectly supply tests/typecheck. The oracle is
// independent: real compiler + real Node assertion must execute on source delta.
void test('C1 complete repository facets require real compiler and executed tests', async()=>fixture(async subject=>{
  await writeFile(join(subject.root,'src.ts'),'export const value: number = 2;\n');
  const {custody}=await subject.freeze();
  const report=await runCheckChangedAgentWorkflow({consumerRoot:subject.root,configPath:'workflow.json'}, {custody,runner:subject.runner(),loadPolicy:subject.loadPolicy});
  assert.equal(report.outcome,'passed',JSON.stringify(report));
  assert.deepEqual((await readdir(subject.output)).filter(name=>name.startsWith('check-observation-')),[]);
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
  const report=await runCheckChangedAgentWorkflow({consumerRoot:subject.root,configPath:'workflow.json'},{custody:createMutableCheckInputCustody(execute, custodyFiles),runner:subject.runner(),loadPolicy:subject.loadPolicy});
  assert.equal(report.outcome,'feedback-only'); assert.equal(report.inputCustody.binding,'unverified');
}));

// RED: an explicit failing prerequisite could be ignored, or substituted pnpm /
// effective lifecycle settings could be admitted as a pinned command.
void test('C1 prerequisite and executable configuration substitutions reject',async()=>fixture(async subject=>{
  const primary=new Error('TEST original assertion sentinel');
  await assert.rejects(fixture(async nested=>{
    const result=await execute(nested.tool.nodeExecutable,['-e',"process.stdout.write('TEST owned stdout');process.stderr.write('TEST owned stderr');process.exitCode=7"],{cwd:nested.root});
    assert.equal(result.exitCode,7);throw primary;
  }),error=>{
    assert.ok(error instanceof AggregateError);assert.equal(error.errors[0],primary,JSON.stringify(error.errors.slice(0,4).map(item=>item instanceof Error?{name:item.name,message:item.message.slice(0,512)}:{type:typeof item})));
    assert.ok(error.errors.some(item=>item instanceof Error&&item.message.includes('TEST owned stdout')&&item.message.includes('TEST owned stderr')));return true;
  });
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
  const output=subject.output;
  const compilerPath=join(dirname(dirname(subject.tool.nodeExecutable)),'node_modules/typescript/bin/tsc');
  subject.scripts['typecheck']=`${JSON.stringify(subject.tool.nodeExecutable)} compile.mts`;
  await writeFile(join(subject.root,'package.json'),JSON.stringify({type:'module',packageManager:'pnpm@11.20.0',scripts:subject.scripts}));
  await writeFile(join(subject.root,'workflow.json'),JSON.stringify(policyInput([typecheck],['typecheck'])));
  const invalid='export const value: number = "independent invalid input";\n';
  await writeFile(join(subject.root,'compile.mts'),`import {watch,writeFileSync,existsSync} from 'node:fs'; import {spawnSync} from 'node:child_process';
const output=${JSON.stringify(output)};
${abaBarrier.toString()}
async function barrier(name){const waiting=abaBarrier(()=>existsSync(output+'/'+name),(notify,fail)=>{const watcher=watch(output,notify);watcher.on('error',fail);return ()=>watcher.close();},'TEST child '+name);try{await waiting.promise;}finally{waiting.close();}}
writeFileSync(output+'/ready','started');await barrier('gate');
const result=spawnSync(${JSON.stringify(subject.tool.nodeExecutable)},[${JSON.stringify(compilerPath)},'--project','tsconfig.json','--pretty','false'],{encoding:'utf8'});
writeFileSync(output+'/compiler-diagnostic',result.stdout);writeFileSync(output+'/done',String(result.status));await barrier('ack');process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.status??1;\n`);
  for(const path of ['package.json','workflow.json','compile.mts']) {subject.files[path]=sha(await readFile(join(subject.root,path)));}
  await git(subject.root,'add','.');await git(subject.root,'commit','-m','test: ABA barrier');
  await writeFile(join(subject.root,'src.ts'),invalid);
  for(const frozen of [true,false]) {
    const {rm}=await import('node:fs/promises');
    for(const path of ['ready','gate','done','ack']) {await rm(join(output,path),{force:true});}
    const custody=frozen?(await subject.freeze()).custody:createMutableCheckInputCustody(execute, custodyFiles);
    const mode=frozen?'frozen':'mutable';
    function waitFile(name:string) {
      return abaBarrier(()=>existsSync(join(output,name)),(notify,fail)=>{const watcher=watch(output,notify);watcher.on('error',fail);return ()=>watcher.close();},`TEST ABA ${mode} ${name}`);
    }
    const ready=waitFile('ready');
    const executor=armAbaDispatch(execute,subject.tool.nodeExecutable,join(subject.tool.packageRoot,'bin/pnpm.mjs'),ready.arm);
    const operation=runCheckChangedAgentWorkflow({consumerRoot:subject.root,configPath:'workflow.json'},{custody,runner:subject.runner(undefined,subject.tool,executor),loadPolicy:subject.loadPolicy});
    let done:ReturnType<typeof abaBarrier>|undefined;
    try {
      await awaitAbaPhase(ready,operation,`TEST ABA ${mode} ready/dispatch`); await writeFile(join(subject.root,'src.ts'),'export const value: number = 10;\n');
      done=waitFile('done');done.arm();await writeFile(join(output,'gate'),'continue');await awaitAbaPhase(done,operation,`TEST ABA ${mode} done/compiler`);
      const compilerExit=Number(await readFile(join(output,'done'),'utf8'));
      await writeFile(join(subject.root,'src.ts'),invalid);await writeFile(join(output,'ack'),'restored');
      const report=await operation;
      assert.equal(report.outcome,frozen?'failed':'feedback-only',JSON.stringify({mode,report}));
      assert.equal(compilerExit,frozen?1:0,`TEST ABA ${mode} native compiler exit`);
      if(frozen) {assert.match(await readFile(join(output,'compiler-diagnostic'),'utf8'),/error TS2322/u);}
      assert.equal(await readFile(join(subject.root,'src.ts'),'utf8'),invalid);
      if(!frozen) {assert.equal(report.inputCustody.binding,'unverified');}
    } finally {
      // Settle the workflow and release both barriers even on timeout so the
      // child never outlives the fixture directory.
      await writeFile(join(output,'gate'),'continue').catch(()=>{});
      await writeFile(join(output,'ack'),'restored').catch(()=>{});
      ready.close();done?.close();
      await operation.catch(()=>{});
    }
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
  const command=createAgentWorkflowCheckChangedCommand({custody:createMutableCheckInputCustody(execute, custodyFiles),runner:createMutablePnpmCheckRunner({npmExecPath:join(subject.tool.packageRoot,'bin/pnpm.mjs'),nodeExecutablePath:subject.tool.nodeExecutable},execute),loadPolicy:subject.loadPolicy,writeReport:value=>{text=value;},setExitCode:value=>{exit=value;}});
  await command({consumerRoot:subject.root,configPath:'workflow.json',format:'json'});
  const report=JSON.parse(text) as {outcome:string;coverage:{state:string}[];steps:{qualifiedFacets:string[];commands:{script:string;exitCode:number|null}[]}[]};
  assert.equal(exit,0);assert.equal(report.outcome,'feedback-only');assert.ok(report.coverage.every(row=>row.state==='uncovered'));assert.deepEqual(report.steps[0]?.qualifiedFacets,[]);assert.deepEqual(report.steps[0]?.commands.map(c=>[c.script,c.exitCode]),[['typecheck',0]]);
  await writeFile(join(subject.root,'src.ts'),'export const value: number = "native error";\n');
  await command({consumerRoot:subject.root,configPath:'workflow.json',format:'json'});
  assert.equal(exit,1);assert.equal((JSON.parse(text) as {outcome:string}).outcome,'failed');
}));
