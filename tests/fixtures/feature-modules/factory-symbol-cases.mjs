// Symbol namespace and emitted availability are independent fixture oracles.
export function symbolFactoryCases(feature, factorySource) {
 const src=feature.split('/features/')[0], domain=feature+'/domain/index.ts', adapter=feature+'/adapters/index.ts';
 const wiring=feature+'/composition/api.ts', consumer='consumer', relay=feature+'/composition/relay.ts';
 const exported='export const {execute}=createApi();', specs=[];
for(const first of [false,true]){for(const mode of ['value','type','local-query','import-type','import-specifier','import-value','inline-type','inline-typeof','default-query']){
 const erased='export type expose=Safe;';
 const runtime='export function expose(){return "adapter";}';
 const extra={[domain]:'export function safe(){return "domain";} export interface Safe{value:string}',[adapter]:'import type {Safe} from "../domain/index.js";'+(first?erased+runtime:runtime+erased)+'export type LocalQuery=typeof expose; export function read(){return "adapter";}'};
 const expectType=['type','inline-type'].includes(mode);
 extra[`${src}/index.ts`]='export {expose} from "./features/storage/adapters/index.js";';
 if(mode==='value'){extra[consumer]='import {expose} from "@fixture/other"; export {expose as execute};';}
 else if(mode==='type'){extra[consumer]='import type {expose} from "@fixture/other"; export type Q=expose; export function execute(){return "domain";}';}
 else if(mode==='inline-type'){extra[consumer]='export type Q=import("@fixture/other").expose; export const record:Q={value:"domain"}; export function execute(){return "domain";}';}
 else if(mode==='inline-typeof'){extra[consumer]='export type Q=typeof import("@fixture/other").expose; export const execute:Q=()=>"adapter";';}
 else if(mode==='local-query'){
  extra[`${src}/index.ts`]='export type {LocalQuery} from "./features/storage/adapters/index.js";';
  extra[consumer]='import type {LocalQuery} from "@fixture/other"; export const execute:LocalQuery=()=>"adapter";';
 }else{
  const imported=mode==='default-query'?'import type F from "../adapters/index.js";':`import ${mode==='import-type'?'type ':''}{${mode==='import-specifier'?'type ':''}expose as F} from "../adapters/index.js";`;
  if(mode==='default-query'){extra[adapter]+='export {expose as default};';}
  extra[wiring]=imported+'export type View=typeof F; export const marker=0;';
  extra[`${src}/index.ts`]='export type {View} from "./features/storage/composition/api.js";';
  extra[consumer]='import type {View} from "@fixture/other"; export const execute:View=()=>"adapter";';
 }
 const consumerSource=extra[consumer]; delete extra[consumer];
 specs.push({name:`symbol query ${mode} ${first}`,extra,
    code:extra[wiring] ?? 'export const marker=0;', surface:extra[`${src}/index.ts`], consumer:consumerSource,
    boundaryEdges:[["other-adapters","other-domain"]], safe:expectType, codes:['layer-direction'],expected:[{path:expectType?domain:adapter,role:expectType?'domain':'adapters'}]});
 }}
for(const first of [false,true]){for(const safe of [false,true]){for(const kind of ['local-interface','type-import','explicit-type']){
 const declaration=kind==='type-import'?'import type {Safe as expose} from "../domain/index.js";':'interface expose{value:string}';
 const erased=declaration+` export ${kind==='explicit-type'?'type ':''}{expose};`;
 const runtime='export * from "../application/factory.js";';
 specs.push({name:`erased-star-${kind}-${first}-${safe}`,internal:[relay],safe,factory:factorySource.replace('export function createApi','export default function createApi'),extra:{[relay]:first?erased+runtime:runtime+erased,[domain]:'export function safe(){return "domain";} export interface Safe{value:string}',[adapter]:'export function read(){return "adapter";} export function mutate(value:any){value.expose().execute=read;}'},code:'import * as ns from "./relay.js"; import createApi from "../application/factory.js"; import {mutate} from "../adapters/index.js";'+(safe?'':'mutate(ns);')+exported});
 }}}

 {
 const symbolRelay=feature+"/composition/independent-relay.ts";
const leaf = feature + '/composition/independent-leaf.ts';
const innocent = feature + '/composition/independent-innocent.ts';

function spec({route, first = false, safe = false, kind = 'implicit-interface'}) {
  const shadow = kind === 'runtime-shadow';
  const erased = 'interface expose {value:string}';
  const explicit = kind === 'explicit-type' ? 'export type {expose};' : 'export {expose};';
  const localRuntime = shadow ? 'function expose(){return {execute:()=>"unrelated"};}' : '';
  const symbol = erased + localRuntime + explicit;
  const namespaceStar = 'export * from "./independent-innocent.js";';
  const alias = route === 'import'
    ? 'import {expose as picked} from "./independent-leaf.js"; export {picked as expose};'
    : 'export {expose} from "./independent-leaf.js";';
  return {
    name: `independent-runtime-symbol-${kind}-${route}-${first}-${safe}`,
    internal: [symbolRelay, leaf, innocent],
    factory: factorySource.replace('export function createApi', 'export default function createApi'),
    code: 'import * as ns from "./independent-relay.js"; import createApi from "../application/factory.js"; import {mutate} from "../adapters/index.js";' +
      (safe ? '' : 'mutate(ns);') + exported,
    extra: {
      [symbolRelay]: alias + 'export * from "../application/factory.js";',
      [leaf]: first ? symbol + namespaceStar : namespaceStar + symbol,
      [innocent]: 'export function expose(){return {execute:()=>"unrelated"};}',
      [adapter]: 'export function read(){return "adapter";} export function mutate(value:any){value.expose().execute=read;}'
    },
    safe: safe || shadow,

  };
}
for (const first of [false, true]) {
  for (const safe of [false, true]) {
    for (const route of ['import', 'reexport']) {specs.push(spec({route, first, safe}));}
  }
}
for (const route of ['import', 'reexport']) {
  specs.push(spec({route, kind: 'explicit-type'}));
  specs.push(spec({route, kind: 'runtime-shadow'}));
}

for (const kind of ['default-interface-expression', 'default-import-type-expression']) {
  for (const safe of [false, true]) {
    const current = spec({route: 'reexport', safe});
    current.name = `independent-runtime-symbol-${kind}-${safe}`;
    current.extra[symbolRelay] = 'export {default as expose} from "./independent-leaf.js"; export * from "../application/factory.js";';
    current.extra[leaf] = (kind === 'default-interface-expression'
      ? 'interface Erased {value:string}'
      : 'import type {Safe as Erased} from "../domain/index.js";') + 'export default Erased;';
    current.extra[domain] = 'export function safe(){return "domain";} export interface Safe {value:string}';
    specs.push(current);
  }
}

 }

 specs.push(...directQueryCases(feature), ...queryScopeCases(feature), ...lexicalErasureCases(feature, factorySource));
 return specs;
}

