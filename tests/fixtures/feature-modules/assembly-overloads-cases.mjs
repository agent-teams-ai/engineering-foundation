import test from "node:test";

async function overloadFixture(fixture, t, body) {
  const f = await fixture(t);
  await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`,
    'export function feature(input: string | number): unknown { return input; }\n');
  await f.write(`${f.sourceRoot}/index.ts`,
    'import { feature } from "./features/alpha/application/index.js";\n' + body);
  return f;
}

export function registerAssemblyOverloadsCases(fixture, expectPass, rejects) {
  for (const prefix of ["export ", ""]) {
    test(`assembly preserves ${prefix || "local "}function overload declarations`, async (t) => {
      await expectPass(await overloadFixture(fixture, t,
        `${prefix}function compose(input: string): unknown;\n` +
        `${prefix}function compose(input: number): unknown;\n` +
        `${prefix}function compose(input: string | number) { return feature(input); }\n`));
    });
  }
  for (const [name, body] of [
    ["missing implementation", "export function compose(input: string): unknown;"],
    ["ambient declaration", "export declare function compose(input: string): unknown;"],
    ["different implementation", "export function compose(input: string): unknown; export function other(input: string) { return feature(input); }"],
    ["nested implementation", "export function compose(input: string): unknown; export function outer() { function compose(input: string) { return feature(input); } return compose; }"],
    ["policy in implementation", "export function compose(input: string): unknown; export function compose(input: string) { return input.length ? feature(input) : undefined; }"],
    ["overload cannot authorize a fake factory", "export function injected(input: string): unknown; export function compose(input: string) { return injected(input); }"]
  ]) {
    test(`assembly overload rejects ${name}`, async (t) => {
      await rejects(await overloadFixture(fixture, t, body), "assembly-behavior");
    });
  }
}
