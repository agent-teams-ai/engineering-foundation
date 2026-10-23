import {
  factoryCaseData0,
  factoryCaseData1,
  factoryCaseData2,
  factoryCaseData3,
  factoryCaseData4,
} from "./factory-surface-cases-data.ts";
const factoryPath = "packages/other/src/features/storage/adapters/factory.ts";
const applicationFactoryPath = "packages/other/src/features/storage/application/factory.ts";
const adapterFactory =
  "export function createApi() { function execute(value: string) { return value.length; } return { execute }; }";
const importFactory = 'import {createApi} from "./features/storage/adapters/factory.js";';

export function registerFactorySurfaceCases({
  test,
  assert,
  workspaceSurface,
  rejects,
  expectPass,
}) {
  for (const [label, surface] of [
    ["direct destructuring", `${importFactory} export const {execute} = createApi();`],
    [
      "renamed destructuring",
      `${importFactory} const {execute: run} = createApi(); export {run as execute};`,
    ],
    [
      "projected result member",
      `${importFactory} const api = createApi(); export const execute = api.execute;`,
    ],
    [
      "transparent wrapper",
      `${importFactory} const api = createApi(); export function execute(value: string) { return api.execute(value); }`,
    ],
    [
      "transparent awaited wrapper",
      `${importFactory} const api = createApi(); export async function execute(value: string) { return await api.execute(value); }`,
    ],
  ]) {
    test(`factory surface accepts owned adapter ${label}`, async (t) => {
      await expectPass(await prepareFactorySurface(workspaceSurface, t, { surface }));
    });
    test(`factory surface rejects application consumption through ${label}`, async (t) => {
      const f = await prepareFactorySurface(workspaceSurface, t, { surface, role: "application" });
      const result = await f.check();
      assert.ok(
        result.problems.some(
          ({ code, message }) => code === "layer-direction" && message.includes(factoryPath),
        ),
        JSON.stringify(result),
      );
      assert.ok(
        !result.problems.some(({ code }) => code === "surface-ownership"),
        JSON.stringify(result),
      );
    });
  }

  for (const [label, wrapper] of factoryCaseData0) {
    for (const role of ["adapters", "application"]) {
      test(`factory surface ${role} consumer of ${label}`, async (t) => {
        const f = await prepareFactorySurface(workspaceSurface, t, {
          role,
          surface: `${importFactory} const api = createApi(); ${wrapper}`,
        });
        if (role === "adapters") {
          await expectPass(f);
        } else {
          const result = await f.check();
          assert.ok(
            result.problems.some(
              ({ code, message }) => code === "layer-direction" && message.includes(factoryPath),
            ),
            JSON.stringify(result),
          );
          assert.ok(
            !result.problems.some(({ code }) => code === "surface-ownership"),
            JSON.stringify(result),
          );
        }
      });
    }
  }
  for (const [label, wrapper] of factoryCaseData1) {
    test(`factory surface keeps assembly rejection for ${label}`, async (t) => {
      await rejects(
        await prepareFactorySurface(workspaceSurface, t, {
          surface: `${importFactory} const api = createApi(); ${wrapper}`,
        }),
        "assembly-behavior",
      );
    });
  }

  const importedAdapter = 'import {read} from "./features/storage/adapters/index.js";';
  const factoryImport = 'import {createApi} from "./features/storage/application/factory.js";';
  test("factory surface preserves an injected adapter instead of the application factory owner", async (t) => {
    const f = await prepareFactorySurface(workspaceSurface, t, {
      role: "application",
      owner: "application",
      factory:
        "export function createApi(provided: (value: string) => unknown) { return {execute: provided}; }",
      surface: `${importedAdapter} ${factoryImport} export const {execute} = createApi(read);`,
    });
    await rejects(f, "layer-direction");
    assert.ok(!(await f.check()).problems.some(({ code }) => code === "surface-ownership"));
  });
  test("factory surface selects a local operation independently of another injected member", async (t) => {
    const f = await prepareFactorySurface(workspaceSurface, t, {
      role: "application",
      owner: "application",
      factory:
        "export function createApi(provided: (value: string) => unknown) { function execute(value: string) { return value.length; } return {execute, injected: provided}; }",
      surface: `${importedAdapter} ${factoryImport} export const {execute, injected} = createApi(read);`,
    });
    await expectPass(f);
    await f.write(
      `${f.sourceRoot}/features/alpha/application/index.ts`,
      'import * as api from "@fixture/other"; export const execute = api;',
    );
    await rejects(f, "layer-direction");
  });
  test("factory surface preserves a parameter shadow over an imported safe binding", async (t) => {
    const f = await prepareFactorySurface(workspaceSurface, t, {
      role: "application",
      owner: "application",
      factory:
        'import {compare as provided} from "../domain/index.js"; export function createApi(provided: (value: string) => unknown) { return {execute: provided}; }',
      surface: `${importedAdapter} ${factoryImport} export const {execute} = createApi(read);`,
    });
    f.sourcePolicy.boundaries
      .find(({ id }) => id === "other-application")
      .allow.boundaries.push("other-domain");
    await rejects(f, "layer-direction");
    assert.ok(!(await f.check()).problems.some(({ code }) => code === "surface-ownership"));
  });
  test("factory surface preserves default-export ownership", async (t) => {
    const f = await prepareFactorySurface(workspaceSurface, t, {
      surface: `${importFactory} const {execute} = createApi(); export {execute as default};`,
      consumer: 'import execute from "@fixture/other"; export {execute};',
    });
    await expectPass(f);
  });
  test("factory surface includes every member of a named object import", async (t) => {
    const f = await prepareFactorySurface(workspaceSurface, t, {
      role: "application",
      owner: "application",
      factory:
        "export function createApi(provided: (value: string) => unknown) { function safe(value: string) { return value.length; } return {safe, injected: provided}; }",
      surface: `${importedAdapter} ${factoryImport} export const execute = createApi(read);`,
    });
    await rejects(f, "layer-direction");
  });
  test("factory surface distinguishes repeated calls with different supplied owners", async (t) => {
    const f = await prepareFactorySurface(workspaceSurface, t, {
      role: "application",
      owner: "application",
      factory: "export function createApi(provided: unknown) { return {execute: provided}; }",
      surface: `${importedAdapter} ${factoryImport} import {compare} from "./features/storage/domain/index.js"; const {execute: safe} = createApi(compare); const {execute: unsafe} = createApi(read); export {safe, unsafe};`,
      consumer: 'export {safe as execute} from "@fixture/other";',
    });
    await expectPass(f);
    await f.write(
      `${f.sourceRoot}/features/alpha/application/index.ts`,
      'export {unsafe as execute} from "@fixture/other";',
    );
    await rejects(f, "layer-direction");
  });
  test("factory surface resolves local implementations without evaluating constructor arguments", async (t) => {
    const f = await prepareFactorySurface(workspaceSurface, t, {
      factory:
        "export function createApi(dependencies: {token: unknown}) { function execute() { return dependencies.token; } return {execute}; }",
      surface: `${importFactory} import {Token} from "./features/storage/adapters/token.js"; export const {execute} = createApi({token: new Token()});`,
    });
    const path = "packages/other/src/features/storage/adapters/token.ts";
    f.sourcePolicy.boundaries.find(({ id }) => id === "other-adapters").entrypoints.push(path);
    await f.write(path, "export class Token {}");
    await expectPass(f);
  });
  test("factory surface rejects normalized duplicate numeric return keys", async (t) => {
    const f = await prepareFactorySurface(workspaceSurface, t, {
      factory:
        'export function createApi() { function execute() { return 1; } return {1: execute, "1": execute}; }',
      surface: `${importFactory} export const {1: execute} = createApi();`,
    });
    await rejects(f, "surface-ownership");
  });
  test("factory surface rejects a spread argument even for a locally owned method", async (t) => {
    const f = await prepareFactorySurface(workspaceSurface, t, {
      factory:
        "export function createApi(input: unknown) { function execute() { return input; } return {execute}; }",
      surface: `${importFactory} import {read} from "./features/storage/adapters/index.js"; const args = [read]; export const {execute} = createApi(...args);`,
    });
    await rejects(f, "surface-ownership");
  });
  for (const [label, selected] of [
    ["computed returned member", 'provided["method"]'],
    ["optional returned member", "provided?.method"],
    ["reflective returned member", 'Object.getOwnPropertyDescriptor(provided, "method")?.value'],
  ]) {
    test(`factory surface fails closed for ${label} instead of attributing it to the application factory`, async (t) => {
      const f = await prepareFactorySurface(workspaceSurface, t, {
        role: "application",
        owner: "application",
        factory: `export function createApi(provided: {method: (value: string) => unknown}) { return {execute: ${selected}}; }`,
        surface: `${importedAdapter} ${factoryImport} export const {execute} = createApi({method: read});`,
      });
      await rejects(f, "surface-ownership");
    });
  }
  for (const [label, factory] of factoryCaseData2) {
    test(`factory surface rejects unstable or non-runtime ${label}`, async (t) => {
      await rejects(
        await prepareFactorySurface(workspaceSurface, t, { factory }),
        "surface-ownership",
      );
    });
  }
  for (const [label, factory] of factoryCaseData3) {
    test(`factory surface retains stable ownership with ${label}`, async (t) => {
      await expectPass(await prepareFactorySurface(workspaceSurface, t, { factory }));
    });
  }
  for (const [label, factory] of factoryCaseData4) {
    test(`factory surface fails closed for ${label}`, async (t) => {
      const f = await prepareFactorySurface(workspaceSurface, t, { factory });
      await rejects(f, "surface-ownership");
    });
  }
  for (const [label, surface] of [
    ["default destructuring", `${importFactory} export const {execute = () => 1} = createApi();`],
    [
      "rest destructuring",
      `${importFactory} const {...api} = createApi(); export const execute = api.execute;`,
    ],
    [
      "computed destructuring",
      `${importFactory} export const {["execute"]: execute} = createApi();`,
    ],
    [
      "rewritten wrapper input",
      `${importFactory} const api = createApi(); export function execute(value: string) { return api.execute(value + "!"); }`,
    ],
    [
      "wrapper effect before delegation",
      `${importFactory} const api = createApi(); export function execute(value: string) { console.log(value); return api.execute(value); }`,
    ],
  ]) {
    test(`factory surface keeps the assembly gate for ${label}`, async (t) => {
      await rejects(
        await prepareFactorySurface(workspaceSurface, t, { surface }),
        "assembly-behavior",
      );
    });
  }
}

async function prepareFactorySurface(
  workspaceSurface,
  t,
  {
    role = "adapters",
    surface,
    factory = adapterFactory,
    owner = "adapters",
    consumer = 'export {execute} from "@fixture/other";',
  } = {},
) {
  const f = await workspaceSurface(
    t,
    consumer,
    surface ?? `${importFactory} export const {execute} = createApi();`,
  );
  f.profile.modules[0].features[0].layers[0].role = role;
  const path = owner === "application" ? applicationFactoryPath : factoryPath;
  f.sourcePolicy.boundaries.find(({ id }) => id === `other-${owner}`).entrypoints.push(path);
  await f.write(path, factory);
  return f;
}
