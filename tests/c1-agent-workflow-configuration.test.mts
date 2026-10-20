import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { policyInput, lint, tests } from './c1-test-support.mts';
import { loadAgentWorkflowPolicyV2 } from '../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/inbound/configuration/load-agent-workflow-policy-v2.js';
import { loadVersionedAgentWorkflowPolicy } from '../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/inbound/configuration/load-versioned-agent-workflow-policy.js';
import { parseAgentWorkflowPolicyV2 } from '../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/inbound/configuration/parse-agent-workflow-policy-v2.js';
import { evaluateRepositoryAgentWorkflow, evaluateRepositoryAgentWorkflowV2 } from '../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/application/policies/evaluate-repository-agent-workflow.js';

const oldPolicy={schemaVersion:1,instructions:{canonical:'AGENTS.md',claude:'CLAUDE.md',gemini:'GEMINI.md',copilot:'.github/copilot-instructions.md'},scripts:{changed:'check:changed',fast:'check:fast',full:'check'},changedChecks:[{id:'lint',script:'lint',extensions:['.ts'],passPaths:false}],fullScanPaths:[]};

void test('workflow conformance admits only static Host tool declarations for the selected command mode', () => {
  const policy = parseAgentWorkflowPolicyV2(policyInput([lint], ['lint']));
  const instructionFiles = {
    canonical: { kind: 'file' as const, source: 'Run check:changed, check:fast and check.' },
    claude: { kind: 'file' as const, source: '@AGENTS.md' },
    gemini: { kind: 'file' as const, source: '@AGENTS.md' },
    copilot: { kind: 'file' as const, source: 'Read AGENTS.md.' },
  };
  for (const mode of ['changed', 'check-changed'] as const) {
    const diagnostics = (command: string) => {
      const evidence = { instructionFiles, packageScripts: {
        'check:changed': command, 'check:fast': 'node fast.ts', check: 'node full.ts', lint: 'node lint.ts',
      } };
      return mode === 'check-changed'
        ? evaluateRepositoryAgentWorkflowV2(policy, evidence)
        : evaluateRepositoryAgentWorkflow({ ...oldPolicy, packageManager: 'pnpm' }, evidence);
    };
    const tail = `tool agent-teams-foundation agent-workflow ${mode} --consumer .`;
    // These are declaration checks; no consumer dispatcher body is read or executed.
    for (const command of [
      `node architecture/tooling/runtime/command.ts ${tail}`,
      `node scripts/workflow-dispatch.mjs ${tail}`,
      `node tooling/dispatcher.js ${tail}`,
      `node tooling/dispatcher.cjs ${tail}`,
      `node .tools/dispatcher.cts ${tail}`,
      `node\ttools/dispatcher.mts\t${tail}`,
      `agent-teams-foundation agent-workflow ${mode} --consumer .`,
      `pnpm build && node packages/engineering-foundation/dist/cli.js agent-workflow ${mode} --consumer .`,
      'node tools/repository-command.mts script build && node tools/repository-command.mts tool check:changed',
    ]) assert.deepEqual(diagnostics(command), [], command);

    for (const entry of [
      '../dispatcher.ts', 'tools/../dispatcher.ts', './tools/dispatcher.ts',
      '/tmp/dispatcher.ts', 'C:/tools/dispatcher.ts', 'file:///tmp/dispatcher.ts',
      'tools//dispatcher.ts', 'tools\\dispatcher.ts', '-dispatcher.ts',
      'tools/dispatcher', 'tools/dispatcher.jsx', 'tools/dispatcher.ts?query',
      '"tools/dispatcher.ts"', '`tools/dispatcher.ts`', '$(echo tools/dispatcher.ts)',
      'tools/dispatcher;noop.ts', 'tools/dispatcher|noop.ts', 'tools/dispatcher\n.ts',
    ]) assert.ok(diagnostics(`node ${entry} ${tail}`).some(d => d.ruleId === 'repository.agent-workflow.changed-runner-invalid'), entry);

    const command = `node tools/dispatcher.ts ${tail}`;
    for (const invalid of [
      'node scripts/arbitrary.ts', `node scripts/arbitrary.ts ${mode}`,
      `MODE=test ${command}`, `node --import preload.ts tools/dispatcher.ts ${tail}`,
      command.replace('node ', 'bun '), command.replace(' tool ', ' run '),
      command.replace('agent-teams-foundation', 'other-tool'),
      command.replace(' tool ', ' '), command.replace('agent-teams-foundation ', ''),
      command.replace('agent-workflow', 'other-workflow'),
      command.replace(` ${mode} `, ` ${mode === 'changed' ? 'check-changed' : 'changed'} `),
      command.replace('--consumer .', '--consumer other'), command.replace('--consumer .', ''),
      `${command} --format json`, `${command} && echo done`, `${command} || true`,
      `${command}; true`, `${command} > output`, `${command}\n`, `\r${command}`,
      command.replace('node ', 'node\n'), command.replace(' tool ', '\rtool '),
    ]) assert.ok(diagnostics(invalid).some(d => d.ruleId === 'repository.agent-workflow.changed-runner-invalid'), JSON.stringify(invalid));
  }
});

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
  for(const [value,message] of [
    [{...good,unexpected:true},/requires exactly/u],
    [{...good,schemaVersion:1},/check-changed requires repository-agent-workflow\/v2/u],
    [{...good,checks:[{...tests,observation:'command'}]},/test-dispatch\/v1/u],
    [{...good,exclusions:[{path:'../outside',reason:'unsafe'}]},/(?:CONFIG_PATH_INVALID|is invalid|repository-relative POSIX paths)/u]
  ] as const) {
    assert.equal(validate(value),false,JSON.stringify(value));assert.throws(()=>parseAgentWorkflowPolicyV2(value),message);
  }
  for(const [value,message] of [
    [{...good,escalationCheck:'missing'},/Unknown check mapping/u],
    [{...good,checks:[{...tests,script:'check:changed'}]},/cannot invoke itself/u],
    [{...good,checks:[{...tests,prerequisites:['check:changed']}]},/cannot invoke itself/u],
    [{...good,scopes:[{id:'repo',roots:['*'],requiredFacets:['tests'],checks:['missing']}]},/Unknown check mapping/u],
    [{...good,scopes:[{id:'repo',roots:['packages/critical'],requiredFacets:['tests'],checks:['tests']}],exclusions:[{path:'packages',reason:'TEST exclusion covers a more specific scope root'}]},/must not overlap scope roots/u],
    [{...good,scopes:[{id:'repo',roots:['notes'],requiredFacets:['tests'],checks:['tests']}],exclusions:[{path:'notes',reason:'TEST exclusion equals its scope root'}]},/must not overlap scope roots/u]
  ] as const) {assert.throws(()=>parseAgentWorkflowPolicyV2(value),message);}
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
