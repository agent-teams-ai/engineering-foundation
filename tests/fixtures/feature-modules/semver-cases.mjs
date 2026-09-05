import { readFile } from "node:fs/promises";
import test from "node:test";

export function registerSemverPrimitiveCases(primitiveFixture, expectPass, rejects, qualifyPrimitive) {
  test("primitive admission accepts the existing exact SemVer implementation", async (t) => {
    const f = await primitiveFixture(t, "Exact semantic-version parsing and comparison");
    const source = await readFile(new URL("../../../packages/engineering-foundation/src/semantic-version.ts", import.meta.url), "utf8");
    await f.write(f.record.path, source);
    for (const consumer of f.record.consumers) {
      await f.write(consumer.path, 'import {isExactVersion} from "../../../compare.js"; export const execute = () => isExactVersion("1.2.3");');
    }
    await expectPass(f);
  });

  for (const [label, source] of [
    ["global RegExp", 'const pattern = /a/g; export const compare = (value: string) => pattern.test(value);'],
    ["sticky RegExp", 'const pattern = /a/y; export const compare = (value: string) => pattern.exec(value);'],
    ["RegExp state write", 'const pattern = /a/u; export const compare = () => {pattern.lastIndex = 1; return 1;};'],
    ["RegExp method replacement", 'const pattern = /a/u; export const compare = () => {pattern.test = () => true; return 1;};'],
    ["RegExp method escape", 'const pattern = /a/u; export const compare = () => pattern.test;'],
    ["RegExp object escape", 'const pattern = /a/u; export const compare = () => pattern;'],
    ["RegExp alias escape", 'const pattern = /a/u; export const compare = () => {const alias = pattern; return alias.test("a");};'],
    ["RegExp recompilation", 'const pattern = /a/u; export const compare = () => pattern.compile("b");'],
    ["RegExp unknown property", 'const pattern = /a/u; export const compare = (key: string) => pattern[key]("a");'],
    ["RegExp computed call", 'const pattern = /a/u; export const compare = () => pattern["test"]("a");'],
    ["RegExp spread call", 'const pattern = /a/u; export const compare = (...args: [string]) => pattern.test(...args);'],
    ["RegExp missing argument", 'const pattern = /a/u; export const compare = () => pattern.test();'],
    ["RegExp extra argument", 'const pattern = /a/u; export const compare = () => pattern.test("a", "b");'],
    ["RegExp exported instance", 'export const pattern = /a/u; export const compare = () => pattern.test("a");'],
    ["RegExp nested escape", 'const table = {pattern: /a/u}; export const compare = () => table.pattern;'],
    ["RegExp wrapped write", 'const pattern = /a/u; export const compare = () => {((pattern as RegExp).lastIndex satisfies number)++; return 1;};'],
    ["error constructed without throw", 'export const compare = () => new TypeError("error");'],
    ["error with implicit message", 'export const compare = () => {throw new TypeError();};'],
    ["error with extra argument", 'export const compare = () => {throw new TypeError("error", {});};'],
    ["error constructor alias", 'export const compare = () => {const E = TypeError; throw new E("error");};'],
    ["RegExp optional call", 'const pattern = /a/u; export const compare = () => pattern.test?.("a");'],
    ["ambient error message", 'export const compare = () => {throw new TypeError(String(Date.now()));};'],
    ["error constructor escape", 'export const compare = () => TypeError;']
  ]) {test(`primitive admission rejects ${label}`, async (t) => {
    const f = await primitiveFixture(t);
    await f.write(f.record.path, source);
    await rejects(f, "impure-primitive");
  });}

  for (const source of [
    'const pattern = /a/u; export const compare = () => pattern.test("a") ? 1 : 0;',
    'const table = {pattern: /a/u}; export const compare = () => table.pattern.exec("a")?.[0] === "a" ? 1 : 0;'
  ]) {test(`typed compiled primitive retains repeatable RegExp calls: ${source}`, async (t) => {
    const f = await primitiveFixture(t), proof = await qualifyPrimitive(f, source, [1, 1]);
    await expectPass(f); t.diagnostic(JSON.stringify(proof));
  });}
}
