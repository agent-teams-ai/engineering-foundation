import { indexSurfaces, surfaceBindings } from "../../../scripts/feature-modules/surfaces.mjs";
import { validateObservations, validateTopology } from "../../../scripts/feature-modules/dependencies.mjs";
import { invalidAssemblyStatements } from "../../../scripts/feature-modules/assembly.mjs";
import { posix } from "node:path";
const src='packages/provider/src', fsroot=src+'/features/storage', consumer='packages/consumer/src/features/alpha/application/index.js', comp=fsroot+'/composition/api.js', pub=src+'/index.js';
const domain=fsroot+'/domain/index.js', adapter=fsroot+'/adapters/index.js', afactory=fsroot+'/adapters/factory.js';
function module(id, sourceRoot, roles) {
 return {id,packageName:'@fixture/'+id,root:posix.dirname(sourceRoot),sourceRoot,publicEntrypoints:[sourceRoot+'/index.js'],moduleAssembly:[sourceRoot+'/index.js'],generatedRoots:[],exceptions:[],features:[{id:id==='provider'?'storage':'alpha',layers:roles.map(role=>({role,roots:[sourceRoot+'/features/'+(id==='provider'?'storage':'alpha')+'/'+role]}))}]};
}
const imports='import {safe} from "../domain/index.js"; import {read} from "../adapters/index.js";';
function inspect({code, factory, consumerCode='import {execute} from "@fixture/provider"; export {execute};', publicCode, extra={}, exportTargets=["./src/index.js"]}) {
 const snaps=new Map([[consumer,consumerCode],[domain,'export function safe(){return "domain";}'],[adapter,'export function read(){return "adapter";}'],[pub,publicCode??'export {execute} from "./features/storage/composition/api.js";'],[comp,code],...Object.entries(extra)]);
 if(factory) {snaps.set(afactory,factory);}
 const problems=[],sources=indexSurfaces([...snaps.keys()],problems,snaps);
 const profile={modules:[module('provider',src,['domain','application','adapters','composition']),module('consumer','packages/consumer/src',['application'])]};
 profile.modules[0].publicEntrypoints=exportTargets.map(target=>posix.join('packages/provider',target));
 profile.modules[0].moduleAssembly=[...profile.modules[0].publicEntrypoints];
 const boundaries=profile.modules.flatMap(m=>[...m.features[0].layers.map(l=>({id:m.id+'-'+l.role,roots:l.roots,entrypoints:[...snaps.keys()].filter(p=>p.startsWith(l.roots[0]+'/')),allow:{boundaries:[],packages:[],builtins:[],runtimeReferences:[]}})),{id:m.id+'-assembly',roots:m.moduleAssembly,entrypoints:m.moduleAssembly,allow:{boundaries:[],packages:[],builtins:[],runtimeReferences:[]}}]);
 const policy={schemaVersion:2,boundaries};
 const observations=[];
 for(const [path,surface] of sources) {for(const statement of surface.program.body) {
  if(!statement.source) {continue;}
  const specifier=statement.source.value;
  const reference={start:statement.source.start,specifier};
  const result=specifier==='@fixture/provider'?{kind:'workspace-package',exported:true,workspacePackage:{name:'@fixture/provider'},subpath:'.'}:{kind:'local-file',path:posix.normalize(posix.join(posix.dirname(path),specifier))};
  observations.push({path,reference,result,...(result.kind==='workspace-package'?{exportTargets}: {})});
 }}
 for(const o of observations) {if(o.result.kind==='local-file') {
  const from=boundaries.find(b=>b.entrypoints.includes(o.path)),to=boundaries.find(b=>b.entrypoints.includes(o.result.path)); if(from&&to&&!from.allow.boundaries.includes(to.id)){from.allow.boundaries.push(to.id);}
 }}
 const bindings=surfaceBindings(profile,policy,observations,sources,new Map([['@fixture/provider',[exportTargets]]]));
 validateTopology(profile,policy,problems);
 validateObservations(profile,policy,observations,problems,{sources,bindings});
 for (const m of profile.modules) {
  for (const p of m.moduleAssembly) {
   if (!sources.has(p)) {continue;}
   for (const n of invalidAssemblyStatements(p,sources.get(p),bindings,false)) {problems.push({code:'assembly-behavior',message:p+':'+n.start});}
  }
 }
 const observation=observations.find(o=>o.path===consumer);
 const owners=bindings.owners(observation).map(o=>o?{path:o.path,role:o.owner?.layer?.role}:null);
 return {snaps,problems,owners,bindings,sources,profile,observations};
}

