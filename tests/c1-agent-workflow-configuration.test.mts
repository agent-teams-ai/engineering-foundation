import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { policyInput, lint, tests } from './c1-test-support.mts';
import { loadAgentWorkflowPolicyV2 } from '../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/inbound/configuration/load-agent-workflow-policy-v2.js';
import { loadVersionedAgentWorkflowPolicy } from '../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/inbound/configuration/load-versioned-agent-workflow-policy.js';
import { parseAgentWorkflowPolicyV2 } from '../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/inbound/configuration/parse-agent-workflow-policy-v2.js';

const oldPolicy={schemaVersion:1,instructions:{canonical:'AGENTS.md',claude:'CLAUDE.md',gemini:'GEMINI.md',copilot:'.github/copilot-instructions.md'},scripts:{changed:'check:changed',fast:'check:fast',full:'check'},changedChecks:[{id:'lint',script:'lint',extensions:['.ts'],passPaths:false}],fullScanPaths:[]};

// RED: migration could validate against v2 before giving an actionable v1
// rejection, or conformance could silently parse v1 as v2.
void test('C1 versioned loading preserves v1 and successor rejects it before effects',async()=>{
  const schemas:string[]=[];
  const dependencies={readYaml:async()=>oldPolicy,assertSchema:async(id:string)=>{schemas.push(id);}};
  const loaded=await loadVersionedAgentWorkflowPolicy(dependencies,'TEST root','workflow.yaml');
  assert.equal(loaded.version,1);assert.equal(loaded.policy.changedChecks[0]?.passPaths,false);
  assert.deepEqual(schemas,['repository-agent-workflow/v1']);schemas.length=0;
  await assert.rejects(loadAgentWorkflowPolicyV2(dependencies,'TEST root','workflow.yaml'),/Migrate changedChecks/u);
  assert.deepEqual(schemas,[]);
  const successor=await loadVersionedAgentWorkflowPolicy({...dependencies,readYaml:async()=>policyInput([lint],['lint'])},'TEST root','workflow.yaml');
  assert.equal(successor.version,2);assert.deepEqual(schemas,['repository-agent-workflow/v2']);
});

// RED: permissive schema/parser can accept executable policy with inferred
// tests, recursion, unknown mappings, unknown fields or unsafe paths.
void test('C1 successor schema and parser reject malformed executable policy',async()=>{
  const schema=JSON.parse(await readFile(new URL('../packages/engineering-foundation/schemas/repository-agent-workflow/v2.schema.json',import.meta.url),'utf8')) as object;
  const validate=new Ajv2020({strict:true,allErrors:true}).compile(schema);
  const good=policyInput([tests],['tests']);assert.equal(validate(good),true);
  for(const value of [{...good,unexpected:true},{...good,schemaVersion:1},{...good,checks:[{...tests,observation:'command'}]},{...good,exclusions:[{path:'../outside',reason:'unsafe'}]}]) {
    assert.equal(validate(value),false,JSON.stringify(value));assert.throws(()=>parseAgentWorkflowPolicyV2(value));
  }
  for(const value of [{...good,escalationCheck:'missing'},{...good,checks:[{...tests,script:'check:changed'}]},{...good,checks:[{...tests,prerequisites:['check:changed']}]},{...good,scopes:[{id:'repo',roots:['*'],requiredFacets:['tests'],checks:['missing']}]}]) {assert.throws(()=>parseAgentWorkflowPolicyV2(value));}
});

// RED: the v2 capability can accidentally validate the old command route or
// omit a prerequisite script from conformance. Read actual consumer files.
void test('C1 v2 conformance reads successor command and explicit prerequisite scripts',async()=>{
  const {fixture}=await import('./c1-test-support.mts');
  const {analyzeRepositoryAgentWorkflowV2}=await import('../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/application/use-cases/analyze-repository-agent-workflow.js');
  const {FilesystemRepositoryAgentWorkflowReader}=await import('../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/outbound/filesystem/filesystem-repository-agent-workflow-reader.js');
  await fixture(async subject=>{
    await writeFile(join(subject.root,'AGENTS.md'),'Run pnpm check:changed while editing, pnpm check:fast before handoff and pnpm check in CI.\n');
    await writeFile(join(subject.root,'CLAUDE.md'),'@AGENTS.md\n');await writeFile(join(subject.root,'GEMINI.md'),'@AGENTS.md\n');
    await mkdir(join(subject.root,'.github'));await writeFile(join(subject.root,'.github/copilot-instructions.md'),'Read AGENTS.md.\n');
    const scripts: Record<string,string>={...subject.scripts,'check:changed':'agent-teams-foundation agent-workflow check-changed --consumer .','check:fast':'node fast.mts',check:'node full.mts'};
    const policy=parseAgentWorkflowPolicyV2(policyInput([{...lint,prerequisites:['prerequisite']}],['lint']));
    await writeFile(join(subject.root,'package.json'),JSON.stringify({scripts}));
    const reader=new FilesystemRepositoryAgentWorkflowReader();
    assert.deepEqual(await analyzeRepositoryAgentWorkflowV2({consumerRoot:subject.root,policy},reader),[]);
    scripts['check:changed']='agent-teams-foundation agent-workflow changed --consumer .';
    await writeFile(join(subject.root,'package.json'),JSON.stringify({scripts}));
    assert.ok((await analyzeRepositoryAgentWorkflowV2({consumerRoot:subject.root,policy},reader)).some(d=>d.ruleId==='repository.agent-workflow.changed-runner-invalid'));
    const {prerequisite:omitted,...missing}=scripts;assert.equal(typeof omitted,'string');
    await writeFile(join(subject.root,'package.json'),JSON.stringify({scripts:missing}));
    assert.ok((await analyzeRepositoryAgentWorkflowV2({consumerRoot:subject.root,policy},reader)).some(d=>d.ruleId==='repository.agent-workflow.package-script-missing'&&d.subject==='package-script:prerequisite'));
  });
});
