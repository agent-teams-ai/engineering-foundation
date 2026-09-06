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

 specs.push(...directQueryCases(feature), ...queryScopeCases(feature));
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
