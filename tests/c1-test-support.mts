import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeManagedProcess } from '../packages/engineering-foundation/dist/process-execution/node-process-runner.js';
import { createQualifiedPnpmCheckRunner, fingerprintPnpmPackage, type PnpmToolIdentity, type QualifiedScriptClosure } from '../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/outbound/pnpm/qualified-pnpm-check-runner.js';
import { createMutableCheckInputCustody } from '../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/outbound/filesystem/mutable-check-input-custody.js';
import { parseAgentWorkflowPolicyV2 } from '../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/inbound/configuration/parse-agent-workflow-policy-v2.js';
import type { CheckInputCustody, CheckInputLease } from '../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/application/ports/check-changed.js';
import type { CoverageCheck } from '../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/application/model/check-changed.js';

export const testRunnerIdentity = `node-test/${process.versions.node}`;
export const sha = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const execute = async (command: string, args: readonly string[], options: { cwd: string; signal?: AbortSignal; strictUtf8?: boolean }) => executeManagedProcess({ command, args, ...options, timeoutMs: 30_000, environment: { HOME: process.env['C1_TEST_SCRATCH'], XDG_CACHE_HOME: process.env['C1_TEST_SCRATCH'], XDG_DATA_HOME: process.env['C1_TEST_SCRATCH'], XDG_CONFIG_HOME: process.env['C1_TEST_SCRATCH'], PATH: process.env['PATH'], TMPDIR: process.env['C1_TEST_SCRATCH'] ?? process.env['TMPDIR'], CI: 'true' } });
export async function git(root: string, ...args: string[]): Promise<void> {
  const environment = { PATH: process.env['PATH'], TMPDIR: process.env['C1_TEST_SCRATCH'], GIT_AUTHOR_NAME: 'iliya', GIT_AUTHOR_EMAIL: 'iliyazelenkog@gmail.com', GIT_COMMITTER_NAME: 'iliya', GIT_COMMITTER_EMAIL: 'iliyazelenkog@gmail.com' };
  if (args.includes('commit')) {for (const identity of ['GIT_AUTHOR_IDENT','GIT_COMMITTER_IDENT']) {
    const result = await executeManagedProcess({command:'git',args:['var',identity],cwd:root,environment});
    assert.equal(result.exitCode,0); assert.match(result.stdout,/^iliya <iliyazelenkog@gmail\.com> /u);
  }}
  const result = await executeManagedProcess({command:'git',args,cwd:root,environment});
  assert.equal(result.exitCode,0,result.stderr);
}
async function toolIdentity(selectedPackage: string, selectedNode: string): Promise<PnpmToolIdentity> {
  const packageRoot = await realpath(selectedPackage);
  const nodeExecutable = await realpath(selectedNode);
  return { packageRoot, nodeExecutable, version: '11.20.0', entrypointSha256: sha(await readFile(join(packageRoot,'bin/pnpm.mjs'))), packageJsonSha256: sha(await readFile(join(packageRoot,'package.json'))), packageTreeSha256: await fingerprintPnpmPackage(packageRoot), nodeSha256: sha(await readFile(nodeExecutable)) };
}
export function policyInput(checks: readonly CoverageCheck[], requiredFacets: readonly string[] = ['lint','typecheck','tests']) {
  return { schemaVersion: 2, instructions: { canonical: 'AGENTS.md', claude: 'CLAUDE.md', gemini: 'GEMINI.md', copilot: '.github/copilot-instructions.md' }, scripts: {changed:'check:changed',fast:'check:fast',full:'check'}, scopes:[{id:'repository',roots:['*'],requiredFacets,checks:checks.map(check=>check.id)}], checks, exclusions:[], escalationCheck:checks.at(-1)!.id };
}
const loadPolicy = async (executionRoot:string) => parseAgentWorkflowPolicyV2(JSON.parse(await readFile(join(executionRoot,'workflow.json'),'utf8')));
export const lint: CoverageCheck = {id:'lint',script:'lint',prerequisites:[],supplies:['lint'],observation:'command'};
export const typecheck: CoverageCheck = {id:'typecheck',script:'typecheck',prerequisites:[],supplies:['typecheck'],observation:'command'};
export const tests: CoverageCheck = {id:'tests',script:'tests',prerequisites:[],supplies:['tests'],observation:'test-dispatch/v1'};

