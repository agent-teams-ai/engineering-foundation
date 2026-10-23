import {
  boundary,
  generatedFixture as prepareGeneratedFixture,
  workspaceSurface as prepareWorkspaceSurface,
} from "./feature-module-workspace-surface.ts";
import { registerFeatureLayerCases } from "./feature-module-layer-cases.ts";
import { registerInvalidFeatureProfileCases } from "./feature-module-invalid-profile-cases.ts";
import {
  loadConformanceFacts,
  primitiveDecision,
  compileFixture,
  registerPrimitiveConformanceCases,
} from "./feature-module-primitive-conformance-cases.ts";
import {
  factoryCaseData0,
  factoryCaseData1,
  factoryCaseData2,
} from "./feature-module-conformance.test-data.ts";
import { registerFactoryReviewCases } from "./fixtures/feature-modules/factory-review-cases.mjs";
import { registerCrossModuleFactoryCases } from "./fixtures/feature-modules/factory-cross-module-cases.mjs";
import { registerFactorySurfaceCases } from "./fixtures/feature-modules/factory-surface-cases.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import { validateFeatureModules } from "../scripts/check-feature-modules.mjs";
import { registerAssemblyFacadeCases } from "./fixtures/feature-modules/assembly-facade-cases.mjs";
import { registerSemverPrimitiveCases } from "./fixtures/feature-modules/semver-cases.mjs";
import { registerPrimitiveErrorCases } from "./fixtures/feature-modules/primitive-error-cases.mjs";
import { registerJsonInspectionCases } from "./fixtures/feature-modules/json-inspection-cases.mjs";
import { registerExecutableArgumentsCases } from "./fixtures/feature-modules/executable-arguments-cases.mjs";
import { registerAssemblyOverloadsCases } from "./fixtures/feature-modules/assembly-overloads-cases.mjs";
import { registerNamespaceSurfaceCases } from "./fixtures/feature-modules/namespace-surface-cases.mjs";

