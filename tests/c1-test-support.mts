import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
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
const failedCommands = new AsyncLocalStorage<Error[]>();
function diagnosticText(value: string, maximum = 2048): string {
  const bytes=Buffer.from(value);let end=Math.min(bytes.length,maximum);
  while(end<bytes.length&&end>0&&(bytes[end]!&0xc0)===0x80){end--;}
  return bytes.subarray(0,end).toString('utf8');
}
function observedControls(raw:string):unknown[] {
  const value:unknown=JSON.parse(raw);
  if(typeof value!=='object'||value===null||!('controls' in value)||!Array.isArray(value.controls)){return [];}
  return value.controls.slice(0,2).flatMap((slot:unknown)=>{
    if(typeof slot!=='object'||slot===null||!('command' in slot)||typeof slot.command!=='string'){return [];}
    const result:Record<string,unknown>={command:slot.command.slice(0,64)};
    for(const name of ['launched','contained'] as const){
      if(!(name in slot)){continue;}
      const stage:unknown=Reflect.get(slot,name);
      if(typeof stage!=='object'||stage===null||!('value' in stage)||!('elapsedMs' in stage)||typeof stage.elapsedMs!=='number'||!Number.isFinite(stage.elapsedMs)||stage.elapsedMs<0){continue;}
      if((name==='launched'&&(stage.value==='STARTED'||stage.value==='FAILED'))||(name==='contained'&&stage.value==='CONTAINED')){result[name]={value:stage.value,elapsedMs:stage.elapsedMs};}
    }
    if('phases' in slot&&Array.isArray(slot.phases)){result['phases']=slot.phases.slice(0,7);}
    if('spawnEpochMs' in slot&&typeof slot.spawnEpochMs==='number'){result['spawnEpochMs']=slot.spawnEpochMs;}
    return [result];
  });
}
async function commandScratch(cwd:string):Promise<string> {
  const selected=process.env['C1_TEST_SCRATCH']??process.env['TMPDIR']??process.env['TEMP'];
  assert.ok(selected,'TEST commands require job-owned scratch.');
  const scratch=await realpath(selected);
  assert.equal(await realpath(dirname(dirname(await realpath(cwd)))),scratch,'TEST command cwd must belong to its job-owned scratch.');
  return scratch;
}
export const execute = async (command: string, args: readonly string[], options: { cwd: string; signal?: AbortSignal; strictUtf8?: boolean }) => {
  const record=(detail:unknown)=>{const trace=failedCommands.getStore();if(trace!==undefined){trace.push(new Error(`TEST owned command: ${diagnosticText(JSON.stringify({command,args,cwd:options.cwd,detail}),6000)}`));if(trace.length>4){trace.shift();}}};
  const scratch=await commandScratch(options.cwd);
  try {
    const result=await executeManagedProcess({ command, args, ...options, timeoutMs: 30_000, environment: { HOME: process.env['C1_TEST_SCRATCH'], XDG_CACHE_HOME: process.env['C1_TEST_SCRATCH'], XDG_DATA_HOME: process.env['C1_TEST_SCRATCH'], XDG_CONFIG_HOME: process.env['C1_TEST_SCRATCH'], PATH: process.env['PATH'], TMPDIR: scratch, TMP: scratch, TEMP: scratch, CI: 'true' } });
    if(result.exitCode!==0){record({exitCode:result.exitCode,stdout:diagnosticText(result.stdout),stderr:diagnosticText(result.stderr)});}
    return result;
  } catch(error) {record(error instanceof Error?{name:error.name,message:error.message}:String(error));throw error;}
};
const cliProgressSource = "import {createHash} from 'node:crypto';\nimport childProcess, {type ChildProcess} from 'node:child_process';\nimport {lstatSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';\nimport {EventEmitter,errorMonitor} from 'node:events';\nimport {registerHooks,syncBuiltinESMExports} from 'node:module';\nimport {tmpdir} from 'node:os';\nimport {basename,dirname,join} from 'node:path';\nimport {fileURLToPath,pathToFileURL} from 'node:url';\n\nconst cli=process.argv[1];\nif(cli===undefined){throw new Error('TEST CLI progress requires the real entrypoint.');}\nconst record=join(dirname(fileURLToPath(import.meta.url)),'startup.json');\nconst started=Date.now(),dist=dirname(cli),distUrl=new URL('.',pathToFileURL(cli)).href;\ntype Milestone='cli'|'host'|'workflow';\nconst allowlist=new Map<string,Milestone>([\n [pathToFileURL(cli).href,'cli'],\n [pathToFileURL(join(dist,'composition/command-host.js')).href,'host'],\n [pathToFileURL(join(dist,'capabilities/repository-agent-workflow/composition/node-commands.js')).href,'workflow']\n]);\nconst modules:Partial<Record<Milestone,{startMs:number;returnMs?:number}>>={};\nconst events:Record<string,unknown>[]=[];\ntype ControlStage={value:'STARTED'|'FAILED'|'CONTAINED';elapsedMs:number};\nconst controls:{command:string;launched?:ControlStage;contained?:ControlStage;phases?:Phase[];spawnEpochMs?:number}[]=[];\nconst elapsed=()=>Date.now()-started;\nfunction save():void {\n try {\n  const state=()=>JSON.stringify({entered:true,controls,tmpdir:tmpdir(),environmentPresence:{TMP:process.env['TMP']!==undefined,TEMP:process.env['TEMP']!==undefined,TMPDIR:process.env['TMPDIR']!==undefined},modules,events});\n  let text=state();while(Buffer.byteLength(text)>8192&&events.length>0){events.shift();text=state();}\n  if(Buffer.byteLength(text)<=8192){writeFileSync(record,text);}\n } catch { /* TEST observation never changes the actual process operation. */ }\n}\nfunction spawnError(error:unknown):Record<string,unknown> {\n try {\n const fields:Record<string,unknown>={};\n if(typeof error!=='object'||error===null){return {errorName:'non-Error'};}\n for(const name of ['name','message','code','errno','syscall'] as const){\n  const descriptor=Object.getOwnPropertyDescriptor(error,name);\n  if(descriptor===undefined||!('value' in descriptor)){continue;}\n  const value:unknown=descriptor.value;\n  if(typeof value==='string'){fields[name]=value.slice(0,name==='message'?256:64);}\n  else if(typeof value==='number'&&Number.isFinite(value)){fields[name]=value;}\n }\n if(!('name' in fields)){fields['name']=error instanceof Error?'Error':'non-Error';}\n return fields;\n } catch {return {name:'unavailable-error-fields'};}\n}\nfunction note(event:string,detail:Record<string,unknown>={}):void {\n events.push({event,elapsedMs:elapsed(),...detail});if(events.length>8){events.shift();}save();\n}\nfunction caller():string[] {\n return (new Error().stack??'').split('\\n').filter(line=>line.includes(distUrl)).slice(0,2).map(line=>line.slice(0,160));\n}\nconst BOOTSTRAP_SHA='7373da6764e631c222eefb42d56967e5adc5e4cc905ea229b18d30da56e4d3b7';\nconst phases=['entered','source-read','compile-start','compile-end','request-ready','run-start','run-end'] as const;\ntype Phase={phase:string;epochMs:number;elapsedMs:number};\nfunction instrumentBootstrap(source:string):string {\n const actualSha=createHash('sha256').update(source).digest('hex');\n if(actualSha!==BOOTSTRAP_SHA&&actualSha!=='fa34bd6bde3d8ff5828c9ffb28b0e7b5e8855b5d2c423d61a80097040e430815'){throw new Error('TEST bootstrap source identity changed.');}\n if(actualSha!==BOOTSTRAP_SHA){source=source.replaceAll('\\r\\n','\\n');}\n const helper=`$TestPhaseClock = [Diagnostics.Stopwatch]::StartNew()\nfunction Write-TestPhase([string]$Name) {\n  try {\n    $Epoch = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()\n    [System.IO.File]::AppendAllText(([System.IO.Path]::Combine($PSScriptRoot, 'phases.txt')), ($Name + '|' + $Epoch + '|' + $TestPhaseClock.ElapsedMilliseconds + [char]10))\n  } catch { }\n}\nWrite-TestPhase 'entered'\n`;\n const changes:[string,string][]=[\n  ['$ErrorActionPreference = \"Stop\"',helper+'$ErrorActionPreference = \"Stop\"'],\n  ['  $helperSource = [System.IO.File]::ReadAllText(',\"  Write-TestPhase 'source-read'\\n  $helperSource = [System.IO.File]::ReadAllText(\"],\n  ['  Add-Type -TypeDefinition $helperSource -Language CSharp',\"  Write-TestPhase 'compile-start'\\n  Add-Type -TypeDefinition $helperSource -Language CSharp\\n  Write-TestPhase 'compile-end'\"],\n  ['  $FailurePhase = \"managed-run\"',\"  Write-TestPhase 'request-ready'\\n  $FailurePhase = \\\"managed-run\\\"\\n  Write-TestPhase 'run-start'\"],\n  ['  exit $exitCode',\"  Write-TestPhase 'run-end'\\n  exit $exitCode\"]\n ];\n let result=source;\n for(const [anchor,replacement] of changes){if(result.split(anchor).length!==2){throw new Error('TEST bootstrap derivation anchor changed.');}result=result.replace(anchor,replacement);}\n return result;\n}\nfunction diagnosticSpawnArgs(args:unknown[]):unknown[] {\n if(typeof args[0]!=='string'||basename(args[0]).toLowerCase()!=='powershell.exe'){return args;}\n const argv=args[1],options=args[2];\n const fixed=['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File'];\n if(!Array.isArray(argv)||argv.length!==7||!fixed.every((value,index)=>argv[index]===value)||typeof argv[6]!=='string'){return args;}\n const original=join(dist,'../assets/windows-managed-process/bootstrap.ps1');\n if(realpathSync(argv[6])!==realpathSync(original)){return args;}\n if(typeof options!=='object'||options===null||!('cwd' in options)||typeof options.cwd!=='string'){throw new Error('TEST diagnostic bootstrap requires owned cwd.');}\n if(lstatSync(options.cwd).isSymbolicLink()){throw new Error('TEST diagnostic lexical cwd alias rejected.');}\n const scratch=realpathSync(tmpdir()),root=realpathSync(options.cwd),identity=lstatSync(root);\n if(!identity.isDirectory()||identity.isSymbolicLink()||dirname(root)!==scratch||!basename(root).startsWith('agent-teams-foundation-process-')){throw new Error('TEST diagnostic control ownership rejected.');}\n const requestPath=join(root,'request.json'),requestStat=lstatSync(requestPath);\n if(!requestStat.isFile()||requestStat.isSymbolicLink()||requestStat.size>65536){throw new Error('TEST diagnostic request rejected.');}\n const request:unknown=JSON.parse(readFileSync(requestPath,'utf8'));\n if(typeof request!=='object'||request===null||!('cwd' in request)||typeof request.cwd!=='string'||realpathSync(dirname(dirname(realpathSync(request.cwd))))!==scratch){throw new Error('TEST diagnostic consumer ownership rejected.');}\n const source=readFileSync(original,'utf8'),derived=instrumentBootstrap(source);\n const helperPath=join(dirname(original),'WindowsManagedProcess.cs'),helperStat=lstatSync(helperPath);\n if(!helperStat.isFile()||helperStat.isSymbolicLink()||helperStat.size>4*1024*1024){throw new Error('TEST helper identity rejected.');}\n const helper=readFileSync(helperPath),helperAfter=lstatSync(helperPath),directory=join(root,'bootstrap-phase');\n if(helperAfter.dev!==helperStat.dev||helperAfter.ino!==helperStat.ino||helperAfter.size!==helperStat.size){throw new Error('TEST helper changed during read.');}\n mkdirSync(directory,{mode:0o700});\n const copy=join(directory,'WindowsManagedProcess.cs');\n writeFileSync(copy,helper,{flag:'wx',mode:0o600});\n if(!readFileSync(copy).equals(helper)){throw new Error('TEST helper copy changed.');}\n const bootstrap=join(directory,'bootstrap.ps1');\n writeFileSync(bootstrap,derived,{flag:'wx',mode:0o600});\n const current=lstatSync(root);\n if(current.dev!==identity.dev||current.ino!==identity.ino||realpathSync(root)!==root){throw new Error('TEST diagnostic control changed.');}\n note('instrumented-bootstrap',{originalSha:createHash('sha256').update(source).digest('hex'),derivedSha:createHash('sha256').update(derived).digest('hex'),helperSha:createHash('sha256').update(helper).digest('hex')});\n return [args[0],[...argv.slice(0,6),bootstrap],...args.slice(2)];\n}\nfunction readPhases(root:string):Phase[] {\n const directory=join(root,'bootstrap-phase'),directoryStat=lstatSync(directory);\n if(!directoryStat.isDirectory()||directoryStat.isSymbolicLink()||realpathSync(directory)!==directory){return [];}\n const path=join(directory,'phases.txt'),stat=lstatSync(path);\n if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>512||realpathSync(path)!==path){return [];}\n const raw=readFileSync(path,'utf8');\n const after=lstatSync(path),directoryAfter=lstatSync(directory);\n if(after.dev!==stat.dev||after.ino!==stat.ino||after.size!==stat.size||directoryAfter.dev!==directoryStat.dev||directoryAfter.ino!==directoryStat.ino||realpathSync(directory)!==directory||realpathSync(path)!==path){return [];}\n const lines=raw.split('\\n').filter(Boolean);\n if(lines.length>phases.length){return [];}\n const result:Phase[]=[];\n for(const [index,line] of lines.entries()){\n  const match=/^([a-z-]+)\\|(\\d{13})\\|(\\d{1,8})$/u.exec(line);\n  if(match===null||match[1]!==phases[index]){return [];}\n  const elapsedMs=Number(match[3]);\n  if(elapsedMs<(result.at(-1)?.elapsedMs??0)){return [];}\n  result.push({phase:match[1],epochMs:Number(match[2]),elapsedMs});\n }\n return result;\n}\n\nfunction observeControl(args:unknown[],spawnEpochMs:number):()=>void {\n try {\n  if(controls.length>=2||typeof args[0]!=='string'||basename(args[0]).toLowerCase()!=='powershell.exe'){return ()=>{};}\n  const argv=args[1],options=args[2];\n  const fixed=['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File'];\n  if(!Array.isArray(argv)||argv.length!==7||!fixed.every((value,index)=>argv[index]===value)||typeof argv[6]!=='string'){return ()=>{};}\n  if(realpathSync(argv[6])!==realpathSync(join(dist,'../assets/windows-managed-process/bootstrap.ps1'))){return ()=>{};}\n  if(typeof options!=='object'||options===null||!('cwd' in options)||typeof options.cwd!=='string'){return ()=>{};}\n  const scratch=realpathSync(tmpdir()),root=realpathSync(options.cwd),identity=lstatSync(root);\n  if(!identity.isDirectory()||identity.isSymbolicLink()||dirname(root)!==scratch||!basename(root).startsWith('agent-teams-foundation-process-')){return ()=>{};}\n  const requestPath=join(root,'request.json'),requestStat=lstatSync(requestPath);\n  if(!requestStat.isFile()||requestStat.isSymbolicLink()||requestStat.size>65536){return ()=>{};}\n  const request:unknown=JSON.parse(readFileSync(requestPath,'utf8'));\n  if(typeof request!=='object'||request===null||!('command' in request)||typeof request.command!=='string'||!('cwd' in request)||typeof request.cwd!=='string'){return ()=>{};}\n  if(realpathSync(dirname(dirname(realpathSync(request.cwd))))!==scratch){return ()=>{};}\n  const slot:{command:string;launched?:ControlStage;contained?:ControlStage;phases?:Phase[];spawnEpochMs?:number}={command:basename(request.command).slice(0,64),spawnEpochMs};\n  controls.push(slot);save();let polls=0;\n  const sample=()=>{\n   try {\n    const current=lstatSync(root);\n    if(!current.isDirectory()||current.isSymbolicLink()||current.dev!==identity.dev||current.ino!==identity.ino||realpathSync(root)!==root){return;}\n    try {const observed=readPhases(root);if(observed.length>0){slot.phases=observed;save();}} catch { /* Missing fixed phase evidence stays unknown. */ }\n    for(const marker of ['launched','contained'] as const){\n     if(slot[marker]!==undefined){continue;}\n     try {\n     const path=join(root,marker),stat=lstatSync(path);\n     if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16){continue;}\n     const value=readFileSync(path,'utf8');\n     if((marker==='launched'&&(value==='STARTED'||value==='FAILED'))||(marker==='contained'&&value==='CONTAINED')){slot[marker]={value,elapsedMs:elapsed()};save();}\n     } catch { /* Each missing marker remains independently unknown. */ }\n    }\n   } catch { /* Missing or removed private markers remain unknown. */ }\n  };\n  const timer=setInterval(()=>{sample();polls++;if(polls>=300){clearInterval(timer);}},100);timer.unref();sample();\n  return ()=>{sample();clearInterval(timer);};\n } catch {return ()=>{};}\n}\nsave();\nregisterHooks({load(url,context,nextLoad){\n const name=allowlist.get(url);\n if(name!==undefined){modules[name]={startMs:elapsed()};save();}\n const result=nextLoad(url,context);\n if(name!==undefined){modules[name]!.returnMs=elapsed();save();}\n return result;\n}});\nchildProcess.spawn=new Proxy(childProcess.spawn,{apply(target,receiver,args:unknown[]){\n const command=typeof args[0]==='string'?basename(args[0]):'non-string';\n const detail={command,argumentCount:Array.isArray(args[1])?args[1].length:null,caller:caller()};\n note('nested-spawn-call',detail);\n let forwarded:unknown[];\n try {forwarded=diagnosticSpawnArgs(args);}\n catch(error){note('bootstrap-derivation-error',spawnError(error));throw error;}\n const spawnEpochMs=Date.now();\n let child:ChildProcess;\n try {child=Reflect.apply(target,receiver,forwarded) as ChildProcess;}\n catch(error){note('nested-spawn-throw',{...detail,...spawnError(error)});throw error;}\n const stopControl=observeControl(args,spawnEpochMs);\n child.once('spawn',()=>note('nested-spawned',{command,pid:child.pid}));\n EventEmitter.prototype.once.call(child,errorMonitor,(error:Error)=>{stopControl();note('nested-spawn-error',{command,...spawnError(error)});});\n child.once('exit',(code:number|null,signal:NodeJS.Signals|null)=>{stopControl();note('nested-exit',{command,code,signal});});\n child.once('close',(code:number|null,signal:NodeJS.Signals|null)=>{stopControl();note('nested-close',{command,code,signal});});\n return child;\n}});\nsyncBuiltinESMExports();\n";
const cliObserverSource = "import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nimport { StringDecoder } from 'node:string_decoder';\nimport { pathToFileURL } from 'node:url';\n\nconst [record, preload, cli, ...args] = process.argv.slice(2);\nif (record === undefined || preload === undefined || cli === undefined) { throw new Error('TEST CLI observer requires its owned record and real CLI.'); }\nconst recordPath:string=record;\nlet stdout = \"\", stderr = \"\";\nconst stdoutDecoder=new StringDecoder(\"utf8\"),stderrDecoder=new StringDecoder(\"utf8\");\nfunction text(value: string): string {\n  const bytes=Buffer.from(value);\n  let end = Math.min(bytes.length, 8192);\n  while (end < bytes.length && end > 0 && (bytes[end]! & 0xc0) === 0x80) { end--; }\n  return bytes.subarray(0,end).toString('utf8');\n}\nfunction snapshot(event: string, detail: unknown = null): void {\n  writeFileSync(recordPath,JSON.stringify({event,detail,node:process.execPath,cli,args,cwd:process.cwd(),stdout:text(stdout),stderr:text(stderr)}));\n}\nsnapshot('before-spawn');\n// Spawn exactly once; inherit the existing managed group/Job Object and exact\n// environment. The observer never creates a detached process or another lease.\nconst child = spawn(process.execPath,['--import',pathToFileURL(preload).href,cli,...args],{cwd:process.cwd(),env:process.env,stdio:['ignore','pipe','pipe']});\nsnapshot('spawned',{pid:child.pid});\nchild.stdout.on('data',(chunk:Buffer)=>{ stdout=text(stdout+stdoutDecoder.write(chunk));snapshot('stdout');process.stdout.write(chunk); });\nchild.stderr.on('data',(chunk:Buffer)=>{ stderr=text(stderr+stderrDecoder.write(chunk));snapshot('stderr');process.stderr.write(chunk); });\nchild.on('error',(error:Error)=>{snapshot('spawn-error',{name:error.name,message:error.message,stack:error.stack});throw error;});\nchild.on('close',(code:number|null,signal:NodeJS.Signals|null)=>{\n  snapshot('closed',{code,signal});\n  if(signal!==null) { process.kill(process.pid,signal);return; }\n  process.exitCode=code??1;\n});\n";
export async function executeCli(cli:string,args:readonly string[],options:{cwd:string}) {
  const observerRoot=await commandScratch(options.cwd);
  const directory=await mkdtemp(join(observerRoot,'cli-witness-'));
  const observer=join(directory,'observer.mts'),preload=join(directory,'preload.mts'),record=join(directory,'record.json');
  await writeFile(observer,cliObserverSource);await writeFile(preload,cliProgressSource);
  try {
    const result=await execute(process.execPath,[observer,record,preload,cli,...args],options);
    if(result.exitCode!==0){
      try {
        const startup=await readFile(join(directory,'startup.json'),'utf8');
        const trace=failedCommands.getStore();
        if(trace!==undefined){trace.push(new Error(`TEST CLI returned failure observation: ${diagnosticText(JSON.stringify({controls:observedControls(startup),progress:diagnosticText(startup,2048)}),3600)}`));if(trace.length>4){trace.shift();}}
      } catch { /* A missing diagnostic never replaces the actual CLI result. */ }
    }
    return result;
  }
  catch(primary) {
    let raw='',detail='TEST CLI observer produced no record.',progress='TEST preload produced no record.',controls:unknown[]=[];
    try {raw=await readFile(record,'utf8');detail=diagnosticText(raw,20*1024);} catch {}
    try {const startup=await readFile(join(directory,'startup.json'),'utf8');progress=diagnosticText(startup,2048);controls=observedControls(startup);} catch {}
    let summary=diagnosticText(detail,3600);
    try {
      const snapshot=JSON.parse(raw) as Record<string,unknown>;
      summary=diagnosticText(JSON.stringify({controls,event:snapshot['event'],stderr:typeof snapshot['stderr']==='string'?diagnosticText(snapshot['stderr'],1536):null,progress,stdout:typeof snapshot['stdout']==='string'?diagnosticText(snapshot['stdout'],256):null,detail:diagnosticText(JSON.stringify(snapshot['detail'])??'',256)}),3600);
    } catch {}
    throw new AggregateError([primary,new Error(`TEST real CLI partial evidence: ${detail}`)],`TEST CLI execution failed; bounded child evidence: ${summary}`,{cause:primary});
  }
}

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
  const scriptNode = process.platform === 'win32' ? join('..','toolchain','bin','node.exe') : JSON.stringify(tool.nodeExecutable);
  const scriptCompiler = process.platform === 'win32' ? join('..','toolchain','node_modules','typescript','bin','tsc') : JSON.stringify(compilerPath);
  async function assertScriptToolPaths(cwd:string):Promise<void> {
    assert.equal(await realpath(join(cwd,'..','toolchain','bin',process.platform === 'win32' ? 'node.exe' : 'node')),tool.nodeExecutable);
    assert.equal(await realpath(join(cwd,'..','toolchain','node_modules','typescript','bin','tsc')),await realpath(compilerPath));
  }
  await assertScriptToolPaths(root);
  const scripts = {
    lint:'node lint.mts',
    typecheck:`node ${scriptCompiler} --project tsconfig.json --pretty false`,
    tests:'node observe.mts',
    pretests:`node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(join(output,'pre-sentinel'))},'unexpected')`)}`,
    posttests:`node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(join(output,'post-sentinel'))},'unexpected')`)}`,
    prerequisite:'node prerequisite.mts'
  };
  for(const name of Object.keys(scripts) as Array<keyof typeof scripts>) {scripts[name]=scripts[name].replace(/^node /u, `${scriptNode} `);}
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
    await assertScriptToolPaths(snapshot);
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
  const trace:Error[]=[];let primary:unknown,failed=false;
  try { await failedCommands.run(trace,()=>body({root,output,tool,scripts,files,freeze,runner,loadPolicy})); }
  catch(error) {
    failed=true;primary=trace.length===0?error:new AggregateError([error,...trace],'TEST fixture failed; original error and bounded owned command evidence.');
    try {await writeFile(`${directory}-failure.json`,JSON.stringify(trace.map(item=>item.message)));}
    catch(recordFailure){primary=new AggregateError([primary,recordFailure],'TEST fixture and diagnostic retention failed.');}
  }
  try {await rm(directory,{recursive:true,force:true});}
  catch(cleanup) {if(failed){throw new AggregateError([primary,cleanup],'TEST fixture and cleanup failed.',{cause:cleanup});}throw cleanup;}
  if(failed){throw primary;}
}
