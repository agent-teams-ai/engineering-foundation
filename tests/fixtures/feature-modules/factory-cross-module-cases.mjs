import { symbolFactoryCases } from "./factory-symbol-cases.mjs";
import { starFactoryCases } from "./factory-star-cases.mjs";
import { indexSurfaces, surfaceBindings } from "../../../scripts/feature-modules/surfaces.mjs";
import { observeDependencies, validateObservations } from "../../../scripts/feature-modules/dependencies.mjs";

const src = "packages/other/src", feature = `${src}/features/storage`;
const domain = `${feature}/domain/index.ts`, adapter = `${feature}/adapters/index.ts`;
const factory = `${feature}/application/factory.ts`, composition = `${feature}/composition/api.ts`;
const factorySource = 'import {safe} from "../domain/index.js"; const api={execute:safe,change(value){this.execute=value;}}; export function expose(){return api;} export function createApi(){return api;}';
const imports = 'import {expose,createApi} from "../application/factory.js"; import {read} from "../adapters/index.js";';
const exported = 'export const {execute}=createApi();';
const owner = (path, role) => ({path, role});
const normalize = (owners) => owners.map((entry) => entry ? owner(entry.path, entry.owner?.layer?.role) : null)
  .toSorted((left, right) => (left?.path ?? "").localeCompare(right?.path ?? ""));

async function physicalFixture(t, workspaceSurface, spec) {
  const f = await workspaceSurface(t, spec.consumer ?? 'import {execute} from "@fixture/other"; export {execute};',
    spec.surface ?? 'export {execute} from "./features/storage/composition/api.js";');
  const root = `${feature}/composition`;
  f.module.features[0].layers.push({role:"composition",roots:[root]});
  f.sourcePolicy.boundaries.push({id:"other-composition",roots:[root],entrypoints:[composition],
    allow:{boundaries:["other-domain","other-adapters","other-application"],packages:[],builtins:[],runtimeReferences:[]}});
  f.otherAssembly.allow.boundaries.push("other-composition");
  f.sourcePolicy.boundaries.find(({id}) => id === "other-application").allow.boundaries.push("other-domain");
  for (const [from, to] of spec.boundaryEdges ?? []) {
    f.sourcePolicy.boundaries.find(({id}) => id === from).allow.boundaries.push(to);
  }
  const snapshots = new Map([
    [domain, 'export function safe(){return "domain";}'], [adapter, 'export function read(){return "adapter";}'],
    [factory, spec.factory ?? factorySource], [composition, spec.code ?? imports + spec.action + exported],
    ...Object.entries(spec.extra ?? {})
  ]);
  for (const [path, source] of snapshots) {
    await f.write(path, source);
    const boundary = f.sourcePolicy.boundaries.find(({roots}) => roots.some((entry) => path.startsWith(entry + "/")));
    if (boundary && !spec.internal?.includes(path) && !boundary.entrypoints.includes(path)) {boundary.entrypoints.push(path);}
  }
  if (spec.branches) {
    const branches = ["./src/index.ts", "./src/branch.ts"];
    f.module.publicEntrypoints.push(`${src}/branch.ts`);
    f.module.moduleAssembly.push(`${src}/branch.ts`);
    f.otherAssembly.roots.push(`${src}/branch.ts`);
    f.otherAssembly.entrypoints.push(`${src}/branch.ts`);
    await f.write("packages/other/package.json", JSON.stringify({name:"@fixture/other",version:"1.0.0",type:"module",exports:{".":{import:branches[0],require:branches[1]}}}));
  }
  const result = await f.check();
  const observed = await observeDependencies(f.repositoryRoot, "policy.yaml");
  return {...f, result, observed};
}

function assertOrders(assert, f, expected) {
  const {observed, profile, sourcePolicy} = f;
  assert.deepEqual(observed.diagnostics, []);
  const target = observed.observations.find(({path, reference}) => path === `${f.sourceRoot}/features/alpha/application/index.ts` && reference.specifier === "@fixture/other");
  assert.ok(target);
  const keys = [...observed.sourceSnapshots.keys()];
  let firstOrder;
  for (const files of [keys, keys.toReversed()]) {
    for (const observations of [observed.observations, observed.observations.toReversed()]) {
      const problems = [], sources = indexSurfaces(files, problems, observed.sourceSnapshots);
      assert.deepEqual(problems, []);
      const bindings = surfaceBindings(profile, sourcePolicy, observations, sources, observed.packageExportTargets);
      const order = bindings.owners(target).map((entry) => entry?.path);
      firstOrder ??= order;
      assert.deepEqual(order, firstOrder);
      assert.deepEqual(normalize(bindings.owners(target)), expected);
      for (const observation of observations) {bindings.owners(observation);}
      assert.deepEqual(bindings.owners(target).map((entry) => entry?.path), firstOrder);
      assert.deepEqual(normalize(bindings.owners(target)), expected);
      validateObservations(profile, sourcePolicy, observations, problems, {sources,bindings});
      const sorted = problems.toSorted((a,b) => `${a.code}:${a.message}` < `${b.code}:${b.message}` ? -1 : 1);
      assert.deepEqual(sorted, f.result.problems);
    }
  }
}

