// Expectations describe runtime capture identity, independently of the guard.
export function starFactoryCases(feature) {
  const relay = `${feature}/composition/relay.ts`, second = `${feature}/composition/second.ts`;
  const factory = 'export * from "../application/factory.js";';
  const imports = 'import {expose} from "./relay.js"; import {createApi} from "../application/factory.js"; import {read} from "../adapters/index.js";';
  const exported = 'export const {execute}=createApi();';
  const specs = [];
  const add = (name, source, options = {}) => specs.push({name:`internal star ${name}`, internal:[relay,second],
    code:imports + (options.safe ? 'expose();' : 'expose().execute=read;') + exported,
    extra:{[relay]:source}, ...options});
  for (const safe of [false,true]) {
    const label = safe ? "control" : "mutation";
    add(label, factory, {safe});
    add(`chain ${label}`, '', {safe,extra:{[relay]:'export * from "./second.js";', [second]:factory}});
    add(`cycle ${label}`, '', {safe,extra:{[relay]:factory+'export * from "./second.js";', [second]:'export * from "./relay.js";'}});
    add(`unrelated erased name ${label}`, 'export type Marker=string;'+factory, {safe});
    add(`erased same name ${label}`, 'export type {expose} from "../application/factory.js";'+factory, {safe});
  }
  // These calls mutate another local object, never the factory's shared api.
  for (const prefix of ['', 'export type * from "../application/factory.js";']) {
    specs.push({name:`internal star explicit shadow ${prefix ? "erased edge" : "runtime edge"}`,safe:true,internal:[relay],
      code:imports+'expose().execute=read;'+exported,
      extra:{[relay]:prefix+'export function expose(){return {};}' + (prefix ? '' : factory)}});
  }
  for (const [name, source, extra] of [
    ["excludes default", 'export * from "./second.js";', {[second]:'export {expose as default} from "../application/factory.js";'}],
    ["erased wildcard", 'export type * from "../application/factory.js";', {}],
    ["erased namespace", 'export type * as api from "../application/factory.js";', {}],
    ["erased named", 'export type {expose} from "../application/factory.js";', {}]
  ]) {
    specs.push({name:`internal star ${name}`,safe:true,internal:[relay,second],
      code:'import * as relay from "./relay.js"; import {createApi} from "../application/factory.js"; function escape(value){} escape(relay);'+exported,
      extra:{[relay]:source,...extra}});
  }
  add("namespace with erased name", '', {
    code:'import * as relay from "./relay.js"; import {createApi} from "../application/factory.js"; import {read} from "../adapters/index.js"; relay.expose().execute=read;'+exported,
    extra:{[relay]:'export type Marker=string;'+factory}
  });
  for (const reverse of [false,true]) {
    const edges = [factory, 'export * from "./second.js";'];
    add(`ambiguous candidates ${reverse}`, '', {extra:{[relay]:(reverse ? edges.toReversed() : edges).join(''),
      [second]:'export function expose(){return {};}'} });
  }
  return specs;
}