function directQueryCases(feature) {
 const domain=feature+'/domain/index.ts', adapter=feature+'/adapters/index.ts', specs=[];
 for (const first of [false, true]) {
  for (const mode of ['import-type', 'import-specifier', 'default-type', 'ordinary-type', 'mixed']) {
   const erased='export type expose=Safe;', value='export function expose(){return "adapter";}';
   const imported=mode==='default-type' ? 'import type F from "@fixture/other";'
    : mode==='import-specifier' ? 'import {type expose as F} from "@fixture/other";' : 'import type {expose as F} from "@fixture/other";';
   const query=mode==='ordinary-type' ? '' : 'export type View=typeof F;';
   const typeUse=['ordinary-type','mixed'].includes(mode) ? 'export type Data=F; export const record:Data={value:"domain"};' : '';
   const safe=mode==='ordinary-type', domainOwner={path:domain,role:'domain'}, adapterOwner={path:adapter,role:'adapters'};
   specs.push({name:`direct symbol query ${mode} ${first}`, safe, codes:['layer-direction'],
    expected:safe ? [domainOwner] : mode==='mixed' ? [adapterOwner,domainOwner] : [adapterOwner],
    boundaryEdges:[["other-adapters","other-domain"]], code:'export const marker=0;',
    surface:'export {expose,expose as default} from "./features/storage/adapters/index.js";',
    consumer:imported+query+typeUse+(safe ? 'export function execute(){return "domain";}' : 'export const execute:View=()=>"adapter";'),
    extra:{[domain]:'export function safe(){return "domain";} export interface Safe {value:string}',
     [adapter]:'import type {Safe} from "../domain/index.js";'+(first ? erased+value : value+erased)+'export function read(){return "adapter";}'}});
  }
 }
 return specs;
}

