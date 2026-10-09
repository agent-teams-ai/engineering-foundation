import assert from 'node:assert/strict';
import { access, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fixture, git, lint, tests, typecheck, policyInput, sha, execute, testRunnerIdentity } from './c1-test-support.mts';
import { runCheckChangedAgentWorkflow } from '../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/application/use-cases/run-check-changed-agent-workflow.js';
import { parseAgentWorkflowPolicyV2 } from '../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/inbound/configuration/parse-agent-workflow-policy-v2.js';

async function waitFile(path: string): Promise<void> {
  try { await access(path); return; } catch {}
  await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>{watcher.close();reject(new Error('TEST command did not reach barrier'));},20_000);
    const watcher=watch(join(path,'..'),()=>{void access(path).then(()=>{clearTimeout(timer);watcher.close();resolve();return null;},()=>null);});
    void access(path).then(()=>{clearTimeout(timer);watcher.close();resolve();return null;},()=>null);
  });
}

// RED on accepted seed: actual successful command followed by source/config/
// executable revocation loses its execution history. No qualified facet survives.
void test('C1 actual run then revoke retains trace and rejects every revoked input',async()=>fixture(async subject=>{
  await writeFile(join(subject.root,'workflow.json'),JSON.stringify(policyInput([lint],['lint'])));
  await writeFile(join(subject.root,'lint.mts'),`import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(subject.output,'ran'))},'actual command completed');\n`);
  for(const path of ['workflow.json','lint.mts']) {subject.files[path]=sha(await readFile(join(subject.root,path)));}
  for(const revoked of ['src.ts','workflow.json','tool']) {
    const frozen=await subject.freeze();
    let ran=false;
    const runner=subject.runner(undefined,subject.tool,async(command,args,options)=>{
      const result=await execute(command,args,options);
      if(args.includes('run')) {
        ran=true;
        if(revoked==='tool') {await writeFile(join(subject.tool.packageRoot,'bin/pnpm.mjs'),'// revoked TEST tool\n');}
        else {await writeFile(join(options.cwd,revoked),revoked==='src.ts'?'export const value: number = "bad";\n':'{}');}
      }
      return result;
    });
    const report=await runCheckChangedAgentWorkflow({consumerRoot:subject.root,configPath:'workflow.json'},{custody:frozen.custody,runner,loadPolicy:subject.loadPolicy});
    assert.equal(ran,true); assert.equal(await readFile(join(subject.output,'ran'),'utf8'),'actual command completed');
    assert.equal(report.outcome,'stale',JSON.stringify(report));
    assert.equal(report.steps.length,1); assert.deepEqual(report.steps[0]?.commands.map(c=>[c.script,c.exitCode]),[['lint',0]]);
    assert.ok(report.steps[0].durationMs>0); assert.deepEqual(report.steps[0].qualifiedFacets,[]);
    assert.ok(report.coverage.every(row=>row.state==='stale'));
  }
}));

// RED: cancellation while the actual script is alive could erase the started
// command, supply a facet, or proceed to a later step.
void test('C1 mid command cancellation retains interrupted history without coverage',{timeout:60_000},async()=>fixture(async subject=>{
  const ready=join(subject.output,'ready');
  await writeFile(join(subject.root,'lint.mts'),`import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(ready)},'alive');setInterval(()=>{},1000);\n`);
  subject.files['lint.mts']=sha(await readFile(join(subject.root,'lint.mts')));
  await writeFile(join(subject.root,'src.ts'),'export const value=2;\n');
  const cancellation=new AbortController();
  const runner=subject.runner(undefined,subject.tool,async(command,args,options)=>{
    const operation=execute(command,args,options);
    if(args.includes('run')) { await waitFile(ready); cancellation.abort(); }
    return operation;
  });
  const report=await runCheckChangedAgentWorkflow({consumerRoot:subject.root,configPath:'workflow.json',signal:cancellation.signal},{custody:(await subject.freeze()).custody,runner,loadPolicy:subject.loadPolicy});
  assert.equal(report.outcome,'cancelled',JSON.stringify(report)); assert.equal(report.steps.length,1);
  assert.equal(report.steps[0]?.commands.length,1); assert.equal(report.steps[0]?.commands[0]?.script,'lint');
  assert.ok(report.steps[0].durationMs>0); assert.ok(report.steps.every(step=>step.qualifiedFacets.length===0));
  assert.ok(report.coverage.every(row=>row.state!=='checked'));
}));

