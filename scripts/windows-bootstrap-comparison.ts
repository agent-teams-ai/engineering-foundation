import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { c1CommandEnvironment, windowsBootstrapDiagnosticSources } from '../tests/c1-test-support.mts';
import { executeManagedProcess } from '../packages/engineering-foundation/dist/process-execution/node-process-runner.js';
import { readContainedRegularFile } from '../packages/engineering-foundation/dist/source-inventory/node.js';

// One ordered diagnostic pair, never candidate qualification or a retry path.
assert.equal(process.platform,'win32','This diagnostic requires native Windows.');
const allowed=['home','xdg_cache_home','xdg_data_home','xdg_config_home','path','tmpdir','tmp','temp','ci','systemroot'];
function environmentKeys(environment:Readonly<NodeJS.ProcessEnv>): string[] {
  const keys=Object.entries(environment).filter(([,value])=>value!==undefined).map(([key])=>key.toLowerCase()).toSorted();
  assert.ok(keys.every(key=>allowed.includes(key)),'Unexpected restricted environment key.');
  assert.equal(new Set(keys).size,keys.length,'Ambiguous environment casing.');
  return keys;
}
if(process.argv[2]==='--probe') {
  const targetEnvironment=Object.freeze({...process.env});
  const evidence={environmentKeys:environmentKeys(targetEnvironment),requestedEnvironmentSharedWithLauncher:true};
  // Write only keys/equality before launch, so a compile timeout retains evidence.
  assert.ok(process.argv[3]);await writeFile(process.argv[3],JSON.stringify(evidence));
  const result=await executeManagedProcess({command:process.execPath,args:['-e',"process.stdout.write('bootstrap-noop')"],cwd:process.cwd(),
    environment:targetEnvironment,timeoutMs:30000},{launcherEnvironment:targetEnvironment});
  process.stdout.write(JSON.stringify({exitCode:result.exitCode,noop:result.stdout==='bootstrap-noop'}));
  process.exit(result.exitCode);
}
const output=process.argv[2];assert.ok(output,'Provide the owned diagnostic JSON output.');
const selected=process.env['C1_TEST_SCRATCH']??process.env['TMPDIR']??process.env['TEMP'];
assert.ok(selected,'Provide owned C1_TEST_SCRATCH, TMPDIR or TEMP.');
const scratch=await realpath(selected);
const environment=Object.freeze({...c1CommandEnvironment(scratch),
  SystemRoot:Object.entries(process.env).find(([key])=>key.toLowerCase()==='systemroot')?.[1]});
const expectedKeys=environmentKeys(environment);
const directory=await mkdtemp(join(scratch,'c1-TEST-bootstrap-'));
const cwd=join(directory,'source');await mkdir(cwd);
const cli=resolve(fileURLToPath(new URL('../packages/engineering-foundation/dist/cli.js',import.meta.url)));
const assets=resolve(dirname(cli),'../assets/windows-managed-process');
const hash=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const identity=async(name:string)=>hash(await readContainedRegularFile({root:assets,candidate:join(assets,name),maxBytes:4*1024*1024}));
const bootstrapSha256=await identity('bootstrap.ps1').catch(()=>null),helperSha256=await identity('WindowsManagedProcess.cs').catch(()=>null);
const results:Record<string,unknown>[]=[];
const save=async()=>{
  await mkdir(dirname(resolve(output)),{recursive:true});
  const text=JSON.stringify({schemaVersion:1,qualification:false,order:['original','derived'],
    caveat:'One cold/warm ordered pair cannot prove a causal instrumentation cost or stable production latency.',
    deadlineMs:30000,containment:'unchanged Windows Job Object',bootstrapSha256,helperSha256,
    environmentKeys:expectedKeys,sameFrozenRequestedEnvironmentAcrossArms:true,results},null,2)+'\n';
  assert.ok(Buffer.byteLength(text)<=32*1024);await writeFile(output,text);
};
try {
  for(const variant of ['original','derived'] as const) {
    const owned=join(directory,variant);await mkdir(owned);
    const observer=join(owned,'observer.mts'),preload=join(owned,'preload.mts'),record=join(owned,'record.json'),envRecord=join(owned,'environment.json');
    const sources=windowsBootstrapDiagnosticSources(cli,variant);
    await writeFile(observer,sources.observer);await writeFile(preload,sources.preload);
    const result:Record<string,unknown>={variant,preloadSha256:hash(sources.preload),outcome:'failed'};
    const started=performance.now();
    try {
      const actual=await executeManagedProcess({command:process.execPath,args:[observer,record,preload,fileURLToPath(import.meta.url),'--probe',envRecord],cwd,
        environment,timeoutMs:30000},{launcherEnvironment:environment});
      result['exitCode']=actual.exitCode;
      const phase=/\[phase=([a-z-]+)\]/u.exec(actual.stderr)?.[1];if(phase!==undefined){result['failurePhase']=phase;}
      const observed=JSON.parse(actual.stdout) as {exitCode:number;noop:boolean};result['noop']=observed.noop;
      assert.equal(observed.exitCode,0);assert.equal(actual.exitCode,0);assert.equal(observed.noop,true);result['outcome']='passed';
    } catch(error) {result['failureKind']=error instanceof Error?error.name:'non-Error';}
    finally {
      result['durationMs']=performance.now()-started;
      try {
        const text=(await readContainedRegularFile({root:owned,candidate:join(owned,'startup.json'),maxBytes:8192})).toString('utf8');
        const witness=JSON.parse(text) as {controls:unknown[];events:{event:string;originalSha?:string;derivedSha?:string;helperSha?:string}[]};
        result['controls']=witness.controls.slice(0,2);result['witnessValid']=witness.controls.length===1;
        const derivation=witness.events.find(event=>event.event==='instrumented-bootstrap');
        result['derivation']=derivation;
        result['helperBytesEqual']=variant==='original'?derivation===undefined:
          derivation?.helperSha===helperSha256&&derivation.originalSha===bootstrapSha256&&typeof derivation.derivedSha==='string'&&/^[a-f0-9]{64}$/u.test(derivation.derivedSha)&&derivation.derivedSha!==bootstrapSha256;
      } catch {result['witnessUnavailable']=true;}
      try {
        const observed=JSON.parse((await readContainedRegularFile({root:owned,candidate:envRecord,maxBytes:4096})).toString('utf8')) as {environmentKeys:string[];requestedEnvironmentSharedWithLauncher:boolean};
        result['environmentKeysEqual']=JSON.stringify(observed.environmentKeys)===JSON.stringify(expectedKeys);
        result['requestedEnvironmentSharedWithLauncher']=observed.requestedEnvironmentSharedWithLauncher;
      } catch {result['environmentEvidenceUnavailable']=true;}
      result['assetIdentityStable']=bootstrapSha256!==null&&helperSha256!==null&&await identity('bootstrap.ps1').catch(()=>null)===bootstrapSha256&&await identity('WindowsManagedProcess.cs').catch(()=>null)===helperSha256;
      if(result['assetIdentityStable']!==true||result['environmentKeysEqual']!==true||result['helperBytesEqual']!==true||result['witnessValid']!==true){result['outcome']='failed';}
      results.push(result);await save();
    }
  }
} finally {
  try {await rm(directory,{recursive:true,force:true});}
  catch {results.push({cleanupFailed:true});}
  await save();
}
if(results.length!==2||results.some(result=>result['outcome']!=='passed'||result['assetIdentityStable']!==true||result['environmentKeysEqual']!==true)){process.exitCode=1;}