const { standard, cases } = await loadConformanceFacts();
/** @returns {Promise<import("./feature-module-fixture-contract.ts").FeatureFixture>} */
async function fixture(t, role = "platform") {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "ef-feature-modules-"));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const root = "packages/example",
    sourceRoot = `${root}/src`;
  const write = async (path, content) => {
    await mkdir(dirname(join(repositoryRoot, path)), { recursive: true });
    await writeFile(join(repositoryRoot, path), content);
  };
  const features = ["alpha", "beta"].map((id) => ({
    id,
    role,
    testRoots: ["tests/features/" + id],
    layers: [{ role: "application", roots: [`${sourceRoot}/features/${id}/application`] }],
  }));
  const profile = {
    schemaVersion: 1,
    standard: {
      id: "agent-teams.feature-module-standard",
      version: "v1",
      path: "standard.md",
      digest: `sha256:${createHash("sha256").update(standard).digest("hex")}`,
    },
    architectureDocument: "architecture.md",
    decision: "decision.md",
    topology: { packageInventory: "scripts/publishable-packages.mjs", sourcePolicy: "policy.yaml" },
    productionRoots: ["packages"],
    applicationRoots: [],
    excludedRoots: [],
    enforcementCommands: [
      "pnpm architecture:features:check",
      "pnpm lint:typed",
      "pnpm architecture:patterns",
      "pnpm check",
    ],
    localExtensions: {
      language: "TypeScript ESM",
      packaging: "pnpm",
      composition: "explicit",
      transport: "outer contracts",
    },
    modules: [
      {
        id: "example",
        packageName: "@fixture/example",
        root,
        sourceRoot,
        role,
        preferredFeatureRoot: `${sourceRoot}/features`,
        testRoots: ["tests"],
        publicEntrypoints: [`${sourceRoot}/index.ts`],
        moduleAssembly: [`${sourceRoot}/index.ts`],
        generatedRoots: [],
        exceptions: [],
        features,
      },
    ],
  };

  const sourcePolicy = {
    schemaVersion: 2,
    workspace: { kind: "pnpm", manifest: "pnpm-workspace.yaml" },
    packageRoots: ["packages"],
    governedRoots: [sourceRoot],
    boundaries: [
      ...features.map(({ id }) =>
        boundary(
          id,
          [`${sourceRoot}/features/${id}/application`],
          [`${sourceRoot}/features/${id}/application/index.ts`],
        ),
      ),
      boundary("assembly", [`${sourceRoot}/index.ts`], [`${sourceRoot}/index.ts`]),
    ],
  };
  await write("standard.md", standard);
  await write("architecture.md", "# Local architecture\n[Profile](feature-modules.json)\n");
  await write("tests/features/alpha/contract.test.mjs", "export {};\n");
  await write("tests/features/beta/contract.test.mjs", "export {};\n");
  await write("decision.md", "---\nid: ADR-9999\nstatus: accepted\n---\n# Adoption\n");
  await write("README.md", "[Architecture](architecture.md)\n");
  await write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  await write(
    "package.json",
    JSON.stringify({
      name: "fixture-root",
      private: true,
      scripts: {
        "check:fast": "pnpm architecture:features:check",
        check: "pnpm architecture:features:check && pnpm lint:typed && pnpm architecture:patterns",
        "lint:typed": "node tools/repository-command.mts tool lint:typed",
        "architecture:patterns": "node tools/repository-command.mts tool architecture:patterns",
        "architecture:features:check":
          "node tools/repository-command.mts tool architecture:features:check",
      },
    }),
  );
  await write(
    `${root}/package.json`,
    JSON.stringify({
      name: "@fixture/example",
      version: "1.0.0",
      type: "module",
      exports: { ".": "./src/index.ts" },
    }),
  );
  sourcePolicy.boundaries[2].allow.boundaries.push("alpha");
  await write(
    `${sourceRoot}/index.ts`,
    "export { execute } from './features/alpha/application/index.js';\n",
  );
  for (const id of ["alpha", "beta"]) {
    await write(`${sourceRoot}/features/${id}/application/index.ts`, cases.application);
  }
  await write(`${sourceRoot}/features/beta/application/private.ts`, cases.private);
  const check = async (productionPackages = [{ name: "@fixture/example", root }]) => {
    await write("profile.json", JSON.stringify(profile));
    await write("policy.yaml", YAML.stringify(sourcePolicy));
    return validateFeatureModules({
      repositoryRoot,
      profilePath: "profile.json",
      productionPackages,
    });
  };
  return { repositoryRoot, sourceRoot, profile, sourcePolicy, write, check };
}

for (const role of ["platform", "integration", "sdk"]) {
  test(`accepts real ${role} module features`, async (t) => {
    const f = await fixture(t, role);
    assert.deepEqual((await f.check()).problems, []);
  });
}
test("rejects a real cross-feature deep import even when the feature edge is allowed", async (t) => {
  const f = await fixture(t);
  f.sourcePolicy.boundaries[0].allow.boundaries.push("beta");
  await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`, cases.deepImport);
  assert.ok((await f.check()).problems.some(({ code }) => code === "cross-feature-deep-import"));
});
test("rejects application importing an adapter even when policy allows it", async (t) => {
  const f = await fixture(t);
  const root = `${f.sourceRoot}/features/alpha/adapters`;
  f.profile.modules[0].features[0].layers.push({ role: "adapters", roots: [root] });
  f.sourcePolicy.boundaries.push({
    id: "adapter",
    roots: [root],
    entrypoints: [`${root}/read.ts`],
    allow: { boundaries: [], packages: [], builtins: [], runtimeReferences: [] },
  });
  f.sourcePolicy.boundaries[0].allow.boundaries.push("adapter");
  await f.write(`${root}/read.ts`, cases.adapter);
  await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`, cases.reverseImport);
  assert.ok((await f.check()).problems.some(({ code }) => code === "layer-direction"));
});