// RED: unknown files can pass through an inadequate fallback. Adequacy is
// derived from explicit required facets, never check names or exit zero alone.
void test('C1 unknown paths require adequate real repository escalation',async()=>fixture(async subject=>{
  const adequate={...typecheck,id:'all',prerequisites:['lint'],supplies:['lint','typecheck'] as const};
  const input={...policyInput([lint,adequate],['lint','typecheck']),scopes:[{id:'source',roots:['src.ts'],requiredFacets:['lint','typecheck'],checks:['lint']}],escalationCheck:'all'};
  await writeFile(join(subject.root,'workflow.json'),JSON.stringify(input));
  subject.files['workflow.json']=sha(await readFile(join(subject.root,'workflow.json')));
  await git(subject.root,'add','.');await git(subject.root,'commit','-m','test: scoped escalation');
  await writeFile(join(subject.root,'unknown.txt'),'unknown TEST source');
  let report=await runCheckChangedAgentWorkflow({consumerRoot:subject.root,configPath:'workflow.json'},{custody:(await subject.freeze()).custody,runner:subject.runner(),loadPolicy:subject.loadPolicy});
  assert.equal(report.outcome,'passed'); assert.deepEqual(report.plannedChecks.map(check=>check.id),['all']);
  assert.deepEqual(report.steps[0]?.commands.map(command=>command.script),['lint','typecheck']);assert.ok(report.plannedChecks[0]?.reason.includes('Unknown'));
  // A known path with an incomplete declared mapping must also use the
  // adequate fallback, instead of stopping with unused available coverage.
  await rm(join(subject.root,'unknown.txt'));
  await writeFile(join(subject.root,'src.ts'),'export const value: number = 2;\n');
  report=await runCheckChangedAgentWorkflow({consumerRoot:subject.root,configPath:'workflow.json'},{custody:(await subject.freeze()).custody,runner:subject.runner(),loadPolicy:subject.loadPolicy});
  assert.equal(report.outcome,'passed');assert.deepEqual(report.plannedChecks.map(check=>check.id),['all','lint']);
  assert.equal(report.plannedChecks.find(check=>check.id==='all')?.reason.includes('Required facet missing'),true);
  await writeFile(join(subject.root,'workflow.json'),JSON.stringify({...input,checks:[lint,{...adequate,supplies:['lint']}]}));
  subject.files['workflow.json']=sha(await readFile(join(subject.root,'workflow.json')));
  report=await runCheckChangedAgentWorkflow({consumerRoot:subject.root,configPath:'workflow.json'},{custody:(await subject.freeze()).custody,runner:subject.runner(),loadPolicy:subject.loadPolicy});
  assert.equal(report.outcome,'uncovered');assert.ok(report.coverage.some(row=>row.facet==='typecheck'&&row.state==='uncovered'));
}));