export async function fixture(body: (subject: {root:string;output:string;tool:PnpmToolIdentity; scripts: Record<string,string>; files: Record<string,string>; freeze: () => Promise<{custody:CheckInputCustody;lease:CheckInputLease}>; runner: (mutate?: (lease: CheckInputLease, check: CoverageCheck) => Promise<void>, tool?:PnpmToolIdentity, executor?: typeof execute) => ReturnType<typeof createQualifiedPnpmCheckRunner>; loadPolicy: (root:string) => Promise<ReturnType<typeof parseAgentWorkflowPolicyV2>> }) => Promise<void>): Promise<void> {
  const scratch = process.env['C1_TEST_SCRATCH'] ?? process.env['TMPDIR'] ?? process.env['TEMP'];
  assert.ok(scratch !== undefined && scratch.length > 0, 'Provide job-owned C1_TEST_SCRATCH; no system scratch fallback.');
  await mkdir(scratch,{recursive:true});
  const directory = await mkdtemp(join(scratch,'c1-TEST-'));
  const root = join(directory,'source'), output = join(directory,'output');
  await mkdir(root); await mkdir(output);
  const toolchain = join(directory,'toolchain');
  await mkdir(join(toolchain,'bin'),{recursive:true});
  const packageRoot = await realpath(process.env['C1_PNPM_PACKAGE_ROOT'] ?? dirname(fileURLToPath(import.meta.resolve('pnpm'))));
  const nodeExecutable = join(toolchain,'bin',process.platform === 'win32' ? 'node.exe' : 'node');
  await cp(await realpath(process.execPath),nodeExecutable);
  const nodeVersion = await execute(nodeExecutable,['--version'],{cwd:root});
  assert.equal(nodeVersion.exitCode,0,nodeVersion.stderr);
  assert.equal(nodeVersion.stdout.trim(),process.version);
  await cp(packageRoot,join(toolchain,'pnpm'),{recursive:true});
  const compilerPackage = await realpath(fileURLToPath(new URL('../node_modules/typescript',import.meta.url)));
  const nativeName = `typescript-${process.platform}-${process.arch}`;
  await mkdir(join(toolchain,'node_modules/@typescript'),{recursive:true});
  await cp(compilerPackage,join(toolchain,'node_modules/typescript'),{recursive:true});
  await cp(await realpath(join(dirname(compilerPackage),'@typescript',nativeName)),join(toolchain,'node_modules/@typescript',nativeName),{recursive:true});
  const tool = await toolIdentity(join(toolchain,'pnpm'),nodeExecutable);
  const compilerPath = join(toolchain,'node_modules/typescript/bin/tsc');
  const scripts = {
    lint:'node lint.mts',
    typecheck:`node ${JSON.stringify(compilerPath)} --project tsconfig.json --pretty false`,
    tests:'node observe.mts',
    pretests:`node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(join(output,'pre-sentinel'))},'unexpected')`)}`,
    posttests:`node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(join(output,'post-sentinel'))},'unexpected')`)}`,
    prerequisite:'node prerequisite.mts'
  };
  for(const name of Object.keys(scripts) as Array<keyof typeof scripts>) {scripts[name]=scripts[name].replace(/^node /u, `${JSON.stringify(tool.nodeExecutable)} `);}
  await writeFile(join(root,'package.json'),JSON.stringify({type:'module',packageManager:'pnpm@11.20.0',scripts}));
  await writeFile(join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{strict:true,noEmit:true,types:[],target:'ES2024',module:'NodeNext'},include:['src.ts']}));
  await writeFile(join(root,'src.ts'),'export const value: number = 1;\n');
  await writeFile(join(root,'lint.mts'),`import { readFileSync } from 'node:fs'; if (readFileSync('src.ts','utf8').includes('forbidden')) process.exitCode=1;\n`);
  await writeFile(join(root,'prerequisite.mts'),`process.exitCode=7;\n`);
  await writeFile(join(root,'suite.mts'),`import test from 'node:test'; import assert from 'node:assert/strict'; test('actual assertion',()=>assert.equal(2+2,4));\n`);
  await writeFile(join(root,'observe.mts'),`import {run} from 'node:test'; import {writeFileSync, readFileSync} from 'node:fs';
const args=process.argv.slice(2), p=args[args.indexOf('--foundation-observation')+1], binding=JSON.parse(args[args.indexOf('--foundation-binding')+1]);
const mode=readFileSync('mode.txt','utf8').trim();
if(mode==='noop') process.exit(0);
const suites=mode==='empty'?[]:['suite.mts']; let executed=0, skipped=0, failed=false;
if(suites.length) for await(const event of run({files:suites,isolation:'process',concurrency:1})) {
if(event.type==='test:pass') { if(event.data.skip) skipped++; else if(event.data.details.type==='test') executed++; }
if(event.type==='test:fail') failed=true;
}
writeFileSync(p,JSON.stringify({...binding,schemaVersion:1,runnerIdentity:${JSON.stringify(testRunnerIdentity)},selectedSuites:suites,executed,skipped,outcome:failed?'failed':suites.length===0?'empty-selection':'passed'}));
process.exitCode=failed?1:0;\n`);
  await writeFile(join(root,'mode.txt'),'positive');
  await writeFile(join(root,'workflow.json'),JSON.stringify(policyInput([lint,tests,typecheck])));
  await git(root,'init','--initial-branch=main'); await git(root,'add','.'); await git(root,'commit','-m','test: isolated baseline');
  const closurePaths = ['package.json','tsconfig.json','lint.mts','prerequisite.mts','observe.mts','mode.txt','suite.mts','workflow.json'];
  const files: Record<string,string> = {};
  for(const path of closurePaths) {files[path]=sha(await readFile(join(root,path)));}
  async function toolingDigest(): Promise<string> {
    const hashes:string[]=[];
    async function walk(path:string):Promise<void> {
      for(const entry of await readdir(path,{withFileTypes:true})) {
        const candidate=join(path,entry.name);
        if(entry.isDirectory()) {await walk(candidate);}
        else { assert.ok(entry.isFile()); hashes.push(`${candidate.slice(toolchain.length)}:${sha(await readFile(candidate))}`); }
      }
    }
    await walk(toolchain);
    return sha(hashes.toSorted().join('\n'));
  }
  const pinnedTooling = await toolingDigest();
  async function freeze() {
    const snapshot = join(directory,`snapshot-${Math.random().toString(36).slice(2)}`);
    await cp(root,snapshot,{recursive:true});
    const mutable = await createMutableCheckInputCustody(execute).acquire({consumerRoot:snapshot,configPath:'workflow.json'});
    // TEST Host owns this private execution copy and all cooperative writers.
    // The real compiler reads its original bytes; origin edits have no alias.
    const lease:CheckInputLease={...mutable,classification:'frozen-closure',closureIdentity:`TEST-private-copy:${mutable.sourceIdentity}:${pinnedTooling}`,assertCurrent:async(signal)=>{await mutable.assertCurrent(signal);assert.equal(await toolingDigest(),pinnedTooling,'TEST tooling closure revoked');},release:async()=>{}};
    return {lease,custody:{acquire:async()=>lease}};
  }
  const runner = (mutate?: (lease:CheckInputLease,check:CoverageCheck)=>Promise<void>, selectedTool = tool, executor = execute) => createQualifiedPnpmCheckRunner({tool:selectedTool,outputRoot:output,qualify:async(lease,check)=>{
    await mutate?.(lease,check);
    const closure:QualifiedScriptClosure={checkId:check.id,scripts,files,supplies:check.supplies,runnerIdentity:check.observation==='test-dispatch/v1'?testRunnerIdentity:null,effects:'read-only-inputs-owned-outputs',effectiveConfig:{enablePrePostScripts:false,verifyDepsBeforeRun:false,managePackageManagerVersions:false}};
    return closure;
  }},executor);
  try { await body({root,output,tool,scripts,files,freeze,runner,loadPolicy}); }
  finally { await rm(directory,{recursive:true,force:true}); }
}