async function rejects(f, code) {
  const result = await f.check();
  assert.ok(
    result.problems.some((entry) => entry.code === code),
    JSON.stringify(result),
  );
  assert.ok(!result.problems.some((entry) => entry.code === "input-error"), JSON.stringify(result));
}
test("permits a curated sibling application API and module export", async (t) => {
  const f = await fixture(t);
  f.sourcePolicy.boundaries[0].allow.boundaries.push("beta");
  await f.write(
    `${f.sourceRoot}/features/alpha/application/index.ts`,
    "import { execute as beta } from '../../beta/application/index.js';\nexport const execute = () => beta();\n",
  );
  await f.write(
    `${f.sourceRoot}/index.ts`,
    "export { execute } from './features/alpha/application/index.js';\n",
  );
  assert.deepEqual((await f.check()).problems, []);
});
test("rejects an actual undeclared import independently of a declared feature graph", async (t) => {
  const f = await fixture(t);
  await f.write(
    `${f.sourceRoot}/features/alpha/application/index.ts`,
    "export { execute } from '../../beta/application/index.js';\n",
  );
  await rejects(f, "source-policy");
});
test("rejects a real type-only feature cycle", async (t) => {
  const f = await fixture(t);
  f.sourcePolicy.boundaries[0].allow.boundaries.push("beta");
  f.sourcePolicy.boundaries[1].allow.boundaries.push("alpha");
  await f.write(
    `${f.sourceRoot}/features/alpha/application/index.ts`,
    "import type { B } from '../../beta/application/index.js';\nexport interface A { b?: B }\n",
  );
  await f.write(
    `${f.sourceRoot}/features/beta/application/index.ts`,
    "import type { A } from '../../alpha/application/index.js';\nexport interface B { a?: A }\n",
  );
  await rejects(f, "feature-cycle");
});
registerInvalidFeatureProfileCases(fixture, rejects);
test("rejects unsafe profile paths without traversing them", async (t) => {
  const f = await fixture(t);
  f.profile.modules[0].features[0].layers[0].roots = ["../outside"];
  const result = await f.check();
  assert.equal(result.outcome, "failed");
});
test("creation plan can materialize a conforming feature from real caller behavior", async (t) => {
  const { planFeature } = await import("../scripts/check-feature-modules.mjs");
  const f = await fixture(t);
  const source = "export const double = (value: number): number => value * 2;\n";
  const plan = planFeature(f.profile, "example", "doubling", "double", source);
  assert.deepEqual(plan, planFeature(f.profile, "example", "doubling", "double", source));
  assert.throws(() => planFeature(f.profile, "example", "empty", "empty", ""), /real first/u);
  assert.throws(
    () => planFeature(f.profile, "example", "../escape", "double", source),
    /kebab-case/u,
  );
  for (const write of plan.writes) {
    await f.write(write.path, write.content);
  }
  await f.write("packages/example/tests/features/doubling/contract.test.mjs", "export {};\n");
  f.profile.modules[0].features.push(plan.profileEntry);
  f.sourcePolicy.boundaries.push(plan.sourcePolicyBoundary, plan.testPolicyBoundary);
  f.sourcePolicy.governedRoots.push(...plan.additionalGovernedRoots);
  assert.deepEqual((await f.check()).problems, []);
});

test("rejects a layer containing only empty modules", async (t) => {
  const f = await fixture(t);
  await f.write(
    `${f.sourceRoot}/features/alpha/application/index.ts`,
    "// no owned artifact\nexport {};\n",
  );
  await rejects(f, "empty-layer");
});
test("rejects a primitive decision whose accepted status is prose only", async (t) => {
  const f = await fixture(t);
  const path = `${f.sourceRoot}/clock.ts`;
  f.profile.modules[0].exceptions.push({
    path,
    decision: "decision.md",
    owner: "maintainers",
    rationale: "test",
    reviewTrigger: "change",
  });
  await f.write(path, "export const instant = 1;\n");
  await f.write("decision.md", `# Proposed decision\nstatus: accepted\n${path}\n`);
  await rejects(f, "exception-decision");
});