// RED: C1 overlaps could silently choose just one scope; explicit exclusions
// must not hide a simultaneously changed source path requiring the union.
void test('C1 overlap uses required facet union and exclusion stays path local',async()=>fixture(async subject=>{
  const input={...policyInput([lint,typecheck]),scopes:[{id:'wide',roots:['src'],requiredFacets:['lint'],checks:['lint']},{id:'nested',roots:['src/nested'],requiredFacets:['typecheck'],checks:['typecheck']}],exclusions:[{path:'notes',reason:'TEST notes explicitly excluded'}]};
  const {mkdir}=await import('node:fs/promises');await mkdir(join(subject.root,'src/nested'),{recursive:true});
  await writeFile(join(subject.root,'workflow.json'),JSON.stringify(input));
  await writeFile(join(subject.root,'tsconfig.json'),JSON.stringify({compilerOptions:{strict:true,noEmit:true,types:[],target:'ES2024',module:'NodeNext'},include:['src.ts','src/**/*.ts']}));
  await writeFile(join(subject.root,'lint.mts'),`import {readFileSync} from 'node:fs';for(const path of ['src.ts','src/nested/edit.ts']){if(readFileSync(path,'utf8').includes('forbidden'))process.exitCode=1;}\n`);
  for(const path of ['workflow.json','tsconfig.json','lint.mts']) {subject.files[path]=sha(await readFile(join(subject.root,path)));}
  await git(subject.root,'add','.');await git(subject.root,'commit','-m','test: overlapping scopes');
  await writeFile(join(subject.root,'src/nested/edit.ts'),'export const changed=true;\n');await mkdir(join(subject.root,'notes'));await writeFile(join(subject.root,'notes/edit.md'),'excluded');
  const report=await runCheckChangedAgentWorkflow({consumerRoot:subject.root,configPath:'workflow.json'},{custody:(await subject.freeze()).custody,runner:subject.runner(),loadPolicy:subject.loadPolicy});
  assert.equal(report.outcome,'passed');assert.deepEqual(report.steps.map(step=>step.id),['lint','typecheck']);
  assert.deepEqual(report.coverage.map(row=>[row.path,row.facet,row.state]),[['notes/edit.md',null,'explicitly-skipped'],['src/nested/edit.ts','lint','checked'],['src/nested/edit.ts','typecheck','checked']]);
  assert.throws(()=>parseAgentWorkflowPolicyV2({...input,exclusions:[{path:'notes',reason:''}]}));
  await writeFile(join(subject.root,'src/nested/edit.ts'),'export const changed: number = "actual nested type error";\n');
  const invalid=await runCheckChangedAgentWorkflow({consumerRoot:subject.root,configPath:'workflow.json'},{custody:(await subject.freeze()).custody,runner:subject.runner(),loadPolicy:subject.loadPolicy});
  assert.equal(invalid.outcome,'failed');assert.equal(invalid.steps.find(step=>step.id==='typecheck')?.commands[0]?.exitCode,1);
}));

// RED: only a confirmed actual empty dispatch permits a single escalation;
// forged bindings must not qualify tests or be interpreted as empty selection.
void test('C1 real empty selection escalates once while forged observations reject',async()=>fixture(async subject=>{
  const broad={...tests,id:'broad',script:'broad'};
  subject.scripts['broad']=subject.scripts['tests']!;
  await writeFile(join(subject.root,'package.json'),JSON.stringify({type:'module',packageManager:'pnpm@11.20.0',scripts:subject.scripts}));
  let wrapper=await readFile(join(subject.root,'observe.mts'),'utf8');
  wrapper=wrapper.replace("const mode=readFileSync('mode.txt','utf8').trim();","const mode=binding.checkId==='tests'?'empty':'positive';");
  await writeFile(join(subject.root,'observe.mts'),wrapper);
  const input={...policyInput([tests,broad],['tests']),scopes:[{id:'repository',roots:['*'],requiredFacets:['tests'],checks:['tests']}],escalationCheck:'broad'};
  await writeFile(join(subject.root,'workflow.json'),JSON.stringify(input));
  for(const path of ['package.json','workflow.json','observe.mts']){subject.files[path]=sha(await readFile(join(subject.root,path)));}
  let report=await runCheckChangedAgentWorkflow({consumerRoot:subject.root,configPath:'workflow.json'},{custody:(await subject.freeze()).custody,runner:subject.runner(),loadPolicy:subject.loadPolicy});
  assert.equal(report.outcome,'passed',JSON.stringify(report));assert.deepEqual(report.steps.map(step=>[step.id,step.observation?.outcome]),[['tests','empty-selection'],['broad','passed']]);
  assert.equal(report.steps[1]?.observation?.executed,1);assert.equal(report.plannedChecks[1]?.reason,'Confirmed empty test selection.');
  for(const field of ['invocationId','sourceIdentity','configIdentity','checkId','runnerIdentity']) {
    await writeFile(join(subject.root,'observe.mts'),wrapper.replace("{...binding,schemaVersion:1",`{...binding,${field}:'forged',schemaVersion:1`).replace(`runnerIdentity:${JSON.stringify(testRunnerIdentity)}`,field==='runnerIdentity'?"runnerIdentity:'forged'":`runnerIdentity:${JSON.stringify(testRunnerIdentity)}`));
    subject.files['observe.mts']=sha(await readFile(join(subject.root,'observe.mts')));
    report=await runCheckChangedAgentWorkflow({consumerRoot:subject.root,configPath:'workflow.json'},{custody:(await subject.freeze()).custody,runner:subject.runner(),loadPolicy:subject.loadPolicy});
    assert.equal(report.outcome,'uncovered',field);assert.equal(report.steps.length,1);assert.equal(report.steps[0]?.observation,null);
  }
}));