function queryScopeCases(feature) {
 const domain=feature+'/domain/index.ts', adapter=feature+'/adapters/index.ts';
const cases = [
  ['parameter-shadow', 'function inspect(F:()=>"local"){type View=typeof F;}', false],
  ['destructured-parameter-shadow', 'function inspect({F}:{F:()=>"local"}){type View=typeof F;}', false],
  ['body-hoisted-var-shadow', 'function inspect(){type View=typeof F; if(false){var F=()=>"local" as const;}}', false],
  ['default-parameter-before-body-var', 'function inspect(value:typeof F=()=>"adapter"){var F=()=>"local" as const;}', true],
  ['return-type-before-body-var', 'function inspect():typeof F{var F=()=>"local" as const; return()=>"adapter";}', true],
  ['block-let-shadow', '{let F=()=>"local" as const; type View=typeof F;}', false],
  ['block-let-no-leak', '{let F=()=>"local" as const;} type View=typeof F;', true],
  ['static-var-no-leak', 'class Local{static{var F=()=>"local" as const;}} type View=typeof F;', true],
  ['namespace-var-no-leak', 'namespace Local{export function marker(){return 1;} var F=()=>"local" as const;} type View=typeof F;', true],
  ['nested-function-var-no-leak', 'function nested(){var F=()=>"local" as const;} type View=typeof F;', true],
  ['catch-shadow', 'try{throw()=>"local";}catch(F){type View=typeof F;}', false],
  ['named-function-expression-shadow', 'const inspect=function F(){type View=typeof F;};', false],
  ['function-type-parameter-shadow', 'type Signature=(F:()=>"local")=>typeof F;', false],
  ['constructor-type-parameter-shadow', 'type Signature=new (F:()=>"local")=>typeof F;', false],
  ['declare-function-parameter-shadow', 'declare function inspect(F:()=>"local"):typeof F;', false],
  ['interface-method-parameter-shadow', 'interface Signature{method(F:()=>"local"):typeof F}', false],
  ['interface-call-parameter-shadow', 'interface Signature{(F:()=>"local"):typeof F}', false],
  ['constructor-parameter-property-shadow', 'class Local{constructor(private F:()=>"local"){type View=typeof F;}}', false],
  ['switch-discriminant-before-case-binding', 'switch(null as unknown as typeof F){default:let F=()=>"local" as const;break;}', true],
  ['switch-case-shadow', 'switch(0){default:let F=()=>"local" as const;type View=typeof F;break;}', false],
  ['erased-local-does-not-hide-value', '{interface F{value:string} type View=typeof F;}', true],
  ['mixed-interface-heritage', 'interface Data extends F{} type View=typeof F;', true, true],
  ['mixed-class-implements', 'class Data implements F{value="domain";} type View=typeof F;', true, true]
];
 return cases.map(([name, body, queried, mixed]) => ({name:`symbol query scope ${name}`, safe:!queried, codes:['layer-direction'],
  expected:mixed ? [{path:adapter,role:'adapters'},{path:domain,role:'domain'}] : [{path:queried ? adapter : domain,role:queried ? 'adapters' : 'domain'}],
  boundaryEdges:[["other-adapters","other-domain"]],code:'export const marker=0;',
  surface:'export {expose} from "./features/storage/adapters/index.js";',
  consumer:'import type {expose as F} from "@fixture/other";'+body+'export function execute(){return "domain";}',
  extra:{[domain]:'export function safe(){return "domain";} export interface Safe {value:string}',
   [adapter]:'import type {Safe} from "../domain/index.js";export type expose=Safe;export function expose():"adapter"{return "adapter";}export function read(){return "adapter";}'}}));
}