test("CLI plans caller bytes through the documented pnpm separator without mutation", async (t) => {
  const f = await fixture(t);
  const input = "export const inspect = (path: string): boolean => path.endsWith('.ts');\n";
  await f.write("inspect.ts", input);
  const args = [
    join(import.meta.dirname, "../scripts/check-feature-modules.mjs"),
    "plan",
    "--",
    "engineering-foundation",
    "path-inspection",
    "inspect",
    "--from",
    join(f.repositoryRoot, "inspect.ts"),
  ];
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.writes[0].content, input);
  assert.equal(
    plan.writes[0].path,
    "packages/engineering-foundation/src/features/path-inspection/application/inspect.ts",
  );
  assert.equal(await readFile(join(f.repositoryRoot, "inspect.ts"), "utf8"), input);
  args[3] = "unknown-module";
  const invalid = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /Unknown module/u);
});

// Promoted independent guard review regressions and controls.
const expectPass = async (f) => assert.deepEqual((await f.check()).problems, []);
registerFeatureLayerCases({ fixture, expectPass, rejects, primitiveFixture, boundary });
const workspaceSurface = (t, consumer, publicSource) =>
  prepareWorkspaceSurface(fixture, boundary, t, consumer, publicSource);
for (const [label, consumer, rejection] of factoryCaseData0) {
  test(`workspace surface: ${label}`, async (t) => {
    const f = await workspaceSurface(t, consumer);
    if (rejection) {
      await rejects(f, rejection);
    } else {
      await expectPass(f);
    }
  });
}
test("workspace ownership follows a named imported alias and rejects its adapter origin", async (t) => {
  const f = await workspaceSurface(
    t,
    'import {execute} from "@fixture/other"; export {execute};',
    'import {read} from "./features/storage/adapters/index.js"; const alias = read; export {alias as execute};',
  );
  await rejects(f, "layer-direction");
});
test("workspace pure primitive keeps exact direct and public-surface consumers", async (t) => {
  const f = await workspaceSurface(
    t,
    'export {compare as execute} from "@fixture/other";',
    'export {compare} from "./features/storage/domain/index.js";',
  );
  const path = "packages/other/src/features/storage/domain/index.ts";
  f.module.features[0].layers = f.module.features[0].layers.filter(({ role }) => role !== "domain");
  f.sourcePolicy.boundaries.find(({ id }) => id === "other-domain").roots = [path];
  const record = await primitiveDecision(f, path, [
    { path: "packages/other/src/index.ts", owner: "other/@assembly" },
    { path: `${f.sourceRoot}/features/alpha/application/index.ts`, owner: "example/alpha" },
  ]);
  f.module.exceptions.push(record);
  await f.write(path, "export const compare = (a:string,b:string) => a < b ? -1 : a > b ? 1 : 0;");
  await expectPass(f);
  await f.write(
    path,
    "export const compare = (a:string,b:string) => a < b ? -1 : a > b ? 1 : 0; export type Token = string;",
  );
  await f.write(
    "packages/other/src/index.ts",
    'export {compare} from "./features/storage/domain/index.js"; export type {Token} from "./features/storage/domain/index.js";',
  );
  for (const source of [
    'import type {Token} from "@fixture/other"; export type Execute = Token;',
    'export type Execute = typeof import("@fixture/other").compare;',
  ]) {
    await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`, source);
    await expectPass(f);
  }
  record.consumers.pop();
  await rejects(f, "primitive-consumer");
});
test("workspace pure default and namespace surfaces retain their owned semantics", async (t) => {
  const f = await workspaceSurface(
    t,
    'import compare from "@fixture/other"; export const execute = () => compare("a","b");',
    'export {compare as default} from "./features/storage/domain/index.js";',
  );
  await expectPass(f);
  await f.write(
    `${f.sourceRoot}/features/alpha/application/index.ts`,
    'import * as api from "@fixture/other"; export const execute = () => api.default("a","b");',
  );
  await expectPass(f);
});
test("workspace derived assembly types retain the imported semantic owner", async (t) => {
  const f = await workspaceSurface(
    t,
    'export type {Operation as Execute} from "@fixture/other";',
    'import {compare} from "./features/storage/domain/index.js"; export type Operation = typeof compare;',
  );
  await expectPass(f);
  await f.write(
    "packages/other/src/index.ts",
    'import {read} from "./features/storage/adapters/index.js"; export type Operation = typeof read;',
  );
  await rejects(f, "layer-direction");
});
test("workspace feature-owned generic data types keep their owner", async (t) => {
  const f = await workspaceSurface(
    t,
    'export type {Token as Execute} from "@fixture/other";',
    'export type {Token} from "./features/storage/domain/index.js";',
  );
  await f.write(
    "packages/other/src/features/storage/domain/index.ts",
    "export type Token = Readonly<{value:string}>;",
  );
  await expectPass(f);
});
test("workspace dist ownership uses manifest exports and the exact packageExports claim", async (t) => {
  const f = await workspaceSurface(
    t,
    'import {compare} from "@fixture/other"; export const execute = () => compare("a","b");',
  );
  await f.write(
    "packages/other/package.json",
    JSON.stringify({
      name: "@fixture/other",
      version: "1.0.0",
      type: "module",
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
    }),
  );
  f.otherAssembly.packageExports = ["."];
  await expectPass(f);
  f.sourcePolicy.boundaries.find(({ id }) => id === "other-domain").packageExports = ["."];
  assert.equal((await f.check()).outcome, "failed", "duplicate export owners must fail closed");
});
test("workspace source projection rejects a contradictory export claim", async (t) => {
  const f = await workspaceSurface(t, 'export {compare as execute} from "@fixture/other";');
  await f.write(
    "packages/other/package.json",
    JSON.stringify({
      name: "@fixture/other",
      version: "1.0.0",
      type: "module",
      exports: { ".": "./dist/index.js" },
    }),
  );
  f.sourcePolicy.boundaries.find(({ id }) => id === "other-domain").packageExports = ["."];
  await rejects(f, "surface-ownership");
});
for (const [role, binding, permitted] of [
  ["domain", "compare", true],
  ["domain", "inspect", false],
  ["adapters", "inspect", true],
  ["adapters", "read", true],
]) {
  test(`workspace ${role} access to ${binding} preserves its semantic direction`, async (t) => {
    const f = await workspaceSurface(t, `export {${binding} as execute} from "@fixture/other";`);
    f.profile.modules[0].features[0].layers[0].role = role;
    if (permitted) {
      await expectPass(f);
    } else {
      await rejects(f, "layer-direction");
    }
  });
}
for (const [label, source] of factoryCaseData1) {
  test(`assembly rejects ${label}`, async (t) => {
    const f = await fixture(t);
    await f.write(
      `${f.sourceRoot}/index.ts`,
      `import {execute as run} from "./features/alpha/application/index.js";\n${source}`,
    );
    await rejects(f, "assembly-behavior");
  });
}
test("assembly permits imported factories and explicit dependency wiring", async (t) => {
  const f = await fixture(t);
  await f.write(
    `${f.sourceRoot}/features/alpha/application/index.ts`,
    "export const create = (input: {value:number}) => ({value:input.value});",
  );
  await f.write(
    `${f.sourceRoot}/index.ts`,
    'import {create} from "./features/alpha/application/index.js"; export function execute(input: {value:number}) {return create({value:input.value});}',
  );
  await expectPass(f);
});
test("only a designated executable may start resources, await readiness and dispose", async (t) => {
  const f = await fixture(t),
    cli = `${f.sourceRoot}/cli.ts`;
  f.profile.modules[0].moduleAssembly.push(cli);
  const entry = boundary("cli", [cli], [cli]);
  entry.allow.boundaries.push("alpha");
  f.sourcePolicy.boundaries.push(entry);
  await f.write(
    `${f.sourceRoot}/features/alpha/application/index.ts`,
    "export const create = () => ({start:async()=>{}, ready:async()=>{}, dispose:async()=>{}});",
  );
  await f.write(
    cli,
    'import {create} from "./features/alpha/application/index.js"; const app = create(); try {await app.start(); await app.ready();} finally {await app.dispose();}',
  );
  await rejects(f, "assembly-behavior");
  await f.write(
    "packages/example/package.json",
    JSON.stringify({
      name: "@fixture/example",
      version: "1.0.0",
      type: "module",
      exports: { ".": "./src/index.ts" },
      bin: { example: "./src/cli.ts" },
    }),
  );
  await expectPass(f);
});

async function primitiveFixture(t, semantics) {
  const f = await fixture(t),
    path = `${f.sourceRoot}/compare.ts`;
  const record = await primitiveDecision(
    f,
    path,
    ["alpha", "beta"].map((id) => ({
      path: `${f.sourceRoot}/features/${id}/application/index.ts`,
      owner: `example/${id}`,
    })),
    semantics,
  );
  f.profile.modules[0].exceptions.push(record);
  await f.write(path, "export const compare = (a:string,b:string) => a < b ? -1 : a > b ? 1 : 0;");
  f.sourcePolicy.boundaries.push(boundary("primitive", [path], [path]));
  for (const [index, consumer] of record.consumers.entries()) {
    f.sourcePolicy.boundaries[index].allow.boundaries.push("primitive");
    await f.write(
      consumer.path,
      'import {compare} from "../../../compare.js"; export const execute = () => compare("a","b");',
    );
  }
  return { ...f, record };
}

registerSemverPrimitiveCases(primitiveFixture, expectPass, rejects, qualifyPrimitive);
registerPrimitiveErrorCases(primitiveFixture, expectPass, rejects, qualifyPrimitive);
registerJsonInspectionCases(primitiveFixture, expectPass, rejects);
registerAssemblyFacadeCases(fixture, expectPass, rejects, compileFixture);

test("primitive admission rejects an undeclared consumer even with a source-policy edge", async (t) => {
  const f = await primitiveFixture(t);
  f.record.consumers.pop();
  await rejects(f, "primitive-consumer");
});
test("primitive admission requires actual current use by every listed consumer", async (t) => {
  const f = await primitiveFixture(t);
  await f.write(f.record.consumers[1].path, "export const execute = () => 1;");
  await rejects(f, "primitive-consumer");
});
for (const source of [
  "export const compare = () => Date.now();",
  "export const compare = () => Math.random();",
  "let counter = 0; export const compare = () => ++counter;",
]) {
  test(`primitive rejects impurity: ${source}`, async (t) => {
    const f = await primitiveFixture(t);
    await f.write(f.record.path, source);
    await rejects(f, "impure-primitive");
  });
}
test("primitive does not waive filesystem or reverse feature imports", async (t) => {
  const f = await primitiveFixture(t),
    entry = f.sourcePolicy.boundaries.at(-1);
  entry.allow.builtins.push("node:fs");
  await f.write(
    f.record.path,
    'import {readFileSync} from "node:fs"; export const compare = () => readFileSync("data");',
  );
  await rejects(f, "inner-infrastructure");
  entry.allow.boundaries.push("alpha");
  await f.write(
    f.record.path,
    'import {execute} from "./features/alpha/application/index.js"; export const compare = execute;',
  );
  await rejects(f, "layer-direction");
});
for (const source of factoryCaseData2) {
  test(`crypto operation remains bounded: ${source}`, async (t) => {
    const f = await fixture(t);
    f.sourcePolicy.boundaries[0].allow.builtins.push("node:crypto");
    await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`, source);
    await rejects(f, "inner-infrastructure");
  });
}
test("renamed fixed explicit-byte hash remains pure", async (t) => {
  const f = await fixture(t);
  f.sourcePolicy.boundaries[0].allow.builtins.push("node:crypto");
  await f.write(
    `${f.sourceRoot}/features/alpha/application/index.ts`,
    'import {createHash as hash} from "node:crypto"; export const execute = (bytes:Uint8Array) => hash("sha256").update(bytes).digest("hex");',
  );
  await expectPass(f);
});

