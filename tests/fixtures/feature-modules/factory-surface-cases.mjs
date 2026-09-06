const factoryPath = "packages/other/src/features/storage/adapters/factory.ts";
const applicationFactoryPath = "packages/other/src/features/storage/application/factory.ts";
const adapterFactory = "export function createApi() { function execute(value: string) { return value.length; } return { execute }; }";
const importFactory = 'import {createApi} from "./features/storage/adapters/factory.js";';

export function registerFactorySurfaceCases({ test, assert, workspaceSurface, rejects, expectPass }) {
  async function prepared(t, { role = "adapters", surface, factory = adapterFactory, owner = "adapters", consumer = 'export {execute} from "@fixture/other";' } = {}) {
    const f = await workspaceSurface(t, consumer, surface ?? `${importFactory} export const {execute} = createApi();`);
    f.profile.modules[0].features[0].layers[0].role = role;
    const path = owner === "application" ? applicationFactoryPath : factoryPath;
    f.sourcePolicy.boundaries.find(({ id }) => id === `other-${owner}`).entrypoints.push(path);
    await f.write(path, factory);
    return f;
  }

  for (const [label, surface] of [
    ["direct destructuring", `${importFactory} export const {execute} = createApi();`],
    ["renamed destructuring", `${importFactory} const {execute: run} = createApi(); export {run as execute};`],
    ["projected result member", `${importFactory} const api = createApi(); export const execute = api.execute;`],
    ["transparent wrapper", `${importFactory} const api = createApi(); export function execute(value: string) { return api.execute(value); }`],
    ["transparent awaited wrapper", `${importFactory} const api = createApi(); export async function execute(value: string) { return await api.execute(value); }`]
  ]) {
    test(`factory surface accepts owned adapter ${label}`, async (t) => {
      await expectPass(await prepared(t, { surface }));
    });
    test(`factory surface rejects application consumption through ${label}`, async (t) => {
      const f = await prepared(t, { surface, role: "application" });
      const result = await f.check();
      assert.ok(result.problems.some(({ code, message }) => code === "layer-direction" && message.includes(factoryPath)), JSON.stringify(result));
      assert.ok(!result.problems.some(({ code }) => code === "surface-ownership"), JSON.stringify(result));
    });
  }

  for (const [label, wrapper] of [
    ["exact rest forwarding", "export function execute(first: string, ...rest: readonly string[]) { return api.execute(first, ...rest); }"],
    ["exact rest awaited forwarding", "export async function execute(first: string, ...rest: readonly string[]) { return await api.execute(first, ...rest); }"],
    ["explicit synchronous void forwarding", "export function execute(value: string): void { api.execute(value); }"],
    ["explicit zero-argument void forwarding", "export function execute(): void { api.execute(); }"]
  ]) {
    for (const role of ["adapters", "application"]) {
      test(`factory surface ${role} consumer of ${label}`, async (t) => {
        const f = await prepared(t, { role, surface: `${importFactory} const api = createApi(); ${wrapper}` });
        if (role === "adapters") { await expectPass(f); }
        else {
          const result = await f.check();
          assert.ok(result.problems.some(({ code, message }) => code === "layer-direction" && message.includes(factoryPath)), JSON.stringify(result));
          assert.ok(!result.problems.some(({ code }) => code === "surface-ownership"), JSON.stringify(result));
        }
      });
    }
  }
  for (const [label, wrapper] of [
    ["rest passed as one argument", "export function execute(...args: string[]) { return api.execute(args); }"],
    ["rest replaced by another spread", "export function execute(...args: string[]) { return api.execute(...[]); }"],
    ["rest duplicated", "export function execute(...args: string[]) { return api.execute(...args, ...args); }"],
    ["rest wrapper default argument", "export function execute(first = \"changed\", ...args: string[]) { return api.execute(first, ...args); }"],
    ["void wrapper changes argument", "export function execute(value: string): void { api.execute(value + \"!\"); }"],
    ["void wrapper calls different member", "export function execute(value: string): void { api.other(value); }"],
    ["void wrapper adds side effect", "export function execute(value: string): void { api.execute(value); console.log(value); }"],
    ["async void wrapper loses completion", "export async function execute(value: string): Promise<void> { api.execute(value); }"],
    ["untyped wrapper discards return", "export function execute(value: string) { api.execute(value); }"]
  ]) {
    test(`factory surface keeps assembly rejection for ${label}`, async (t) => {
      await rejects(await prepared(t, { surface: `${importFactory} const api = createApi(); ${wrapper}` }), "assembly-behavior");
    });
  }

  const importedAdapter = 'import {read} from "./features/storage/adapters/index.js";';
  const factoryImport = 'import {createApi} from "./features/storage/application/factory.js";';
  test("factory surface preserves an injected adapter instead of the application factory owner", async (t) => {
    const f = await prepared(t, { role: "application", owner: "application", factory: "export function createApi(provided: (value: string) => unknown) { return {execute: provided}; }", surface: `${importedAdapter} ${factoryImport} export const {execute} = createApi(read);` });
    await rejects(f, "layer-direction");
    assert.ok(!(await f.check()).problems.some(({ code }) => code === "surface-ownership"));
  });
  test("factory surface selects a local operation independently of another injected member", async (t) => {
    const f = await prepared(t, { role: "application", owner: "application", factory: "export function createApi(provided: (value: string) => unknown) { function execute(value: string) { return value.length; } return {execute, injected: provided}; }", surface: `${importedAdapter} ${factoryImport} export const {execute, injected} = createApi(read);` });
    await expectPass(f);
    await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`, 'import * as api from "@fixture/other"; export const execute = api;');
    await rejects(f, "layer-direction");
  });
  test("factory surface preserves a parameter shadow over an imported safe binding", async (t) => {
    const f = await prepared(t, { role: "application", owner: "application", factory: 'import {compare as provided} from "../domain/index.js"; export function createApi(provided: (value: string) => unknown) { return {execute: provided}; }', surface: `${importedAdapter} ${factoryImport} export const {execute} = createApi(read);` });
    f.sourcePolicy.boundaries.find(({ id }) => id === "other-application").allow.boundaries.push("other-domain");
    await rejects(f, "layer-direction");
    assert.ok(!(await f.check()).problems.some(({ code }) => code === "surface-ownership"));
  });
  test("factory surface preserves default-export ownership", async (t) => {
    const f = await prepared(t, { surface: `${importFactory} const {execute} = createApi(); export {execute as default};`, consumer: 'import execute from "@fixture/other"; export {execute};' });
    await expectPass(f);
  });
  test("factory surface includes every member of a named object import", async (t) => {
    const f = await prepared(t, { role: "application", owner: "application", factory: "export function createApi(provided: (value: string) => unknown) { function safe(value: string) { return value.length; } return {safe, injected: provided}; }", surface: `${importedAdapter} ${factoryImport} export const execute = createApi(read);` });
    await rejects(f, "layer-direction");
  });
  test("factory surface distinguishes repeated calls with different supplied owners", async (t) => {
    const f = await prepared(t, { role: "application", owner: "application", factory: "export function createApi(provided: unknown) { return {execute: provided}; }", surface: `${importedAdapter} ${factoryImport} import {compare} from "./features/storage/domain/index.js"; const {execute: safe} = createApi(compare); const {execute: unsafe} = createApi(read); export {safe, unsafe};`, consumer: 'export {safe as execute} from "@fixture/other";' });
    await expectPass(f);
    await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`, 'export {unsafe as execute} from "@fixture/other";');
    await rejects(f, "layer-direction");
  });
  test("factory surface resolves local implementations without evaluating constructor arguments", async (t) => {
    const f = await prepared(t, { factory: "export function createApi(dependencies: {token: unknown}) { function execute() { return dependencies.token; } return {execute}; }", surface: `${importFactory} import {Token} from "./features/storage/adapters/token.js"; export const {execute} = createApi({token: new Token()});` });
    const path = "packages/other/src/features/storage/adapters/token.ts";
    f.sourcePolicy.boundaries.find(({ id }) => id === "other-adapters").entrypoints.push(path);
    await f.write(path, "export class Token {}");
    await expectPass(f);
  });
  test("factory surface rejects normalized duplicate numeric return keys", async (t) => {
    const f = await prepared(t, { factory: 'export function createApi() { function execute() { return 1; } return {1: execute, "1": execute}; }', surface: `${importFactory} export const {1: execute} = createApi();` });
    await rejects(f, "surface-ownership");
  });
  test("factory surface rejects a spread argument even for a locally owned method", async (t) => {
    const f = await prepared(t, { factory: "export function createApi(input: unknown) { function execute() { return input; } return {execute}; }", surface: `${importFactory} import {read} from "./features/storage/adapters/index.js"; const args = [read]; export const {execute} = createApi(...args);` });
    await rejects(f, "surface-ownership");
  });
  for (const [label, selected] of [
    ["computed returned member", 'provided["method"]'],
    ["optional returned member", "provided?.method"],
    ["reflective returned member", 'Object.getOwnPropertyDescriptor(provided, "method")?.value']
  ]) {
    test(`factory surface fails closed for ${label} instead of attributing it to the application factory`, async (t) => {
      const f = await prepared(t, { role: "application", owner: "application", factory: `export function createApi(provided: {method: (value: string) => unknown}) { return {execute: ${selected}}; }`, surface: `${importedAdapter} ${factoryImport} export const {execute} = createApi({method: read});` });
      await rejects(f, "surface-ownership");
    });
  }
  for (const [label, factory] of [
    ["async factory", "export async function createApi() { function execute() { return 1; } return {execute}; }"],
    ["generator factory", "export function* createApi() { function execute() { return 1; } return {execute}; }"],
    ["prototype setter", "export function createApi() { function execute() { return 1; } return {__proto__: {hidden: execute}, execute}; }"],
    ["captured object write", "export function createApi() { const api = {execute: () => 1, change: () => {api.execute = () => 2;}}; return api; }"],
    ["captured alias write", "export function createApi() { const api = {execute: () => 1}; const alias = api; function change() { alias.execute = () => 2; } return api; }"],
    ["captured typed alias write", "export function createApi() { const api = {execute: () => 1}; const alias = api as typeof api; function change() { alias.execute = () => 2; } return api; }"],
    ["captured destructured target write", "export function createApi() { const api = {execute: () => 1}; function change() { ({execute: api.execute} = {execute: () => 2}); } return api; }"],
    ["captured delete", "export function createApi() { const api = {execute: () => 1}; function change() { delete api.execute; } return api; }"],
    ["captured reflective write", 'export function createApi() { const api = {execute: () => 1}; function change() { Reflect.set(api, "execute", () => 2); } return api; }'],
    ["block shadow followed by real captured write", "export function createApi() { const api = {execute: () => 1}; function change() { {const api = {execute: () => 3}; api.execute();} api.execute = () => 2; } return api; }"],
    ["type-only factory declaration", "function createApi() { function execute() { return 1; } return {execute}; } export type {createApi};"],
    ["cyclic local aliases", "export function createApi() { const first = second; const second = first; return {execute: first}; }"]
  ]) {
    test(`factory surface rejects unstable or non-runtime ${label}`, async (t) => {
      await rejects(await prepared(t, { factory }), "surface-ownership");
    });
  }
  for (const [label, factory] of [
    ["unrelated captured state", "export function createApi() { const state = {count: 0}; function execute() { return ++state.count; } return {execute}; }"],
    ["inner parameter shadow", "export function createApi() { const api = {execute: () => 1}; function change(api: {execute: () => number}) { api.execute = () => 2; } return api; }"],
    ["inner block shadow", "export function createApi() { const api = {execute: () => 1}; function change() { {const api = {execute: () => 3}; api.execute = () => 2;} } return api; }"],
    ["inner loop shadow", "export function createApi() { const api = {execute: () => 1}; function change() { for (const api of [{execute: () => 3}]) { api.execute = () => 2; } } return api; }"]
  ]) {
    test(`factory surface retains stable ownership with ${label}`, async (t) => {
      await expectPass(await prepared(t, { factory }));
    });
  }
  for (const [label, factory] of [
    ["missing returned member", "export function createApi() { function other() { return 1; } return {other}; }"],
    ["computed returned key", "export function createApi() { function execute() { return 1; } return {[\"execute\"]: execute}; }"],
    ["spread returned object", "export function createApi() { function execute() { return 1; } return {...{execute}}; }"],
    ["returned getter", "export function createApi() { return {get execute() { return () => 1; }}; }"],
    ["duplicate returned key", "export function createApi() { function execute() { return 1; } return {execute, execute}; }"],
    ["conditional return", "export function createApi() { function execute() { return 1; } if (Date.now()) { return {execute}; } return {}; }"],
    ["reassigned local operation", "export function createApi() { let execute = () => 1; execute = () => 2; return {execute}; }"],
    ["mutated object member", "export function createApi() { const api = {execute: () => 1}; api.execute = () => 2; return api; }"],
    ["recursive result", "export function createApi() { return createApi(); }"]
  ]) {
    test(`factory surface fails closed for ${label}`, async (t) => {
      const f = await prepared(t, { factory });
      await rejects(f, "surface-ownership");
    });
  }
  for (const [label, surface] of [
    ["default destructuring", `${importFactory} export const {execute = () => 1} = createApi();`],
    ["rest destructuring", `${importFactory} const {...api} = createApi(); export const execute = api.execute;`],
    ["computed destructuring", `${importFactory} export const {["execute"]: execute} = createApi();`],
    ["rewritten wrapper input", `${importFactory} const api = createApi(); export function execute(value: string) { return api.execute(value + "!"); }`],
    ["wrapper effect before delegation", `${importFactory} const api = createApi(); export function execute(value: string) { console.log(value); return api.execute(value); }`]
  ]) {
    test(`factory surface keeps the assembly gate for ${label}`, async (t) => {
      await rejects(await prepared(t, { surface }), "assembly-behavior");
    });
  }
}