export function registerFactoryReviewCases({ test, assert }) {
  const unknown = (result) => {
    assert.ok(result.owners.includes(null), JSON.stringify(result.owners));
    assert.ok(result.problems.some(({code}) => code === "surface-ownership"), JSON.stringify(result.problems));
  };
  const owned = (result, path, role) => assert.deepEqual(result.owners, [{path, role}]);
  const importedFactory = 'import {createApi} from "../adapters/factory.js"; export const {execute}=createApi();';
  registerFactoryValueCases({test, assert, unknown, owned, importedFactory});
  for (const [name, code] of [
    ["module object write", 'const state={execute:safe}; state.execute=read; function createApi(){return state;}'],
    ["module factory reassignment", 'function createApi(){return {execute:safe};} createApi=()=>({execute:read});'],
    ["module alias escape", 'const state={execute:safe}; const alias=state; function replace(x){x.execute=read;} replace(alias); function createApi(){return state;}'],
    ["factory invokes captured module writer", 'const state={execute:safe}; function createApi(){const ignored=replace(); return state;} function replace(){state.execute=read;}'],
    ["module destructured alias escape", 'const state={execute:safe}; const {alias}={alias:state}; function replace(x){x.execute=read;} replace(alias); function createApi(){return state;}'],
    ["module loop assignment", 'const state={execute:safe}; for(state.execute of [read]){} function createApi(){return state;}'],
    ["module captured default write", 'const state={execute:safe}; function replace(x=(state.execute=read)){} function createApi(){return state;}'],
  ]) {
    test(`factory review rejects ${name}`, () => unknown(inspect({code: imports+code+' export const {execute}=createApi();'})));
  }
  for (const [name, action] of [
    ["default parameter alias", 'function replace(alias=state){alias.execute=read;} replace();'],
    ["destructured parameter alias", 'function replace({alias=state}={}){alias.execute=read;} replace();'],
    ["array parameter alias", 'function replace([alias=state]=[]){alias.execute=read;} replace();'],
    ["default before body alias shadow", 'function replace(alias=state){var state={}; alias.execute=read;} replace();'],
    ["for-of declaration alias", 'for(const alias of [state]){alias.execute=read;}'],
    ["for-of destructured alias", 'for(const {alias} of [{alias:state}]){alias.execute=read;}'],
    ["for-of var alias", 'for(var alias of [state]){alias.execute=read;}'],
    ["temporary returned property write", 'function expose(){return state;} expose().execute=read;'],
    ["temporary returned destructuring target", 'function expose(){return state;} ({value:expose().execute}={value:read});'],
    ["temporary returned loop target", 'function expose(){return state;} for(expose().execute of [read]){}'],
    ["temporary IIFE target", '(()=>state)().execute=read;'],
    ["temporary returned update", 'function expose(){return state;} expose().execute++;'],
    ["temporary returned delete", 'function expose(){return state;} delete expose().execute;'],
    ["generator yield alias", 'function* expose(){yield state;} const {value:alias}=expose().next(); alias.execute=read;'],
    ["generator delegation alias", 'function* expose(){yield* [state];} const {value:alias}=expose().next(); alias.execute=read;'],
    ["generator returned alias", 'function* expose(){return state;} const {value:alias}=expose().next(); alias.execute=read;'],
    ["async then alias", 'async function expose(){return state;} await expose().then(alias=>{alias.execute=read;});'],
    ["async IIFE then alias", 'await (async()=>state)().then(alias=>{alias.execute=read;});'],
    ["async generator yielded alias", 'async function* expose(){yield state;} for await(const alias of expose()){alias.execute=read;}'],
    ["throw catch alias", 'try{throw state;}catch(alias){alias.execute=read;}'],
    ["throw constructor returned alias", 'class Expose{constructor(){return state;}} try{throw new Expose();}catch(alias){alias.execute=read;}'],
    ["throw returned alias", 'function expose(){return state;} try{throw expose();}catch(alias){alias.execute=read;}'],
    ["returned alias write", 'function expose(){return state;} const alias=expose(); alias.execute=read;'],
    ["arrow returned alias write", 'const expose=()=>state; const alias=expose(); alias.execute=read;'],
    ["block arrow returned alias write", 'const expose=()=>{return state;}; const alias=expose(); alias.execute=read;'],
    ["returned alias chain write", 'function expose(){return state;} const first=expose(); const alias=first; alias.execute=read;'],
    ["returned object alias write", 'function expose(){return {value:state};} const holder=expose(); holder.value.execute=read;'],
    ["binding default execution", 'const {value=(state.execute=read)}={};'],
    ["array binding default execution", 'const [value=(state.execute=read)]=[];'],
    ["binding computed key execution", 'const {[state.execute=read]:value}={};'],
    ["nested binding default execution", 'const {nested:{value=(state.execute=read)}}={nested:{}};'],
    ["for initializer binding execution", 'for(const {value=(state.execute=read)}={};false;){}'],
    ["switch discriminant outer binding", 'switch(state.execute=read){default: const state={};}'],
  ]) {
    test(`factory review residual rejects ${name}`, () => unknown(inspect({
      code: imports+' const state={execute:safe}; '+action+' function createApi(){return state;} export const {execute}=createApi();'
    })));
  }
  for (const [name, change] of [
    ["factory default alias", 'function change(alias=api){alias.execute=provided;}'],
    ["factory destructured default alias", 'function change({alias=api}={}){alias.execute=provided;}'],
    ["factory loop alias", 'function change(){for(const alias of [api]){alias.execute=provided;}}'],
    ["factory temporary IIFE target", 'function change(){(()=>api)().execute=provided;}'],
    ["factory async wrapper alias", 'function change(){return (async()=>api)().then(alias=>{alias.execute=provided;});}'],
    ["factory thrown alias", 'function change(){try{throw api;}catch(alias){alias.execute=provided;}}'],
    ["factory returned alias", 'function change(){function expose(){return api;} const alias=expose(); alias.execute=provided;}'],
    ["factory binding execution", 'function change(){const {value=(api.execute=provided)}={};}'],
    ["factory switch discriminant", 'function change(){switch(api.execute=provided){default:const api={};}}'],
  ]) {
    test(`factory review residual rejects ${name}`, () => unknown(inspect({
      code:'import {createApi} from "../application/factory.js"; import {read} from "../adapters/index.js"; export const execute=createApi(read);',
      extra:{[fsroot+'/application/factory.js']:'import {safe} from "../domain/index.js"; export function createApi(provided){const api={execute:safe}; '+change+' return {api,change};}'}
    })));
  }
  for (const inner of ['function unused(){return state;}', 'const unused=()=>state;']) {
    // The finite frame analysis does not prove that an inner closure is unused.
    test(`factory review records conservative untracked closure ${inner}`, () => unknown(inspect({
      code:imports+' const state={execute:safe}; function outer(){'+inner+'} function createApi(){return state;} export const {execute}=createApi();'
    })));
  }
  test("factory review temporary returned receiver mutation stays unknown", () => unknown(inspect({
    code:imports+' const state={execute:safe,change(){this.execute=read;}}; function expose(){return state;} expose().change(); function createApi(){return state;} export const {execute}=createApi();'
  })));
  for (const [name, action] of [
    ["unused returned alias", 'function expose(){return state;} const alias=expose();'],
    ["unused arrow returned alias", 'const expose=()=>state; const alias=expose();'],
    ["alias binding reassignment", 'function expose(){return state;} let alias=expose(); alias={execute:read};'],
    ["returned primitive", 'function expose(){return 1;} const alias=expose();'],
    ["parameter alias of inner shadow", 'function replace(state,alias=state){alias.execute=read;} replace({});'],
    ["block binding initializer shadow", '{const state={}; const {value=(state.execute=read)}={};}'],
    ["switch case local binding", 'switch(1){default:const state={}; state.execute=read;}'],
    ["switch test local binding", 'switch(1){case (state.execute=read): break; default:const state={};}'],
    ["for-of loop binding shadow", 'for(const state of [{}]){state.execute=read;}'],
  ]) {
    test(`factory review residual preserves ${name}`, () => {
      const result=inspect({code:imports+' const state={execute:safe}; '+action+' function createApi(){return state;} export const {execute}=createApi();'});
      owned(result,domain,"domain"); assert.deepEqual(result.problems,[]);
    });
  }
  for (const [name, change] of [
    ["default parameter captured write", 'function change(value=(api.execute=provided)){}'],
    ["default parameter body var does not shadow", 'function change(value=(api.execute=provided)){var api;}'],
    ["default parameter body function does not shadow", 'function change(value=(api.execute=provided)){function api(){}}'],
    ["destructured default captured write", 'function change({value=(api.execute=provided)}={}){}'],
    ["computed parameter captured write", 'function change({[api.execute=provided]:value}={}){}'],
    ["for-of captured target", 'function change(){for(api.execute of [provided]){}}'],
    ["for-in captured target", 'function change(){for(api.execute in {a:provided}){}}'],
    ["destructured for-of captured target", 'function change(){for({value:api.execute} of [{value:provided}]){}}'],
    ["ordinary captured write", 'function change(){api.execute=provided;}'],
  ]) {
    test(`factory review rejects ${name}`, () => unknown(inspect({
      code:'import {createApi} from "../application/factory.js"; import {read} from "../adapters/index.js"; export const execute=createApi(read);',
      extra:{[fsroot+'/application/factory.js']:'import {safe} from "../domain/index.js"; export function createApi(provided){const api={execute:safe}; '+change+' return {api,change};}'}
    })));
  }
  for (const [name, change] of [
    ["real parameter shadow in defaults", 'function change(api,value=(api.execute=provided)){}'],
    ["body var shadows body write", 'function change(){var api={}; api.execute=provided;}'],
    ["lexical loop declaration", 'function change(){for(const api of [provided]){api.execute=provided;}}'],
    ["default function expression self shadow", 'const change=function api(value=(api.execute=provided)){};'],
  ]) {
    test(`factory review preserves ${name}`, () => {
      const result=inspect({code:imports+' function createApi(provided){const api={execute:safe}; '+change+' return api;} export const {execute}=createApi(read);'});
      owned(result,domain,"domain"); assert.deepEqual(result.problems,[]);
    });
  }
  for (const [name, provided, path, role] of [["domain", "safe", domain, "domain"], ["adapter", "read", adapter, "adapters"]]) {
    test(`factory review retains ${name} caller identity`, () => {
      const result=inspect({code:imports+' function createApi(safe){return {execute:safe};} export const {execute}=createApi('+provided+');'});
      owned(result,path,role);
      assert.equal(result.problems.some(({code})=>code==='layer-direction'),role==='adapters');
    });
  }
  test("factory review named expression self precedes imported name", () => {
    const result=inspect({code:importedFactory, factory:'import {safe as self} from "../domain/index.js"; export const createApi=function self(){return {execute:self};};'});
    owned(result,afactory,"adapters");
    assert.ok(result.problems.some(({code})=>code==='layer-direction'));
  });
  test("factory review named expression real parameter shadows self", () => {
    const result=inspect({code:imports+' import {createApi} from "../adapters/factory.js"; export const {execute}=createApi(read);',factory:'import {safe as self} from "../domain/index.js"; export const createApi=function self(self){return {execute:self};};'});
    owned(result,adapter,"adapters");
  });
  test("factory review named expression body declaration shadows self", () => {
    const result=inspect({code:importedFactory,factory:'import {safe} from "../domain/index.js"; export const createApi=function self(){const self=safe; return {execute:self};};'});
    owned(result,domain,"domain");
  });
  for (const factory of [
    'import {safe} from "../domain/index.js"; function make(){return {execute:safe};} export const createApi={make};',
    'import {safe} from "../domain/index.js"; function make(){return {execute:safe};} const object={make}; export const createApi=object;',
    'import {safe} from "../domain/index.js"; export const createApi={make(){return {execute:safe};},other:()=>({execute:safe})};'
  ]) {
    test(`factory review rejects calling object ${factory.length}`, () => unknown(inspect({code:importedFactory,factory})));
  }
  for (const [name,factory] of [
    ["async factory", 'export async function createApi(){return {execute:safe};}'],
    ["generator factory", 'export function* createApi(){return {execute:safe};}'],
    ["unresolved bind factory", 'function make(){return {execute:safe};} export const createApi=make.bind(null);']
  ]) {
    test(`factory review keeps ${name} unknown`, () => unknown(inspect({code:importedFactory,factory:'import {safe} from "../domain/index.js"; '+factory})));
  }
  test("factory review default declaration reassignment is unknown", () => {
    unknown(inspect({code:'import createApi from "../adapters/factory.js"; export const {execute}=createApi();', factory:'import {safe} from "../domain/index.js"; import {read} from "./index.js"; export default function createApi(){return {execute:safe};} createApi=()=>({execute:read});'}));
  });
  for (const [name,action] of [
    ["nested alias", 'function replace(){const alias=state; alias.execute=read;} replace();'],
    ["external assignment escape", 'const holder={}; holder.value=state; function replace(x){x.value.execute=read;} replace(holder);']
  ]) {
    test(`factory review rejects ${name}`, () => unknown(inspect({code:imports+' const state={execute:safe}; '+action+' function createApi(){return state;} export const {execute}=createApi();'})));
  }
  for (const [name,factory] of [
    ["dynamic receiver access", 'function make(){return {execute:safe,change(){eval("this.execute=read");}};} const api=make(); api.change();'],
    ["receiver mutation", 'function make(){return {execute:safe,change(){this.execute=read;}};} const api=make(); api.change();'],
    ["receiver escape", 'function make(){return {execute:safe,change(){replace(this);}};} function replace(api){api.execute=read;} const api=make(); api.change();'],
    ["unknown receiver method", 'function make(){return {execute:safe,change:opaque};} const api=make(); api.change();']
  ]) {
    test(`factory review rejects ${name}`, () => unknown(inspect({code:imports+factory+' export const execute=api.execute;'})));
  }
  test("factory review preserves typed exact wrapper over immutable factory methods", () => {
    const result=inspect({code:'export {};',publicCode:'export {execute} from "./features/storage/composition/typed.ts";',extra:{[fsroot+'/composition/typed.ts']:imports+' function make(){return {execute:safe};} const api=make(); export function execute(input: string, ...rest: string[]){return api.execute(input,...rest);}'}});
    owned(result,domain,"domain"); assert.deepEqual(result.problems,[]);
  });
  test("factory review immutable module closure inputs remain precise", () => {
    const result=inspect({code:imports+' const state={execute:safe}; function createApi(){return state;} export const {execute}=createApi();'});
    owned(result,domain,"domain"); assert.deepEqual(result.problems,[]);
  });
  test("factory review object ownership enumerates every member and unknown", () => {
    const result=inspect({code:imports+' export const execute={safe,read,opaque:missing};'});
    assert.ok(result.owners.some(x=>x?.path===domain)); assert.ok(result.owners.some(x=>x?.path===adapter)); unknown(result);
  });
  test("factory review selected member ignores unrelated opaque member", () => {
    const result=inspect({code:imports+' const object={safe,opaque:missing}; export const execute=object.safe;'});
    owned(result,domain,"domain"); assert.deepEqual(result.problems,[]);
  });
  for (const [name, branch] of [["forbidden", 'export {read as execute} from "./features/storage/adapters/index.js";'], ["unknown", 'export const execute=opaque;']]) {
    test(`factory review retains ${name} conditional export branch`, () => {
      const result=inspect({code:imports+' function make(){return {execute:safe};} export const {execute}=make();',exportTargets:['./src/index.js','./src/branch.js'],extra:{[src+'/branch.js']:branch}});
      assert.ok(result.owners.some(x=>x?.path===domain));
      if(name==='unknown') {unknown(result);} else {
        assert.ok(result.owners.some(x=>x?.path===adapter));
        assert.ok(result.problems.some(({code})=>code==='layer-direction'));
      }
    });
  }
  test("factory review excessively deep aliases stay unknown", () => {
    const aliases=['const a0=safe;',...Array.from({length:150},(_,i)=>`const a${i+1}=a${i};`)];
    unknown(inspect({code:imports+aliases.join('')+' export const execute=a150;'}));
  });
  test("factory review same closure AST retains each invocation environment", () => {
    const result=inspect({code:imports+' function make(provided){function closure(){return {execute:provided};} return closure;} const good=make(safe); const bad=make(read); const opaque=make(missing); export const execute={good:good(),bad:bad(),opaque:opaque()};'});
    assert.ok(result.owners.some(x=>x?.path===domain)); assert.ok(result.owners.some(x=>x?.path===adapter)); unknown(result);
  });
  test("factory review repeated alias expansion has bounded results", () => {
    const aliases=['const a0={left:safe,right:safe};',...Array.from({length:17},(_,i)=>`const a${i+1}={left:a${i},right:a${i}};`)];
    const result=inspect({code:imports+aliases.join('')+' export const execute=a17;'});
    assert.ok(result.owners.length<=2, `expanded ${result.owners.length} origins`);
    assert.ok(result.owners.every(x=>x===null||x.path===domain));
    unknown(result);
  });
  test("factory review expansion preserves distinct invocation environments and unknown", () => {
    const result=inspect({code:imports+' function createApi(provided){return {execute:provided};} const good=createApi(safe); const bad=createApi(read); const opaque=createApi(missing); export const execute={good,bad,opaque};'});
    assert.ok(result.owners.some(x=>x?.path===domain)); assert.ok(result.owners.some(x=>x?.path===adapter)); unknown(result);
  });
}