const generatedFixture = (t) => prepareGeneratedFixture(fixture, boundary, t);
test("generated application source retains forbidden imports and feature cycles", async (t) => {
  const f = await generatedFixture(t);
  await expectPass(f);
  f.generatedBoundary.allow.builtins.push("node:fs");
  await f.write(
    f.generatedPath,
    'import {readFileSync} from "node:fs"; export const value = readFileSync("data");',
  );
  await rejects(f, "inner-infrastructure");
  await f.write(
    f.generatedPath,
    'import {execute} from "../../beta/application/index.js"; export const value = execute();',
  );
  f.generatedBoundary.allow.boundaries.push("beta");
  f.sourcePolicy.boundaries[1].allow.boundaries.push("generated");
  await f.write(
    `${f.sourceRoot}/features/beta/application/index.ts`,
    'import {value} from "../../alpha/generated/data.js"; export const execute = () => value;',
  );
  await rejects(f, "feature-cycle");
});
test("generated provenance cannot replace semantic ownership or omit source identities", async (t) => {
  const f = await generatedFixture(t);
  f.profile.modules[0].features[0].layers[0].roots.pop();
  await rejects(f, "generated-root");
  f.profile.modules[0].features[0].layers[0].roots.push(
    f.profile.modules[0].generatedRoots[0].root,
  );
  f.profile.modules[0].generatedRoots[0].sources = [];
  await rejects(f, "generated-provenance");
});
for (const [extension, emitted] of [
  ["ts", "js"],
  ["mts", "mjs"],
  ["cts", "cjs"],
]) {
  test(`manifest conditional .${emitted}/.d.${extension} exports and bin use the exact source owner`, async (t) => {
    const f = await fixture(t),
      source = `${f.sourceRoot}/entry.${extension}`;
    f.profile.modules[0].publicEntrypoints.push(source);
    f.profile.modules[0].moduleAssembly.push(source);
    const entry = boundary("entry", [source], [source]);
    entry.allow.boundaries.push("alpha");
    f.sourcePolicy.boundaries.push(entry);
    await f.write(source, 'export {execute} from "./features/alpha/application/index.js";');
    const manifest = {
      name: "@fixture/example",
      version: "1.0.0",
      type: "module",
      exports: {
        ".": {
          types: `./dist/entry.d.${extension}`,
          import: `./dist/entry.${emitted}`,
          require: `./dist/entry.${emitted}`,
        },
        "./schema": "./schema.json",
      },
      bin: `./dist/entry.${emitted}`,
    };
    await f.write("packages/example/schema.json", "{}");
    await f.write("packages/example/package.json", JSON.stringify(manifest));
    await expectPass(f);
    manifest.exports["."].types = `./dist/features/beta/application/private.d.${extension}`;
    await f.write("packages/example/package.json", JSON.stringify(manifest));
    await rejects(f, "module-export");
  });
}
for (const extension of ["mjs", "cjs", "d.ts", "d.mts", "d.cts"]) {
  test(`manifest closes private wildcard .${extension}`, async (t) => {
    const f = await fixture(t);
    await f.write(
      "packages/example/package.json",
      JSON.stringify({
        name: "@fixture/example",
        version: "1.0.0",
        type: "module",
        exports: {
          ".": "./src/index.ts",
          "./private/*": `./dist/features/beta/application/*.${extension}`,
        },
      }),
    );
    await rejects(f, "wildcard-export");
  });
}
for (const bin of [
  "./dist/index.d.ts",
  "./dist/index.d.mts",
  "./dist/index.d.cts",
  "./dist/missing.js",
  "./src/../index.js",
]) {
  test(`manifest rejects non-executable bin ${bin}`, async (t) => {
    const f = await fixture(t);
    await f.write(
      "packages/example/package.json",
      JSON.stringify({
        name: "@fixture/example",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./src/index.ts" },
        bin,
      }),
    );
    await rejects(f, "module-executable");
  });
}
test("nested import-only descendants are empty, and invalid syntax is retained as failure", async (t) => {
  const f = await fixture(t),
    path = `${f.sourceRoot}/features/alpha/application/empty/index.ts`;
  await f.write(path, 'import "../index.js"; export {};');
  await rejects(f, "empty-layer");
  await f.write(path, "export const = ;");
  const result = await f.check();
  assert.equal(result.outcome, "failed");
  assert.ok(result.problems.some(({ message }) => message.includes(path)));
});
for (const entry of ["check", "check:fast"]) {
  for (const command of [
    "true || pnpm architecture:features:check",
    "echo pnpm architecture:features:check",
    "pnpm architecture:features:check || true",
    "pnpm architecture:features:check; true",
  ]) {
    test(`connectivity rejects ${entry}: ${command}`, async (t) => {
      const f = await fixture(t),
        pkg = JSON.parse(await readFile(join(f.repositoryRoot, "package.json"), "utf8"));
      pkg.scripts[entry] = command;
      await f.write("package.json", JSON.stringify(pkg));
      await rejects(f, "enforcement-command");
    });
  }
}

