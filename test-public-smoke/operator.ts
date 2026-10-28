// Finite public-registry TEST consumer. No publication, managed upgrade, or controller authority.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, readdirSync, copyFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
interface Artifact { name:string; version:string; integrity:string; }
interface Tuple { source:string; runId:number; runAttempt:number; expectedInvocation:string; artifacts:Artifact[]; }
const source='046976291864b9f0281213018232272a1ac4ed8c';
const coordinates=[['@agent-teams/engineering-foundation','3.0.1'],['@agent-teams/feature-module-standard','0.3.1'],['@agent-teams/docs-protocol-agent-teams','0.6.0']] as const;
const registry='https://registry.npmjs.org/';
const [rootArg, trustedArg, npmArg, toolingArg, node24Arg]=process.argv.slice(2);
assert.ok(rootArg&&trustedArg&&npmArg&&toolingArg&&node24Arg);
const root=resolve(rootArg),trusted=resolve(trustedArg),npm=resolve(npmArg),tooling=resolve(toolingArg),node24=resolve(node24Arg);
assert.equal(process.platform,'linux');assert.equal(process.version,'v26.11.1');assert.ok(!existsSync(root));
const tuple=JSON.parse(process.env.PUBLICATION_TUPLE??'null') as Tuple;
assert.equal(tuple.source,source);assert.ok(Number.isSafeInteger(tuple.runId)&&tuple.runId>0&&Number.isSafeInteger(tuple.runAttempt)&&tuple.runAttempt>0);
assert.equal(tuple.expectedInvocation,`https://github.com/agent-teams-ai/engineering-foundation/actions/runs/${tuple.runId}/attempts/${tuple.runAttempt}`);
assert.deepEqual(tuple.artifacts.map(x=>[x.name,x.version]),coordinates);
for(const a of tuple.artifacts){assert.match(a.integrity,/^sha512-[A-Za-z0-9+/]{86}==$/);assert.equal(Buffer.from(a.integrity.slice(7),'base64').length,64);}
mkdirSync(root,{mode:0o700});for(const name of ['cache','tmp','consumer','evidence'])mkdirSync(join(root,name),{mode:0o700});
const json=(name:string,value:unknown)=>writeFileSync(join(root,'evidence',name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const digest=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const config=join(root,'empty.npmrc'),globalConfig=join(root,'empty-global.npmrc');writeFileSync(config,'',{flag:'wx'});writeFileSync(globalConfig,'',{flag:'wx'});
const env:Record<string,string>={};for(const key of ['PATH','HOME','SSL_CERT_FILE','SSL_CERT_DIR','LANG']){const v=process.env[key];if(v)env[key]=v;}
Object.assign(env,{TMPDIR:join(root,'tmp'),NPM_CONFIG_USERCONFIG:config,NPM_CONFIG_GLOBALCONFIG:globalConfig,NPM_CONFIG_CACHE:join(root,'cache'),NPM_CONFIG_REGISTRY:registry,NPM_CONFIG_IGNORE_SCRIPTS:'true',NPM_CONFIG_AUDIT:'false',NPM_CONFIG_FUND:'false',NPM_CONFIG_ENGINE_STRICT:'true',NODE_DISABLE_COMPILE_CACHE:'1'});
function repositoryIdentity(value:unknown):string{assert.equal(typeof value,'string');const url=new URL((value as string).replace(/^git\+/,''));assert.equal(url.protocol,'https:');assert.equal(url.username,'');assert.equal(url.password,'');assert.equal(url.search,'');assert.equal(url.hash,'');return url.origin+url.pathname.replace(/\.git$/,'').replace(/\/$/,'');}
const observations:unknown[]=[];let step='admission';
function command(binary:string,args:string[],cwd:string,expected=0):string{
 step=args[0]??'command';const result=spawnSync(binary,args,{cwd,env,encoding:'utf8',timeout:240000,maxBuffer:32*1024*1024,killSignal:'SIGKILL'});
 assert.ifError(result.error);assert.equal(result.signal,null);assert.equal(result.status,expected,`command-${step}-exit`);
 observations.push({binary:binary===process.execPath?'node26':binary===node24?'node24':'executable',args,exit:result.status,stdoutSHA256:digest(result.stdout),stderrSHA256:digest(result.stderr)});return result.stdout;
}
const runNpm=(args:string[],cwd=join(root,'consumer'))=>command(process.execPath,[npm,...args],cwd);
function census(path:string):Record<string,string>{const found:Record<string,string>={};const walk=(p:string)=>{for(const name of readdirSync(p)){const q=join(p,name),s=lstatSync(q);assert.ok(!s.isSymbolicLink());if(s.isDirectory())walk(q);else found[q.slice(path.length+1)]=digest(readFileSync(q));}};walk(path);return found;}
try{
 assert.equal(command(process.execPath,[npm,'--version'],root).trim(),'11.19.0');
 assert.equal(command('git',['rev-parse','HEAD'],trusted).trim(),source);
 assert.ok(!existsSync(join(trusted,'node_modules')));assert.equal(process.env.NODE_PATH,undefined);
 // Import the trusted relative-only verifier before any public consumer installation.
 const module=await import(pathToFileURL(join(trusted,'scripts/release-publish-ordered-runtime.mjs')).href) as {verifiedProvenanceFromNpmAudit:(e:unknown,a:Artifact,s:unknown)=>{commit:string}};
 assert.equal(typeof module.verifiedProvenanceFromNpmAudit,'function');json('trusted-import.json',{source,withoutNodeModules:true,withoutNODE_PATH:true,importedBeforeConsumerInstall:true});
 const consumer=join(root,'consumer');writeFileSync(join(consumer,'package.json'),JSON.stringify({private:true,type:'module',devDependencies:Object.fromEntries(coordinates)})+'\n',{flag:'wx'});
 runNpm(['install','--ignore-scripts','--save-exact','--no-audit','--fund=false','--package-lock=true',`--registry=${registry}`]);
 const lock=JSON.parse(readFileSync(join(consumer,'package-lock.json'),'utf8')) as {packages:Record<string,{version?:string;resolved?:string;integrity?:string;link?:boolean}>};
 for(const [path,p]of Object.entries(lock.packages)){if(!path)continue;assert.equal(p.link,undefined);assert.ok(p.resolved?.startsWith(registry));assert.match(p.integrity??'',/^sha512-/);}
 const manifests:Record<string,unknown>={};
 for(const a of tuple.artifacts){const p=join(consumer,'node_modules',a.name);assert.ok(lstatSync(p).isDirectory()&&!lstatSync(p).isSymbolicLink());const manifest=JSON.parse(readFileSync(join(p,'package.json'),'utf8'));assert.equal(manifest.name,a.name);assert.equal(manifest.version,a.version);assert.equal(lock.packages['node_modules/'+a.name]?.integrity,a.integrity);for(const section of ['dependencies','devDependencies','peerDependencies','optionalDependencies'])for(const value of Object.values(manifest[section]??{}))assert.ok(typeof value==='string'&&!/^(?:workspace|link|file|git):/.test(value));manifests[a.name]=manifest;}
 json('installed-manifests.json',manifests);json('lock.json',lock);
 const observed=()=>tuple.artifacts.map(a=>{const meta=JSON.parse(runNpm(['view',`${a.name}@${a.version}`,'--json']));const latest=JSON.parse(runNpm(['view',a.name,'dist-tags','--json']));assert.equal(meta.dist.integrity,a.integrity);assert.equal(latest.latest,a.version);assert.equal(repositoryIdentity(meta.repository.url),'https://github.com/agent-teams-ai/engineering-foundation');return{name:a.name,version:a.version,integrity:meta.dist.integrity,tarball:meta.dist.tarball,latest:latest.latest};});
 const before=observed();json('registry-before.json',before);
 const audit=JSON.parse(runNpm(['audit','signatures','--json','--include-attestations']));json('audit.json',audit);
 // Trusted exact-source verifier only; never import private code from an installed package.
 const provenances=tuple.artifacts.map(a=>module.verifiedProvenanceFromNpmAudit(audit,a,{repository:'https://github.com/agent-teams-ai/engineering-foundation',workflow:'.github/workflows/release.yml',ref:'refs/heads/main',expectedInvocation:tuple.expectedInvocation}));for(const p of provenances)assert.equal(p.commit,source);json('provenance.json',provenances);
 const imports=['@agent-teams/engineering-foundation','@agent-teams/engineering-foundation/local-mode','@agent-teams/engineering-foundation/scaffolding/qualification','@agent-teams/engineering-foundation/scaffolding','@agent-teams/engineering-foundation/ratchet','@agent-teams/engineering-foundation/source-graph','@agent-teams/engineering-foundation/sdk-growth-authority','@agent-teams/feature-module-standard','@agent-teams/feature-module-standard/fixtures','@agent-teams/feature-module-standard/node','@agent-teams/docs-protocol-agent-teams','@agent-teams/docs-protocol-agent-teams/qualification'];
 command(process.execPath,['--input-type=module','--eval',`for(const name of ${JSON.stringify(imports)})await import(name);`],consumer);json('imports.json',imports);
 command(process.execPath,['--input-type=module','--eval',"import{readFileSync}from'node:fs';const p=import.meta.resolve('@agent-teams/engineering-foundation/schemas/foundation-config/v2.schema.json');const value=JSON.parse(readFileSync(new URL(p),'utf8'));if(typeof value.$id!=='string')throw Error('public-schema');"],consumer);
 const ef=join(consumer,'node_modules/.bin/agent-teams-foundation'),adapter=join(consumer,'node_modules/.bin/agent-teams-docs-managed');
 assert.equal(command(process.execPath,[ef,'version'],consumer).trim(),'3.0.1');assert.match(command(process.execPath,[ef,'--help'],consumer),/Usage:/);
 const self=JSON.parse(command(process.execPath,[ef,'self-check','--json'],consumer));json('self-check.json',self);
 const invalidFoundation=JSON.parse(command(process.execPath,[ef,'unknown-smoke-command','--json'],consumer,2));assert.equal(invalidFoundation.schemaVersion,1);assert.equal(invalidFoundation.outcome,'invalid-input');assert.equal(invalidFoundation.error.code,'CONSUMER_INVALID');assert.equal(invalidFoundation.error.retryable,false);json('foundation-refusal.json',invalidFoundation);
 copyFileSync(join(dirname(new URL(import.meta.url).pathname),'probe.ts'),join(consumer,'probe.ts'));
 const ts=join(tooling,'node_modules/typescript/bin/tsc');writeFileSync(join(consumer,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',strict:true,noEmit:true,skipLibCheck:true,types:['node'],typeRoots:[join(tooling,'node_modules/@types')]},files:['probe.ts']})+'\n');
 assert.equal(command(process.execPath,[ts,'--version'],consumer).trim(),'Version 7.0.2');command(process.execPath,[ts,'-p','tsconfig.json'],consumer);
 const fmsRoot=join(root,'fms-fixture');mkdirSync(fmsRoot);const fms=JSON.parse(command(process.execPath,[join(consumer,'probe.ts'),fmsRoot,join(root,'evidence/self-check.json')],consumer));json('fms.json',fms);
 const fixture=join(root,'cli-fixture');mkdirSync(fixture);const unchanged=census(fixture);
 const vectors=[['unknown-smoke-command','--json'],['upgrade','--to','smoke','--json'],['upgrade','--to','smoke','--target-generation','4','--json'],['upgrade','--to','smoke','--target-generation','3','--target-generation','3','--json'],['upgrade','--to','smoke','--target-generation','3','--source-generation','2','--prepare','--target-lockfile','unused','--target-lockfile-sha256','sha256:'+('0'.repeat(64)),'--restoration-proof','unused','--json']];
 const checkCLI=(binary:string)=>{assert.match(command(binary,[adapter,'--help'],fixture),/--target-generation 1\|2\|3/);return vectors.map((args,index)=>{const v=JSON.parse(command(binary,[adapter,...args],fixture,2));assert.equal(v.outcome,'blocked');assert.ok(v.issues.some((i:{code:string})=>i.code==='DOCS_CONSUMER_CLI_INVALID'));if(index===1)assert.match(v.issues[0].message,/--target-generation is required/);if(index===2)assert.match(v.issues[0].message,/exactly 1, 2 or 3/);if(index===3)assert.match(v.issues[0].message,/may be supplied only once/);if(index===4)assert.match(v.issues[0].message,/Target lock requires both flags and explicit 1->2/);return {args,result:v};});};
 json('adapter-node26.json',checkCLI(process.execPath));assert.equal(command(node24,['--version'],fixture).trim(),'v24.21.0');json('adapter-node24.json',checkCLI(node24));JSON.parse(command(node24,[ef,'self-check','--json'],fixture));assert.deepEqual(census(fixture),unchanged);
 assert.deepEqual(observed(),before);json('commands.json',observations);json('result.json',{kind:'public-release-three-root-smoke/v1',outcome:'pass',source,publication:tuple,node:process.version,imports:imports.length,controllerExecution:false,managedUpgrade:false,lockSHA256:digest(readFileSync(join(consumer,'package-lock.json'))),fixtureUnchanged:true});
}catch(error){json('commands.json',observations);json('result.json',{kind:'public-release-three-root-smoke/v1',outcome:'fail',source,step,code:error instanceof Error&&error.name==='AssertionError'?'assertion-failed':'smoke-failed'});process.exitCode=1;}