export function registerCrossModuleFactoryCases({test, assert, workspaceSurface}) {
  const specs = [...starFactoryCases(feature, factorySource), ...symbolFactoryCases(feature, factorySource)];
  const add = (name, action, options = {}) => specs.push({name,action,...options});
  for (const first of [false,true]) {
    for (const mode of ["value","type","query"]) {
      const erased = 'export type expose=Safe;';
      const runtime = factorySource.replace('{safe}', '{safe,Safe}');
      add(`merged namespace ${first ? "first" : "last"} ${mode} ownership`, "", {
        safe:true, factory:(first ? erased+runtime : runtime+erased)+'export type View=typeof expose;',
        consumer:`import ${mode === "value" ? "" : "type "}{${mode === "query" ? "View" : "expose"}} from "@fixture/other"; export type Selected=${mode === "value" ? "typeof expose" : mode === "type" ? "expose" : "View"};`,
        surface:'export {expose} from "./features/storage/application/factory.js"; export type {View} from "./features/storage/application/factory.js";',
        extra:{[domain]:'export function safe(){return "domain";} export interface Safe {value:string}'},
        expected:[owner(mode === "type" ? domain : factory, mode === "type" ? "domain" : "application")]
      });
    }
  }
  for (const [name, action] of [
    ["temporary write", "expose().execute=read;"],
    ["thrown alias", "try{throw expose();}catch(alias){alias.execute=read;}"],
    ["returned receiver", "expose().change(read);"],
    ["named alias", "const alias=expose(); alias.execute=read;"],
    ["destructuring target", "({value:expose().execute}={value:read});"],
    ["for-of target", "for(expose().execute of [read]){}"]
  ]) {add(name, action);}
  for (const [name, action] of [
    ["no mutation", "expose();"], ["unused result", "const unused=expose();"],
    ["reassigned alias", "let alias=expose(); alias={execute:read};"],
    ["lexically shadowed accessor", "function mutate(expose){expose().execute=read;}"],
    ["local object returned by accessor", "expose().execute=read;"]
  ]) {add(name, action, {safe:true, ...(name === "local object returned by accessor" ? {factory:factorySource.replace("expose(){return api;}", "expose(){return {execute:safe};}")} : {})});}
  add("independent receiver control", "expose().ping();", {safe:true,factory:factorySource.replace("change(value){this.execute=value;}", "ping:safe")});
  for (const safe of [false,true]) {
    add(`side-effect-only consumer ${safe ? "control" : "mutation"}`, "", {
      safe, code:'import "./mutator.js"; import {createApi} from "../application/factory.js";'+exported,
      extra:{[`${feature}/composition/mutator.ts`]:imports+(safe ? "expose();" : "expose().execute=read;")}
    });
    add(`reexport cycle ${safe ? "control" : "mutation"}`, "", {
      safe, code:'import {open as expose,build as createApi} from "../application/relay.js"; import {read} from "../adapters/index.js";'+(safe ? "expose();" : "expose().execute=read;")+exported,
      factory:factorySource+' export {cycle} from "./relay.js";',
      extra:{[`${feature}/application/relay.ts`]:'export {expose as open,createApi as build} from "./factory.js"; export function cycle(){return 1;}'}
    });
  }
  add("default accessor through alias", "", {
    code:'import {open as expose,createApi} from "../application/relay.js"; import {read} from "../adapters/index.js"; expose().execute=read;'+exported,
    factory:factorySource.replace("export function expose()", "export default function expose()"),
    extra:{[`${feature}/application/relay.ts`]:'export {default as open,createApi} from "./factory.js";'}
  });
  add("anonymous default accessor", "", {
    code:'import expose,{createApi} from "../application/factory.js"; import {read} from "../adapters/index.js"; expose().execute=read;'+exported,
    factory:factorySource.replace("export function expose(){return api;}", "export default ()=>api;")
  });
  add("nested imported forwarding accessor", "", {
    code:'import {open as expose,createApi} from "../application/relay.js"; import {read} from "../adapters/index.js"; expose().execute=read;'+exported,
    extra:{[`${feature}/application/relay.ts`]:'import {expose} from "./factory.js"; export function open(){return expose();} export {createApi} from "./factory.js";'}
  });
  add("shared captured invocation", "expose().execute=read;", {
    factory:'import {safe} from "../domain/index.js"; function make(){const api={execute:safe}; function expose(){return api;} function createApi(){return api;} return {expose,createApi};} export const {expose,createApi}=make();'
  });
  add("anonymous default shared invocation", "", {
    code:'import {expose,createApi} from "../application/relay.js"; import {read} from "../adapters/index.js"; expose().execute=read;'+exported,
    factory:'import {safe} from "../domain/index.js"; export default function(){const api={execute:safe}; function expose(){return api;} function createApi(){return api;} return {expose,createApi};}',
    extra:{[`${feature}/application/relay.ts`]:'import make from "./factory.js"; export const {expose,createApi}=make();'}
  });
  add("anonymous default object escape", "", {
    code:'import api from "../application/factory.js"; import {read} from "../adapters/index.js"; api.execute=read; export const execute=api.execute;',
    factory:'import {safe} from "../domain/index.js"; export default {execute:safe};'
  });
  for (const safe of [false,true]) {
    // Module result summaries do not prove allocation separation between calls.
    add(`separate mutable allocations ${safe ? "control" : "conservative boundary"}`, safe ? "expose();" : "expose().execute=read;", {
      safe, factory:'import {safe} from "../domain/index.js"; function make(provided){const api={execute:provided}; function expose(){return api;} function createApi(){return api;} return {expose,createApi};} export const {expose}=make(safe); export const {createApi}=make(safe);'
    });
  }
  add("borrowed caller names remain lexical", "", {
    safe:true,code:'import {borrow,createApi} from "../application/factory.js"; import {read} from "../adapters/index.js"; const api={execute:read}; const expose=borrow(api); expose().execute=read;'+exported,
    factory:factorySource+' export function borrow(api){return ()=>api;}'
  });
  add("nested arrow IIFE diagnostic", "", {
    code:'const create=(()=>()=>({execute:()=>"domain"}))(); function copy(x){} copy(create); export const {execute}=create();'
  });
  add("nested arrow returning block arrow diagnostic", "", {
    code:'const create=(()=>()=>{return {execute:()=>"domain"};})(); export const {execute}=create();'
  });
  add("namespace accessor escape", "", {
    code:'import * as accessors from "../application/factory.js"; import {createApi} from "../application/factory.js"; import {read} from "../adapters/index.js"; accessors.expose().execute=read;'+exported
  });
  add("escaped namespace remains unknown", "", {
    code:'import * as accessors from "../application/factory.js"; function copy(x){} copy(accessors); export const execute=accessors;'
  });
  add("distinct borrowed invocation identities", "", {
    code:'import {make} from "../application/factory.js"; import {safe} from "../domain/index.js"; import {read} from "../adapters/index.js"; const good=make(safe); const bad=make(read); const opaque=make(missing); export const execute={good:good(),bad:bad(),opaque:opaque()};',
    factory:'export function make(provided){function closure(){return {execute:provided};} return closure;}',
    codes:["layer-direction","surface-ownership"],expected:[null,owner(adapter,"adapters"),owner(domain,"domain")]
  });
  for (const [name, source] of [
    ["destructured operation", 'function make(){return {execute:safe};} export const {execute}=make();'],
    ["forwarding operation", 'function make(){return {execute:safe};} const api=make(); export function execute(value){return api.execute(value);}']
  ]) {
    add(`escaped ${name} identity`, "", {safe:true,
      code:'import {execute as operation} from "./operation.js"; function wire(execute){return {execute};} export const {execute}=wire(operation);',
      extra:{[`${feature}/composition/operation.ts`]:'import {safe} from "../domain/index.js";'+source}
    });
  }
  for (const [name, expression] of [["object","{execute:safe}"],["regexp","/x/g"],["class","class Api {}"]]) {
    add(`escaped destructured ${name} remains unknown`, "", {
      code:'import {value} from "../application/factory.js"; function copy(x){} copy(value); export const execute=value'+(name === "class" ? "()" : ".execute")+';',
      factory:'import {safe} from "../domain/index.js"; function make(){return {value:'+expression+'};} export const {value}=make();'
    });
  }
  add("unknown export branch retained", "expose();", {branches:true,expected:[null,owner(domain,"domain")],
    extra:{[`${src}/branch.ts`]:'export {missing as execute} from "./features/storage/application/factory.js";'}
  });
  add("reexport alias cycle stays bounded unknown", "expose().execute=read;", {
    factory:'export {expose,createApi} from "./relay.js";',
    extra:{[`${feature}/application/relay.ts`]:'export {expose,createApi} from "./factory.js";'}
  });
  add("shared projection budget stays unknown", "", {
    code:imports+' const a0=createApi();'+Array.from({length:17},(_,i) => `const a${i+1}={left:a${i},right:a${i}};`).join('')+' export const execute=a17;',
    expected:[null,owner(factory,"application"),owner(domain,"domain")]
  });
  for (const spec of specs) {
    test(`cross-module factory ${spec.name}`, async (t) => {
      const f = await physicalFixture(t, workspaceSurface, spec);
      const expected = spec.expected ?? (spec.safe ? [owner(domain,"domain")] : [null]);
      assert.equal(f.result.outcome, spec.safe ? "passed" : "failed", JSON.stringify(f.result));
      assert.ok(f.result.problems.every(({code}) => (spec.codes ?? ["surface-ownership"]).includes(code)), JSON.stringify(f.result));
      if (!spec.safe) {assert.ok(f.result.problems.length > 0);}
      assertOrders(assert, f, expected);
    });
  }
}
