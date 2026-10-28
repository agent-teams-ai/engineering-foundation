import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

type Package = { name: string; version: string; role: 'direct' | 'transitive'; integrity: string; registry: string };
type Input = { centralBase: string; proposedCohortId: string; expectedFive: Package[] };
type Projection = { revision: string; entry: string; files: Record<string, { sha256: string; bytes: number }> };
type Provenance = { commit: string; repository: string; workflow: string; ref: string; sha512: string; subjectName: string };
type ReleaseVerifier = { verifiedProvenanceFromNpmAudit: (audit: unknown, artifact: Package, source: Record<string, string>) => Provenance };
type Closure = { authority: { projection_path: string; digest: string; package_manager: string; schema_version: number; domain: string }; source: string };
type Resolver = { resolvePublishedRuntimeClosure: (packages: Package[], options: { cohortGeneration: 3; pnpmBinary: string }) => Promise<Closure> };
const [inputsArg, centralArg, foundationArg, toolingArg, allocationArg] = process.argv.slice(2);
assert(inputsArg && centralArg && foundationArg && toolingArg && allocationArg);
for (const path of [inputsArg, centralArg, foundationArg, toolingArg, allocationArg]) assert(isAbsolute(path));
const prepared = await realpath(inputsArg), central = await realpath(centralArg), foundation = await realpath(foundationArg);
const tooling = await realpath(toolingArg), allocation = resolve(allocationArg);
const originalHome = process.env.HOME;
assert(originalHome && originalHome === process.env.CLOSURE_ORIGINAL_HOME);
assert.equal(process.versions.node, '26.11.1'); assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
assert.equal(process.env.NODE_PATH, undefined);
for (const key of ['TMPDIR','NPM_CONFIG_CACHE','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_STATE_HOME','PNPM_HOME']) {
 const value=process.env[key]; assert(value && isAbsolute(value) && value.startsWith(dirname(allocation)+'/'), key);
}
for (const key of ['NODE_AUTH_TOKEN', 'NPM_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']) assert.equal(process.env[key], undefined, key);
const sha = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8')) as unknown;
await mkdir(allocation, { recursive: false, mode: 0o700 });
const evidence = join(allocation, 'evidence'); await mkdir(evidence, { mode: 0o700 });
const save = async (name: string, value: unknown): Promise<void> => { await writeFile(join(evidence, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); };
try {
 const inputBindings: Record<string,string> = {};
 for (const file of ['operator.ts','performance.yml','inputs.json','source-projection-manifest.json','audit.json']) inputBindings[file]=sha(await readFile(join(prepared,file)));
 await save('preparation-input-bindings.json',inputBindings);
 const toolingVersions: Record<string,string> = {};
 for (const [name,version] of [['pnpm','11.20.0'],['yaml','2.9.0'],['ajv','8.20.0'],['typescript','7.0.2'],['@types/node','24.13.3']]) {
  const pkg=await readJson(join(tooling,'node_modules',name!,'package.json')) as {version:string}; assert.equal(pkg.version,version); toolingVersions[name!]=pkg.version;
 }
 await save('tooling.json',{versions:toolingVersions,lockSHA256:sha(await readFile(join(tooling,'package-lock.json')))});
 const input = await readJson(join(prepared, 'inputs.json')) as Input;
 const manifest = await readJson(join(prepared, 'source-projection-manifest.json')) as Projection;
 assert.equal(input.centralBase, 'c8f3e7ba220241f79292c84c72712653019aa1df'); assert.equal(manifest.revision, input.centralBase);
 assert.equal(execFileSync('git', ['-C', central, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), input.centralBase);
 assert.equal(execFileSync('git', ['-C', foundation, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), '046976291864b9f0281213018232272a1ac4ed8c');
 const expected = [ ['repository-mutation','0.4.2','transitive'], ['document-authoring','0.3.6','transitive'], ['docs-protocol','0.6.6','direct'], ['docs-protocol-agent-teams','0.6.0','direct'], ['engineering-foundation','3.0.1','direct'] ];
 assert.deepEqual(input.expectedFive.map(p => [p.name.replace('@agent-teams/',''),p.version,p.role]), expected);
 for (const pkg of input.expectedFive) { assert.match(pkg.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/); assert.equal(pkg.registry,'https://registry.npmjs.org/'); }
 const auditBytes = await readFile(join(prepared, 'audit.json')); assert.equal(sha(auditBytes), 'a60a991fc9028c7b230471f230cb4622cb800655382fe10fcb515cc861681268');
 const audit = JSON.parse(auditBytes.toString()) as { invalid: unknown[]; missing: unknown[]; verified: Array<{ name: string; version: string; attestationBundles: Array<{predicateType: string; bundle: {dsseEnvelope: {payload: string}}}> }> };
 assert.deepEqual(audit.invalid, []); assert.deepEqual(audit.missing, []); assert.equal(audit.verified.length,12);
 const verifier = await import(pathToFileURL(join(foundation, 'scripts/release-publish-ordered-runtime.mjs')).href) as ReleaseVerifier;
 const historicalProof = [];
 for (const pkg of input.expectedFive) {
  const entry = audit.verified.filter(p => p.name===pkg.name && p.version===pkg.version); assert.equal(entry.length,1);
  const bundles=entry[0]!.attestationBundles.filter(b=>b.predicateType==='https://slsa.dev/provenance/v1'); assert.equal(bundles.length,1);
  const statement=JSON.parse(Buffer.from(bundles[0]!.bundle.dsseEnvelope.payload,'base64').toString()) as {predicate:{runDetails:{metadata:{invocationId:string}}}};
  const invocation=statement.predicate.runDetails.metadata.invocationId;
  assert.match(invocation,/^https:\/\/github.com\/agent-teams-ai\/engineering-foundation\/actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*$/);
  const proof=verifier.verifiedProvenanceFromNpmAudit(audit,pkg,{repository:'https://github.com/agent-teams-ai/engineering-foundation',workflow:'.github/workflows/release.yml',ref:'refs/heads/main',expectedInvocation:invocation});
  if (['docs-protocol-agent-teams','engineering-foundation'].some(n=>pkg.name==='@agent-teams/'+n)) { assert.equal(proof.commit,'046976291864b9f0281213018232272a1ac4ed8c'); assert.equal(invocation,'https://github.com/agent-teams-ai/engineering-foundation/actions/runs/40744415767/attempts/1'); }
  historicalProof.push({package:pkg.name,version:pkg.version,integrity:pkg.integrity,invocation,...proof});
 }
 await save('verified-existing-audit-provenance.json',historicalProof);
 const projection=join(allocation,'resolver-source'); await mkdir(projection);
 for (const [path,binding] of Object.entries(manifest.files)) {
  assert(!path.startsWith('/') && !path.split('/').includes('..'));
  const bytes=await readFile(join(central,path)); assert.equal(sha(bytes),binding.sha256,path); assert.equal(bytes.length,binding.bytes,path);
  const target=join(projection,path); await mkdir(dirname(target),{recursive:true}); await copyFile(join(central,path),target);
 }
 await writeFile(join(projection,'package.json'),' {"private":true,"type":"module"}\n');
 await symlink(join(tooling,'node_modules'),join(projection,'node_modules'),'dir');
 await save('resolver-source-manifest.json',manifest);
 const pnpm=join(tooling,'node_modules','.bin','pnpm'); assert.equal(execFileSync(pnpm,['--version'],{encoding:'utf8'}).trim(),'11.20.0');
 const previousCwd=process.cwd();
 process.chdir(central); // Exact imported community validator reads immutable Central data relative to cwd.
 const resolver=await import(pathToFileURL(join(projection,manifest.entry)).href) as Resolver;
 assert.equal(process.cwd(),central);
 assert.equal(typeof resolver.resolvePublishedRuntimeClosure,'function');
 const closure=await resolver.resolvePublishedRuntimeClosure(input.expectedFive,{cohortGeneration:3,pnpmBinary:pnpm});
 assert.equal(closure.authority.schema_version,2); assert.equal(closure.authority.domain,'agent-teams.docs-runtime-closure/v2');
 assert.equal(closure.authority.package_manager,'pnpm@11.20.0');
 assert.match(closure.authority.projection_path,/^governance\/docs-runtime-closures\/sha256-[0-9a-f]{64}\.json$/);
 assert.match(closure.authority.digest,/^sha256:[0-9a-f]{64}$/);
 await writeFile(join(evidence,'runtime-closure-source.json'),closure.source,{flag:'wx',mode:0o600});
 await save('runtime-closure-authority.json',closure.authority);
 process.chdir(previousCwd);
 assert.equal(process.env.HOME,originalHome);
 await save('result.json',{status:'EXISTING_RESOLVER_ACTUAL_GEN3_CLOSURE_PASS',use:'EF3.0.1_BASELINE_PREPARATION_NOT_FINAL_DATA',engineeringFoundation:'3.0.1',central:input.centralBase,foundation:'046976291864b9f0281213018232272a1ac4ed8c',node:process.versions.node,platform:process.platform,arch:process.arch,pnpm:'11.20.0',closureSourceSHA256:sha(closure.source),closureAuthority:closure.authority,originalHomeUnchanged:true,auditReused:true,fullConsumerInstall:false,cohortAuthority:false});
} catch (error) {
 await save('failure.json',{status:'FAILED_NO_COHORT_CLAIM',name:error instanceof Error?error.name:'unknown',message:error instanceof Error?error.message:'unknown'}); throw error;
}
