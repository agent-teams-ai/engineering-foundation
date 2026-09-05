import test from "node:test";

const imported = 'import { Runner } from "./features/alpha/application/index.js";\n';
const facade = `export class Service {
  readonly #runner: Runner;
  constructor(seed: number) { this.#runner = new Runner(seed); }
  run(value: number): number { return this.#runner.run(value); }
}`;
async function prepare(fixture, t, source) {
  const f = await fixture(t);
  await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`, "export class Runner { constructor(readonly seed: number) {} run(value: number): number { return value + this.seed; } }");
  await f.write(`${f.sourceRoot}/index.ts`, imported + source);
  return f;
}
export function registerAssemblyFacadeCases(fixture, expectPass, rejects, compileFixture) {
  for (const [name, source] of [
    ["original public class shape", facade],
    ["async public delegation", facade.replace("run(value: number): number", "async run(value: number): Promise<number>")],
    ["factory result delegation", "const runner = new Runner(1); export function run(value: number): number { return runner.run(value); }"]
  ]) {test(`assembly facade preserves ${name}`, async (t) => {
    const f = await prepare(fixture, t, source);
    await expectPass(f); await compileFixture(f);
  });}
  for (const [name, source] of [
    ["mutable field", facade.replace("readonly #runner", "#runner")],
    ["public field", facade.replaceAll("#runner", "runner")],
    ["field initializer", facade.replace("#runner: Runner;", "#runner: Runner = new Runner(0);")],
    ["extra state", facade.replace("readonly #runner", "readonly #count = 1; readonly #runner")],
    ["extra constructor behavior", facade.replace("this.#runner =", "seed += 1; this.#runner =")],
    ["constructor branch", facade.replace("new Runner(seed)", "new Runner(seed > 0 ? seed : 0)")],
    ["shadowed constructor", "type Constructor = typeof Runner; " + facade.replace("constructor(seed: number)", "constructor(seed: number, Runner: Constructor)")],
    ["field replacement", facade.replace("return this.#runner.run(value);", "this.#runner = new Runner(value); return value;")],
    ["delegated arithmetic", facade.replace(".run(value)", ".run(value + 1)")],
    ["different delegated method", facade.replace(".run(value)", ".other(value)")],
    ["computed method", facade.replace(".run(value)", '["run"](value)')],
    ["optional delegation", facade.replace(".run(value)", ".run?.(value)")],
    ["parameter default", facade.replace("run(value: number)", "run(value = 1)")],
    ["property access instead of delegation", facade.replace("this.#runner.run(value)", "this.#runner.seed")],
    ["factory object escape", facade.replace("return this.#runner.run(value)", "return this.#runner")],
    ["static field", facade.replace("readonly #runner", "static readonly #runner")],
    ["inheritance", facade.replace("class Service", "class Service extends Runner")],
    ["generator", facade.replace("run(value: number): number", "*run(value: number): Generator<number>")],
    ["constructor alias to this", facade.replace("this.#runner =", "const receiver = this; receiver.#runner =")],
    ["static block", facade.replace("readonly #runner", "static { throw new Error(); } readonly #runner")],
    ["resource result arithmetic", "const runner = new Runner(1); export function run(value: number) { return runner.run(value) + 1; }"],
    ["resource argument arithmetic", "const runner = new Runner(1); export function run(value: number) { return runner.run(value + 1); }"],
    ["computed resource method", 'const runner = new Runner(1); export function run(value: number) { return runner["run"](value); }'],
    ["eager resource invocation", "const runner = new Runner(1); export const result = runner.run(1);"]
  ]) {test(`assembly facade rejects ${name}`, async (t) => {
    await rejects(await prepare(fixture, t, source), "assembly-behavior");
  });}
  for (const [label, body] of [
    ["direct result", "const feature = create(); return feature;"],
    ["curated method", "const feature = create(); return {execute: feature.execute};"],
    ["direct method", "const feature = create(); return feature.execute;"],
    ["aliased result", "const feature = create(); const selected = feature; return selected;"],
    ["aliased projection", "const feature = create(); const execute = feature.execute; return {execute};"],
    ["intact feature", "const feature = create(); return {feature};"]
  ]) {test(`assembly accepts proven factory ${label}`, async (t) => {
    const f = await fixture(t);
    await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`, "export const create = () => ({execute: (value: number) => value * 2});");
    await f.write(`${f.sourceRoot}/index.ts`, `import {create} from "./features/alpha/application/index.js"; export function createModule() {${body}}`);
    await compileFixture(f); await expectPass(f);
  });}
  for (const body of [
    "const feature = create(); return feature.execute();",
    "const feature = create(); return {execute: feature['execute']};",
    "const feature = create(); return {get execute() {return feature.execute;}};",
    "const feature = create(); return {execute: () => feature.execute()};",
    "const feature = create(); return (() => feature)();",
    "const feature = create(); return {execute: feature.execute ? feature.execute : create};",
    "const create = () => ({execute: () => 1}); const feature = create(); return feature;"
  ]) {test(`factory origin does not permit hidden assembly behavior: ${body}`, async (t) => {
    const f = await fixture(t);
    await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`, "export const create = () => ({execute: () => 1});");
    await f.write(`${f.sourceRoot}/index.ts`, `import {create} from "./features/alpha/application/index.js"; export function createModule() {${body}}`);
    await rejects(f, "assembly-behavior");
  });}

}