// New independent review findings, qualified against actual tools below.
registerPrimitiveConformanceCases({
  fixture,
  expectPass,
  rejects,
  compileFixture,
  primitiveFixture,
  qualifyPrimitive,
});
registerExecutableArgumentsCases(fixture, expectPass, rejects);
registerAssemblyOverloadsCases(fixture, expectPass, rejects);
registerNamespaceSurfaceCases(workspaceSurface, expectPass, rejects);

registerFactorySurfaceCases({ test, assert, workspaceSurface, rejects, expectPass });

registerFactoryReviewCases({ test, assert });
registerCrossModuleFactoryCases({ test, assert, workspaceSurface });

async function qualifyPrimitive(f, source, expected, lintRule) {
  await f.write(f.record.path, source);
  for (const consumer of f.record.consumers) {
    await f.write(
      consumer.path,
      'import {compare} from "../../../compare.js"; export const execute = () => compare();',
    );
  }
  await compileFixture(f);
  const root = join(import.meta.dirname, "..");
  await symlink(join(root, "node_modules"), join(f.repositoryRoot, "node_modules"), "junction");
  const typed = JSON.parse(await readFile(join(root, ".oxlintrc.type-aware.json"), "utf8"));
  typed.extends = typed.extends.map((path) => join(root, path));
  await f.write("typed.json", JSON.stringify(typed));
  const lint = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/oxlint/bin/oxlint"),
      "--config",
      "typed.json",
      "--deny-warnings",
      "--no-ignore",
      "--disable-nested-config",
      f.record.path,
    ],
    { cwd: f.repositoryRoot, encoding: "utf8" },
  );
  assert.equal(lint.status, lintRule ? 1 : 0, lint.stdout + lint.stderr);
  if (lintRule) {
    assert.match(lint.stdout + lint.stderr, lintRule);
  }
  const compiled = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "-p",
      "tsconfig.json",
      "--noEmit",
      "false",
      "--outDir",
      "compiled",
      "--rootDir",
      "packages/example/src",
      "--pretty",
      "false",
    ],
    { cwd: f.repositoryRoot, encoding: "utf8" },
  );
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const emitted = await readFile(join(f.repositoryRoot, "compiled/compare.js"), "utf8");
  const run = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      emitted + "\nconsole.log(JSON.stringify([compare(), compare()]));",
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), expected);
  return { compile: compiled.status, typedLint: lint.status, runtime: JSON.parse(run.stdout) };
}