// RED: platform separator handling can admit observation/cache writes inside
// the frozen input closure. A nested real output root must reject before checks.
void test('C1 qualified runner rejects nested output roots before command execution',async()=>fixture(async subject=>{
  const {mkdir}=await import('node:fs/promises');
  const {createQualifiedPnpmCheckRunner}=await import('../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/outbound/pnpm/qualified-pnpm-check-runner.js');
  const frozen=await subject.freeze();const outputRoot=join(frozen.lease.executionRoot,'outputs');await mkdir(outputRoot);
  let ran=false;
  const runner=createQualifiedPnpmCheckRunner({tool:subject.tool,outputRoot,qualify:async(_lease,check)=>({checkId:check.id,scripts:subject.scripts,files:subject.files,supplies:check.supplies,runnerIdentity:null,effects:'read-only-inputs-owned-outputs',effectiveConfig:{enablePrePostScripts:false,verifyDepsBeforeRun:false,managePackageManagerVersions:false}})},async(command,args,options)=>{if(args.includes('run')){ran=true;}return execute(command,args,options);});
  await assert.rejects(runner.run({lease:frozen.lease,check:lint}),/outside the source closure/u);assert.equal(ran,false);
}));

// RED: a real output ancestor replacement makes transport cleanup reject
// after the child completed. That failure must not erase execution history.
void test('C1 output cleanup failure retains completed command history',async()=>fixture(async subject=>{
  const moved=`${subject.output}-moved`;
  await writeFile(join(subject.root,'workflow.json'),JSON.stringify(policyInput([lint],['lint'])));
  await writeFile(join(subject.root,'lint.mts'),`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(join(subject.output,'completed'))},'actual completed child');\n`);
  for(const path of ['workflow.json','lint.mts']) {subject.files[path]=sha(await readFile(join(subject.root,path)));}
  const runner=subject.runner(undefined,subject.tool,async(command,args,options)=>{
    const result=await execute(command,args,options);
    if(args.includes('run')) {await rename(subject.output,moved);await writeFile(subject.output,'TEST replaced output ancestor');}
    return result;
  });
  const report=await runCheckChangedAgentWorkflow({consumerRoot:subject.root,configPath:'workflow.json'},{custody:(await subject.freeze()).custody,runner,loadPolicy:subject.loadPolicy});
  assert.equal(await readFile(join(moved,'completed'),'utf8'),'actual completed child');
  assert.equal(report.outcome,'failed');assert.equal(report.steps.length,1);
  assert.deepEqual(report.steps[0]?.commands.map(command=>[command.script,command.exitCode]),[['lint',0]]);
  assert.deepEqual(report.steps[0]?.qualifiedFacets,[]);assert.ok(report.coverage.every(row=>row.state==='uncovered'));
}));