// F1-F4 closure: compiler-qualified source pairs, exercised through the complete
// validator and all four source/observation orders by the cross-module harness.
export function lexicalErasureCases(feature, factorySource) {
 const domain=feature+'/domain/index.ts', adapter=feature+'/adapters/index.ts', specs=[];
 function query(name, body, queried, inverse=false, mixed=false) {
  const role=queried?'adapters':'domain';
  specs.push({name:`lexical erasure ${name}`,safe:!queried,codes:['layer-direction'],
   expected:mixed?[{path:adapter,role:'adapters'},{path:domain,role:'domain'}]:[{path:queried?adapter:domain,role}],
   boundaryEdges:[['other-adapters','other-domain']],code:'export const marker=0;',
   surface:'export {expose} from "./features/storage/adapters/index.js";',
   consumer:'import type {expose as F} from "@fixture/other";'+body+'export function execute(){return "domain";}',
   extra:{[domain]:'export function safe(){return "domain";} export interface Safe {value:string}',
    [adapter]:inverse?'export {safe as expose} from "../domain/index.js"; export interface expose {value:string} export function read(){return "adapter";}'
     :'import type {Safe} from "../domain/index.js"; export type expose=Safe; export function expose():"adapter"{return "adapter";} export function read(){return "adapter";}'}});
 }
 for(const emitted of [false,true]) {
  query(`namespace value ${emitted}`,'namespace Scope {namespace F {'+(emitted?'export const data=1;':'export interface Data {value:string}')+'} type View=typeof F; '+(emitted?'const value:View=F;':'const value:View=()=>"adapter";')+'}',!emitted);
 }
 query('import equals value','namespace Source {export function local(){return "local" as const;}} namespace Scope {import F=Source.local; type View=typeof F; const value:View=()=>"local";}',false);
 query('import equals namespace alias chain','namespace Source {export function local(){return "local" as const;}} namespace Scope {import S=Source; import T=S; import F=T.local; type View=typeof F; const value:View=()=>"local";}',false);
 query('import equals erased alias chain','namespace Source {export namespace Erased {export interface Data {value:string}}} namespace Scope {import S=Source; import T=S; import F=T.Erased; type View=typeof F; const value:View=()=>"adapter";}',true);
 query('import equals private no leak','namespace Source {export function local(){return "local" as const;}} namespace Scope {import F=Source.local; export const marker=0;} namespace Scope {type View=typeof F; const value:View=()=>"adapter";}',true);
 for(const first of [false,true]) {
  for(const exported of [false,true]) {
   const declaration='namespace Scope {'+(exported?'export ':'')+'const F=()=>"local" as const; export const marker=0;}', use='namespace Scope {type View=typeof F; const value:View=()=>"'+(exported?'local':'adapter')+'";}';
   query(`reopened ${exported} ${first}`,first?declaration+use:use+declaration,!exported);
  }
 }
 for(const exported of [false,true]) {
  query(`nested reopened ${exported}`,'namespace Root {'+(exported?'export ':'')+'namespace Scope {export const F=()=>"local" as const;}} namespace Root {'+(exported?'export ':'')+'namespace Scope {type View=typeof F; const value:View=()=>"'+(exported?'local':'adapter')+'";}}',!exported);
 }
 query('dotted reopened','namespace Root.Scope {export const F=()=>"local" as const;} namespace Root {export namespace Scope {type View=typeof F; const value:View=()=>"local";}}',false);
 query('reopened exported alias','namespace Source {export function local(){return "local" as const;}} namespace Scope {export import F=Source.local;} namespace Scope {type View=typeof F; const value:View=()=>"local";}',false);
 const value='type View=typeof F; const value:View=()=>"domain";';
 query('inverse query control',value,false,true);
 for(const [name,body] of [
  ['generic function','function identity<F>(value:F):F{return value;}'],
  ['generic type alias','type Identity<F>={value:F};'],
  ['generic interface','interface Identity<F>{value:F}'],
  ['generic class','class Identity<F>{value?:F;}'],
  ['generic method','class Identity {identity<F>(value:F):F{return value;}}'],
  ['block interface','{interface F {local:string} const value:F={local:"yes"};}'],
  ['block type alias','{type F=string; const value:F="local";}'],
  ['mapped parameter','type Identity<T>={[F in keyof T]:F};'],
  ['infer parameter','type Identity<T>=T extends infer F?F:never;'],
  ['reopened type export','namespace Scope {export interface F{local:string}} namespace Scope {const value:F={local:"yes"};}']
 ]) {query(name,value+body,false,true);}
 query('type shadow no leak',value+'{interface F {local:string} const value:F={local:"yes"};} const external:F={value:"adapter"};',true,true,true);
 query('generic shadow no leak',value+'function identity<F>(value:F):F{return value;} const external:F={value:"adapter"};',true,true,true);
 query('reopened private type no leak',value+'namespace Scope {interface F{local:string} export const marker=0;} namespace Scope {const external:F={value:"adapter"};}',true,true,true);
 query('type parameter does not hide value','function identity<F>(value:F):F {type View=typeof F; const fn:View=()=>"adapter"; return value;}',true);
 query('namespace cannot hide simple type',value+'namespace Scope {namespace F {export const data=1} const external:F={value:"adapter"};}',true,true,true);
 query('erased namespace cannot hide simple type',value+'namespace Scope {namespace F {export interface Data {value:string}} const external:F={value:"adapter"};}',true,true,true);
 query('import equals erased namespace','namespace Source {export namespace Erased {export interface Data {value:string}}} namespace Scope {import F=Source.Erased; type View=typeof F; const value:View=()=>"adapter";}',true);
 query('import equals interface','namespace Source {export interface Data {value:string}} namespace Scope {import F=Source.Data; type View=typeof F; const value:View=()=>"adapter";}',true);
 query('import equals function cannot hide type',value+'namespace Source {export function local(){}} namespace Scope {import F=Source.local; const external:F={value:"adapter"};}',true,true,true);
 query('import equals class value','namespace Source {export class Local {value="local";}} namespace Scope {import F=Source.Local; type View=typeof F; const value:View=Source.Local;}',false);
 query('import equals class type',value+'namespace Source {export class Local {local="local";}} namespace Scope {import F=Source.Local; const value:F={local:"yes"};}',false,true);
 query('mapped constraint outside key scope',value+'type Identity={[F in keyof F]:F};',true,true,true);
 query('infer false branch no leak',value+'type Identity<T>=T extends infer F?F:F;',true,true,true);
 query('nested infer no leak',value+'type Identity<T>=T extends (T extends infer F?F:never)?F:never;',true,true,true);
 const relay=feature+'/composition/lexical-relay.ts', leaf=feature+'/composition/lexical-leaf.ts';
 for(const kind of ['namespace','const-enum','runtime-namespace','runtime-enum']) {
  for(const route of ['local','import','reexport']) {
   for(const safe of [false,true]) {
    const emitted=kind.startsWith('runtime'), declaration=kind.includes('namespace')
     ?'namespace expose {'+(emitted?'export const data=1;':'export interface Data {value:string}')+'}'
     :(emitted?'':'const ')+'enum expose {value=1}';
    const symbol=declaration+'export {expose};';
    const edge=route==='local'?symbol:route==='import'?'import {expose as Alias} from "./lexical-leaf.js"; export {Alias as expose};':'export {expose} from "./lexical-leaf.js";';
    specs.push({name:`lexical erasure star ${kind} ${route} ${safe}`,safe:safe||emitted,internal:[relay,leaf],
     factory:factorySource.replace('export function createApi','export default function createApi'),
     code:'import * as ns from "./lexical-relay.js"; import createApi from "../application/factory.js"; import {mutate} from "../adapters/index.js";'+(safe?'':'mutate(ns);')+'export const {execute}=createApi();',
     extra:{[relay]:edge+'export * from "../application/factory.js";',[leaf]:symbol,
      [adapter]:'export function read(){return "adapter";} export function mutate(ns:any){if(typeof ns.expose==="function"){ns.expose().execute=read;}}'}});
   }
  }
 }
 for(const [name,declaration,safe=true] of [
  ['ambient member variable','namespace expose {export declare const data:number;}'],
  ['ambient member function','namespace expose {export declare function data():void;}'],
  ['nested-const-enum','namespace expose {export const enum Data {value=1}}',false],
  ['nested-erased-namespace','namespace expose {export namespace Data {export interface Value {value:string}}}',false],
  ['reopened-first','namespace expose {export const data=1;} namespace expose {export interface Data {value:string}}'],
  ['reopened-last','namespace expose {export interface Data {value:string}} namespace expose {export const data=1;}'],
  ['exported-value-alias','namespace Source {export function local(){}} namespace expose {export import data=Source.local;}'],
  ['exported-erased-alias','namespace Source {export interface Local {value:string}} namespace expose {export import data=Source.Local;}']
 ]) {
  specs.push({name:`lexical erasure star ${name}`,safe,internal:[relay],
   factory:factorySource.replace('export function createApi','export default function createApi'),
   code:'import * as ns from "./lexical-relay.js"; import createApi from "../application/factory.js"; import {mutate} from "../adapters/index.js"; mutate(ns); export const {execute}=createApi();',
   extra:{[relay]:declaration+'export {expose}; export * from "../application/factory.js";',
    [adapter]:'export function read(){return "adapter";} export function mutate(ns:any){if(typeof ns.expose==="function"){ns.expose().execute=read;}}'}});
 }
 return specs;
}