function registerFactoryValueCases({test, assert, unknown, owned, importedFactory}) {
  for (const literal of ['"marker"', "42", "42n", "true", "null"]) {
    test(`factory review preserves escaped primitive ${literal}`, () => {
      const result=inspect({code:importedFactory,factory:'const marker='+literal+'; function use(alias=marker){} export function createApi(){return {execute:marker};}'});
      owned(result,afactory,"adapters");
      assert.ok(result.problems.some(({code})=>code==='layer-direction'));
    });
  }
  for (const literal of ['"marker"', "42", "42n", "false", "null"]) {
    test(`factory review preserves escaped imported primitive ${literal}`, () => {
      const result=inspect({code:importedFactory,factory:'import {marker} from "../domain/index.js"; function use(alias=marker){} export function createApi(){return {execute:marker};}',extra:{[domain]:'export const marker='+literal+';'}});
      owned(result,domain,"domain"); assert.deepEqual(result.problems,[]);
    });
  }
  for (const value of ['{value:42}', '/x/g']) {
    test(`factory review escaped imported mutable value stays unknown ${value}`, () => unknown(inspect({
      code:importedFactory,factory:'import {marker} from "../domain/index.js"; function use(alias=marker){alias.value=2;} use(); export function createApi(){return {execute:marker};}',extra:{[domain]:'export const marker='+value+';'}
    })));
  }
  test("factory review stable imported primitive is not callable", () => unknown(inspect({
    code:'import {marker} from "../domain/index.js"; function copy(value=marker){} export const {execute}=marker();',extra:{[domain]:'export const marker=42;'}
  })));
  for (const [name,value] of [["function","safe"],["primitive","42"]]) {
    test(`factory review retains escaped factory result ${name}`, () => {
      const result=inspect({code:imports+' function make(){return '+value+';} const operation=make(); function use(value){} use(operation); export const execute=operation;'});
      owned(result,name==='function'?domain:comp,name==='function'?"domain":"composition");
    });
  }
  test("factory review escaped mutable factory result remains unknown", () => unknown(inspect({
    code:imports+' function make(){return {execute:safe};} const api=make(); function use(value){value.execute=read;} use(api); export const execute=api.execute;'
  })));
  test("factory review escaped imported factory function keeps its owner", () => {
    const operation=fsroot+'/application/operation.js';
    const result=inspect({code:'import {createOperation} from "../application/operation.js"; const operation=createOperation(); function wire(execute){return {execute};} export const {execute}=wire(operation);',extra:{[operation]:'export function createOperation(){return async function execute(input){return input;};}'}});
    owned(result,operation,"application"); assert.deepEqual(result.problems,[]);
  });
  test("factory review escaped RegExp literal remains unknown", () => unknown(inspect({
    code:importedFactory,factory:'const marker=/x/g; function use(alias=marker){alias.lastIndex=1;} use(); export function createApi(){return {execute:marker};}'
  })));
  test("factory review reassigned primitive remains unknown", () => unknown(inspect({
    code:importedFactory,factory:'let marker="safe"; marker="changed"; export function createApi(){return {execute:marker};}'
  })));
  test("factory review thrown imported error retains constructor identity", () => {
    const result=inspect({code:'import {Fault} from "../domain/index.js"; function fail(){throw new Fault();} export const execute=Fault;',extra:{[domain]:'export class Fault extends Error {}'}});
    owned(result,domain,"domain"); assert.deepEqual(result.problems,[]);
  });
  test("factory review escaped class is not a callable factory", () => unknown(inspect({
    code:'import {Fault} from "../domain/index.js"; function fail(){throw new Fault();} export const {execute}=Fault();',extra:{[domain]:'export class Fault extends Error {}'}
  })));
  test("factory review reassigned class stays unknown", () => unknown(inspect({
    code:importedFactory,factory:'class Fault {} Fault=class Other {}; export function createApi(){return {execute:Fault};}'
  })));
  for (const selection of ['namespace', 'namespace()']) {
    test(`factory review escaped namespace is not a stable scalar ${selection}`, () => unknown(inspect({
      code:'import * as namespace from "../domain/index.js"; function use(value){} use(namespace); export const execute='+selection+';'
    })));
  }
}
