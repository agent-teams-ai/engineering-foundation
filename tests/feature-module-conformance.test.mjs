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
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import { validateFeatureModules } from "../scripts/check-feature-modules.mjs";
import { registerAssemblyFacadeCases } from "./fixtures/feature-modules/assembly-facade-cases.mjs";
import { registerSemverPrimitiveCases } from "./fixtures/feature-modules/semver-cases.mjs";
import { registerPrimitiveErrorCases } from "./fixtures/feature-modules/primitive-error-cases.mjs";
import { registerJsonInspectionCases } from "./fixtures/feature-modules/json-inspection-cases.mjs";
import { registerExecutableArgumentsCases } from "./fixtures/feature-modules/executable-arguments-cases.mjs";
import { registerAssemblyOverloadsCases } from "./fixtures/feature-modules/assembly-overloads-cases.mjs";
import { registerNamespaceSurfaceCases } from "./fixtures/feature-modules/namespace-surface-cases.mjs";

const standard = await readFile(new URL("../standards/feature-module-standard-v1.md", import.meta.url));
const cases = JSON.parse(await readFile(new URL("fixtures/feature-modules/cases.json", import.meta.url), "utf8"));
const boundary = (id, roots, entrypoints) => ({ id, roots, entrypoints, allow: { boundaries: [], packages: [], builtins: [], runtimeReferences: [] } });
async function fixture(t, role = "platform") {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "ef-feature-modules-"));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const root = "packages/example", sourceRoot = `${root}/src`;
  const write = async (path, content) => {
    await mkdir(dirname(join(repositoryRoot, path)), { recursive: true });
    await writeFile(join(repositoryRoot, path), content);
  };
  const features = ["alpha", "beta"].map((id) => ({ id, role, testRoots: ["tests/features/" + id], layers: [
    { role: "application", roots: [`${sourceRoot}/features/${id}/application`] }
  ] }));
  const profile = {
    schemaVersion: 1,
    standard: { id: "agent-teams.feature-module-standard", version: "v1", path: "standard.md", digest: `sha256:${createHash("sha256").update(standard).digest("hex")}` },
    architectureDocument: "architecture.md", decision: "decision.md",
    topology: { packageInventory: "scripts/publishable-packages.mjs", sourcePolicy: "policy.yaml" },
    productionRoots: ["packages"], applicationRoots: [], excludedRoots: [],
    enforcementCommands: ["pnpm architecture:features:check", "pnpm lint:typed", "pnpm architecture:patterns", "pnpm check"],
    localExtensions: { language: "TypeScript ESM", packaging: "pnpm", composition: "explicit", transport: "outer contracts" },
    modules: [{ id: "example", packageName: "@fixture/example", root, sourceRoot, role,
      preferredFeatureRoot: `${sourceRoot}/features`, testRoots: ["tests"], publicEntrypoints: [`${sourceRoot}/index.ts`],
      moduleAssembly: [`${sourceRoot}/index.ts`], generatedRoots: [], exceptions: [], features }]
  };

  const sourcePolicy = { schemaVersion: 2, workspace: { kind: "pnpm", manifest: "pnpm-workspace.yaml" }, packageRoots: ["packages"], governedRoots: [sourceRoot], boundaries: [
    ...features.map(({ id }) => boundary(id, [`${sourceRoot}/features/${id}/application`], [`${sourceRoot}/features/${id}/application/index.ts`])),
    boundary("assembly", [`${sourceRoot}/index.ts`], [`${sourceRoot}/index.ts`])
  ] };
  await write("standard.md", standard);
  await write("architecture.md", "# Local architecture\n[Profile](feature-modules.json)\n");
  await write("tests/features/alpha/contract.test.mjs", "export {};\n");
  await write("tests/features/beta/contract.test.mjs", "export {};\n");
  await write("decision.md", "---\nid: ADR-9999\nstatus: accepted\n---\n# Adoption\n");
  await write("README.md", "[Architecture](architecture.md)\n");
  await write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  await write("package.json", JSON.stringify({ name: "fixture-root", private: true, scripts: { "check:fast": "pnpm architecture:features:check", check: "pnpm architecture:features:check && pnpm lint:typed && pnpm architecture:patterns", "lint:typed": "node scripts/check-production-quality.mjs typed", "architecture:patterns": "node scripts/run-ast-grep.mjs scan --config sgconfig.yml --error=unused-suppression", "architecture:features:check": "node scripts/check-feature-modules.mjs" } }));
  await write(`${root}/package.json`, JSON.stringify({ name: "@fixture/example", version: "1.0.0", type: "module", exports: { ".": "./src/index.ts" } }));
  sourcePolicy.boundaries[2].allow.boundaries.push("alpha");
  await write(`${sourceRoot}/index.ts`, "export { execute } from './features/alpha/application/index.js';\n");
  for (const id of ["alpha", "beta"]) {await write(`${sourceRoot}/features/${id}/application/index.ts`, cases.application);}
  await write(`${sourceRoot}/features/beta/application/private.ts`, cases.private);
  const check = async (productionPackages = [{ name: "@fixture/example", root }]) => {
    await write("profile.json", JSON.stringify(profile));
    await write("policy.yaml", YAML.stringify(sourcePolicy));
    return validateFeatureModules({ repositoryRoot, profilePath: "profile.json", productionPackages });
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
  f.sourcePolicy.boundaries.push({ id: "adapter", roots: [root], entrypoints: [`${root}/read.ts`], allow: { boundaries: [], packages: [], builtins: [], runtimeReferences: [] } });
  f.sourcePolicy.boundaries[0].allow.boundaries.push("adapter");
  await f.write(`${root}/read.ts`, cases.adapter);
  await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`, cases.reverseImport);
  assert.ok((await f.check()).problems.some(({ code }) => code === "layer-direction"));
});

async function rejects(f, code) {
  const result = await f.check();
  assert.ok(result.problems.some((entry) => entry.code === code), JSON.stringify(result));
  assert.ok(!result.problems.some((entry) => entry.code === "input-error"), JSON.stringify(result));
}
test("permits a curated sibling application API and module export", async (t) => {
  const f = await fixture(t);
  f.sourcePolicy.boundaries[0].allow.boundaries.push("beta");
  await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`, "import { execute as beta } from '../../beta/application/index.js';\nexport const execute = () => beta();\n");
  await f.write(`${f.sourceRoot}/index.ts`, "export { execute } from './features/alpha/application/index.js';\n");
  assert.deepEqual((await f.check()).problems, []);
});
test("rejects an actual undeclared import independently of a declared feature graph", async (t) => {
  const f = await fixture(t);
  await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`, "export { execute } from '../../beta/application/index.js';\n");
  await rejects(f, "source-policy");
});
test("rejects a real type-only feature cycle", async (t) => {
  const f = await fixture(t);
  f.sourcePolicy.boundaries[0].allow.boundaries.push("beta");
  f.sourcePolicy.boundaries[1].allow.boundaries.push("alpha");
  await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`, "import type { B } from '../../beta/application/index.js';\nexport interface A { b?: B }\n");
  await f.write(`${f.sourceRoot}/features/beta/application/index.ts`, "import type { A } from '../../alpha/application/index.js';\nexport interface B { a?: A }\n");
  await rejects(f, "feature-cycle");
});
for (const [name, mutate, code] of [
  ["unowned behavior", (f) => f.write(`${f.sourceRoot}/utils.ts`, "export const read = () => 1;\n"), "unowned-source"],
  ["module role", (f) => { f.profile.modules[0].role = "unknown"; }, "module-role"],
  ["missing feature", (f) => { f.profile.modules[0].features = []; }, "feature-required"],
  ["standard digest drift", (f) => { f.profile.standard.digest = "sha256:wrong"; }, "standard-digest"],
  ["unowned executable entrypoint", (f) => f.write("packages/example/package.json", JSON.stringify({ name: "@fixture/example", version: "1.0.0", type: "module", exports: { ".": "./src/index.ts" }, bin: "./scripts/hidden.js" })), "module-executable"],
  ["open package subpaths", (f) => f.write("packages/example/package.json", JSON.stringify({ name: "@fixture/example", version: "1.0.0", type: "module" })), "module-export"],
  ["missing module inventory", (f) => { f.profile.modules = []; }, "module-inventory"],
  ["layer overlap", (f) => { f.profile.modules[0].features[0].layers.push({ role: "adapters", roots: [`${f.sourceRoot}/features/alpha/application/index.ts`] }); }, "overlapping-ownership"],
  ["empty layer", async (f) => {
    f.profile.modules[0].features[0].layers.push({ role: "domain", roots: [`${f.sourceRoot}/features/alpha/domain`] });
    await f.write(`${f.sourceRoot}/features/alpha/domain/.gitkeep`, "");
  }, "empty-layer"],
  ["empty undeclared child layer", (f) => f.write(`${f.sourceRoot}/features/alpha/application/empty/.gitkeep`, ""), "empty-layer"],
  ["primitive without decision", async (f) => {
    const path = `${f.sourceRoot}/clock.ts`;
    f.profile.modules[0].exceptions.push({ path });
    await f.write(path, "export const clock = () => 1;\n");
  }, "invalid-exception"],
  ["blanket primitive exception", (f) => { f.profile.modules[0].exceptions.push({ path: `${f.sourceRoot}/features`, decision: "decision.md", owner: "maintainers", rationale: "convenience", reviewTrigger: "later" }); }, "invalid-exception"],
  ["unapproved scoped exception", async (f) => {
    const path = `${f.sourceRoot}/clock.ts`;
    f.profile.modules[0].exceptions.push({ path, decision: "decision.md", owner: "maintainers", rationale: "primitive", reviewTrigger: "consumer change" });
    await f.write(path, "export const clock = () => 1;\n");
  }, "exception-decision"],
  ["ceremonial shared feature", (f) => { f.profile.modules[0].features[0].id = "shared"; }, "feature-identity"],
  ["assembly hiding behavior", (f) => f.write(`${f.sourceRoot}/index.ts`, "export function calculate(value: number) { if (value > 3) return 9; return 1; }\n"), "assembly-behavior"],
  ["export star surface", (f) => f.write(`${f.sourceRoot}/features/alpha/application/index.ts`, "export * from './private.js';\n"), "uncurated-entrypoint"],
  ["unreachable adoption", (f) => f.write("README.md", "# Missing link\n"), "adoption-reachability"],
  ["gate disconnected", (f) => f.write("package.json", JSON.stringify({ name: "fixture-root", private: true, scripts: { "check:fast": "pnpm architecture:features:check", check: "node -e ''", "architecture:features:check": "node scripts/check-feature-modules.mjs" } })), "enforcement-command"],
  ["broad boundary across features", (f) => { f.sourcePolicy.boundaries[0].roots.push(`${f.sourceRoot}/features/beta/application`); f.sourcePolicy.boundaries.splice(1, 1); }, "boundary-ownership"],
  ["unknown module on disk", (f) => f.write("packages/new/package.json", JSON.stringify({ name: "@fixture/new", version: "1.0.0" })), "source-policy"],
  ["source outside selected roots", (f) => f.write("packages/example/extra.ts", "export const hidden = true;\n"), "source-policy"],
  ["transport contracts in application", async (f) => {
    const root = `${f.sourceRoot}/features/alpha/contracts`;
    f.profile.modules[0].features[0].layers.push({ role: "contracts", roots: [root] });
    f.sourcePolicy.boundaries.push({ id: "contracts", roots: [root], entrypoints: [`${root}/index.ts`], allow: { boundaries: [], packages: [], builtins: [], runtimeReferences: [] } });
    f.sourcePolicy.boundaries[0].allow.boundaries.push("contracts");
    await f.write(`${root}/index.ts`, "export interface Transport { value: string }\n");
    await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`, "import type { Transport } from '../contracts/index.js';\nexport const execute = (x: Transport) => x.value;\n");
  }, "layer-direction"]
]) {test(`rejects ${name}`, async (t) => { const f = await fixture(t); await mutate(f); await rejects(f, code); });}

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
  assert.throws(() => planFeature(f.profile, "example", "../escape", "double", source), /kebab-case/u);
  for (const write of plan.writes) {await f.write(write.path, write.content);}
  await f.write("packages/example/tests/features/doubling/contract.test.mjs", "export {};\n");
  f.profile.modules[0].features.push(plan.profileEntry);
  f.sourcePolicy.boundaries.push(plan.sourcePolicyBoundary, plan.testPolicyBoundary);
  f.sourcePolicy.governedRoots.push(...plan.additionalGovernedRoots);
  assert.deepEqual((await f.check()).problems, []);
});

test("rejects a layer containing only empty modules", async (t) => {
  const f = await fixture(t);
  await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`, "// no owned artifact\nexport {};\n");
  await rejects(f, "empty-layer");
});
test("rejects a primitive decision whose accepted status is prose only", async (t) => {
  const f = await fixture(t);
  const path = `${f.sourceRoot}/clock.ts`;
  f.profile.modules[0].exceptions.push({ path, decision: "decision.md", owner: "maintainers", rationale: "test", reviewTrigger: "change" });
  await f.write(path, "export const instant = 1;\n");
  await f.write("decision.md", `# Proposed decision\nstatus: accepted\n${path}\n`);
  await rejects(f, "exception-decision");
});

test("CLI plans caller bytes through the documented pnpm separator without mutation", async (t) => {
  const f = await fixture(t);
  const input = "export const inspect = (path: string): boolean => path.endsWith('.ts');\n";
  await f.write("inspect.ts", input);
  const args = [join(import.meta.dirname, "../scripts/check-feature-modules.mjs"), "plan", "--", "engineering-foundation", "path-inspection", "inspect", "--from", join(f.repositoryRoot, "inspect.ts")];
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.writes[0].content, input);
  assert.equal(plan.writes[0].path, "packages/engineering-foundation/src/features/path-inspection/application/inspect.ts");
  assert.equal(await readFile(join(f.repositoryRoot, "inspect.ts"), "utf8"), input);
  args[3] = "unknown-module";
  const invalid = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /Unknown module/u);
});

// Promoted independent guard review regressions and controls.
const expectPass = async (f) => assert.deepEqual((await f.check()).problems, []);
for(const role of ['domain','platform','integration','sdk','testing']) {test(`CONTROL valid ${role} feature`,async t=>expectPass(await fixture(t,role)));}
for(const ext of ['mts','cts']) {test(`CONTROL unowned .${ext} source is discovered`,async t=>{
 const f=await fixture(t); await f.write(`${f.sourceRoot}/orphan.${ext}`,'export const behavior = () => 1;\n'); await rejects(f,'unowned-source');
});}
test('FN assembly inline call must not conceal behavior',async t=>{
 const f=await fixture(t);await f.write(`${f.sourceRoot}/index.ts`,'export const execute = (value: number) => (() => { if(value < 0) throw new Error("invalid"); return value * 2; })();\n');await rejects(f,'assembly-behavior');
});
test('FN assembly delegated argument must not contain policy',async t=>{
 const f=await fixture(t);await f.write(`${f.sourceRoot}/index.ts`,'import {execute as run} from "./features/alpha/application/index.js";\nexport const execute = (value: number) => run(value < 0 ? 0 : value * 2);\n');await rejects(f,'assembly-behavior');
});
test('FP composition type declaration is not behavior',async t=>{
 const f=await fixture(t);await f.write(`${f.sourceRoot}/index.ts`,'import {execute as run} from "./features/alpha/application/index.js";\ntype Execute = typeof run;\nexport const execute: Execute = run;\n');await expectPass(f);
});
test('FP feature-owned domain declaration is allowed',async t=>{
 const f=await fixture(t,'domain'); const d=`${f.sourceRoot}/features/alpha/domain`;
 f.profile.modules[0].features[0].layers.push({role:'domain',roots:[d]});f.sourcePolicy.boundaries.push(boundary('alpha-domain',[d],[`${d}/index.ts`]));
 await f.write(`${d}/index.ts`,'export interface Quantity { readonly value: number }\n');await expectPass(f);
});
test('FN export-star-as namespace is not a curated surface',async t=>{
 const f=await fixture(t);await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`,'export * as all from "./private.js";\n');await f.write(`${f.sourceRoot}/features/alpha/application/private.ts`,'export const execute = () => 1;\n');await rejects(f,'uncurated-entrypoint');
});
for(const ext of ['mts','cts']) {test(`FN private .${ext} manifest wildcard must be closed`,async t=>{
 const f=await fixture(t);await f.write(`${f.sourceRoot}/features/beta/application/private.${ext}`,'export const hidden = () => 1;\n');
 await f.write('packages/example/package.json',JSON.stringify({name:'@fixture/example',version:'1.0.0',type:'module',exports:{'.':'./src/index.ts','./hidden/*':`./src/features/beta/application/*.${ext}`}}));await rejects(f,'wildcard-export');
});}
test('FN nested empty module is a ceremonial layer',async t=>{
 const f=await fixture(t);await f.write(`${f.sourceRoot}/features/alpha/application/empty/index.ts`,'export {};\n');await rejects(f,'empty-layer');
});
test('FP approved pure primitive is usable by the application',async t=>{
 await expectPass(await primitiveFixture(t));
});
test('FN echo guard name is not guard execution',async t=>{
 const f=await fixture(t);await f.write('package.json',JSON.stringify({name:'fixture-root',private:true,scripts:{"check:fast":"pnpm architecture:features:check",check:'pnpm architecture:features:check','architecture:features:check':'echo check-feature-modules.mjs'}}));await rejects(f,'enforcement-command');
});

// Promoted independent edge review regressions and controls.
test('FN application can consume a workspace concrete filesystem adapter', async t=>{
 const f=await fixture(t);const root='packages/other',src=`${root}/src`;
 f.profile.modules.push({id:'other',packageName:'@fixture/other',root,sourceRoot:src,role:'platform',preferredFeatureRoot:`${src}/features`,testRoots:['tests'],publicEntrypoints:[`${src}/index.ts`],moduleAssembly:[`${src}/index.ts`],generatedRoots:[],exceptions:[],features:[{id:'storage',role:'platform',testRoots:['tests'],layers:[{role:'adapters',roots:[`${src}/features/storage/adapters`]}]}]});
 await f.write(`${root}/package.json`,JSON.stringify({name:'@fixture/other',version:'1.0.0',type:'module',exports:{'.':'./src/index.ts'}}));
 await f.write('packages/example/package.json',JSON.stringify({name:'@fixture/example',version:'1.0.0',type:'module',exports:{'.':'./src/index.ts'},dependencies:{'@fixture/other':'workspace:*'}}));
 await f.write(`${src}/index.ts`,'export {read} from "./features/storage/adapters/read.js";\n');
 await f.write(`${src}/features/storage/adapters/read.ts`,'import {readFileSync} from "node:fs";\nexport const read = (path:string) => readFileSync(path,"utf8");\n');
 f.sourcePolicy.governedRoots.push(src);f.sourcePolicy.boundaries.push({...boundary('other-assembly',[`${src}/index.ts`],[`${src}/index.ts`]),allow:{boundaries:['storage'],packages:[],builtins:[],runtimeReferences:[]}},{...boundary('storage',[`${src}/features/storage/adapters`],[`${src}/features/storage/adapters/read.ts`]),allow:{boundaries:[],packages:[],builtins:['node:fs'],runtimeReferences:[]}});
 f.sourcePolicy.boundaries[0].allow.packages.push('@fixture/other');
 await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`,'import {read} from "@fixture/other";\nexport const execute = () => read("secret.txt");\n');
 const result=await f.check([{name:'@fixture/example',root:'packages/example'},{name:'@fixture/other',root:'packages/other'}]);
 assert.ok(result.problems.some(p=>p.code==='inner-infrastructure'||p.code==='layer-direction'),JSON.stringify(result));
});
test('FP pure generated feature data may feed its owning application',async t=>{
 const f=await fixture(t);const p=`${f.sourceRoot}/features/alpha/generated/canonical.ts`;
 f.profile.modules[0].generatedRoots.push({root:`${f.sourceRoot}/features/alpha/generated`,generator:"generator.mjs",sources:["input.txt"]});
 f.profile.modules[0].features[0].layers[0].roots.push(`${f.sourceRoot}/features/alpha/generated`);
 await f.write("generator.mjs", "// fixture generator identity\n"); await f.write("input.txt", "exact-canonical-bytes");
 await f.write(p,'export const canonical = "exact-canonical-bytes";\n');f.sourcePolicy.boundaries.push(boundary('generated',[p],[p]));f.sourcePolicy.boundaries[0].allow.boundaries.push('generated');
 await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`,'import {canonical} from "../generated/canonical.js";\nexport const execute = () => canonical.length;\n');await expectPass(f);
});
test('FP deterministic hash is not ambient randomness or IO',async t=>{
 const f=await fixture(t);f.sourcePolicy.boundaries[0].allow.builtins.push('node:crypto');await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`,'import {createHash} from "node:crypto";\nexport const execute = (bytes:Uint8Array) => createHash("sha256").update(bytes).digest("hex");\n');await expectPass(f);
});
test('CONTROL random crypto operation in application remains forbidden',async t=>{
 const f=await fixture(t);f.sourcePolicy.boundaries[0].allow.builtins.push('node:crypto');await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`,'import {randomUUID} from "node:crypto";\nexport const execute = () => randomUUID();\n');await rejects(f,'inner-infrastructure');
});
test('CONTROL metadata reader belongs to an adapter',async t=>{
 const f=await fixture(t);const p=`${f.sourceRoot}/features/alpha/adapters/version.ts`;
 f.profile.modules[0].features[0].layers.push({role:'adapters',roots:[p]});f.sourcePolicy.boundaries.push({...boundary('metadata',[p],[p]),allow:{boundaries:[],packages:[],builtins:['node:fs'],runtimeReferences:[]}});
 await f.write(p,'import {readFileSync} from "node:fs";\nexport const version = JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")).version;\n');await expectPass(f);
});
test('unresolved JSON module loading remains visible to the feature guard',async t=>{
 const f=await fixture(t);const p=`${f.sourceRoot}/features/alpha/adapters/version.ts`;
 f.profile.modules[0].features[0].layers.push({role:'adapters',roots:[p]});f.sourcePolicy.boundaries.push({...boundary('metadata',[p],[p]),allow:{boundaries:[],packages:[],builtins:['node:module'],runtimeReferences:[]}});
 // The previous control passed only because this nested loader was invisible.
 // Data observation above is supported; this non-source module has no graph target.
 await f.write(p,'import {createRequire} from "node:module";\nexport const version = createRequire(import.meta.url)("../../../../../package.json").version;\n');
 const result=await f.check();
 assert.ok(result.problems.some(({code,message})=>code==='source-policy' && message.includes('unresolved-local-import') && message.includes('package.json')));
});

// Promoted independent executable review regressions and controls.
test('FP thin executable invokes feature entrypoint',async t=>{
 const f=await fixture(t);const cli=`${f.sourceRoot}/cli.ts`;
 f.profile.modules[0].moduleAssembly.push(cli);f.sourcePolicy.boundaries.push({...boundary('cli',[cli],[cli]),allow:{boundaries:['alpha'],packages:[],builtins:[],runtimeReferences:[]}});
 await f.write('packages/example/package.json',JSON.stringify({name:'@fixture/example',version:'1.0.0',type:'module',exports:{'.':'./src/index.ts'},bin:{example:'./src/cli.ts'}}));
 await f.write(cli,'import { execute } from "./features/alpha/application/index.js";\nvoid execute();\n');await expectPass(f);
});

// Promoted independent gate review regressions and controls.
test('FN successful short circuit must not bypass guard', async t=>{
 const f=await fixture(t);await f.write('package.json',JSON.stringify({name:'fixture-root',private:true,scripts:{"check:fast":"pnpm architecture:features:check",check:'true || pnpm architecture:features:check','architecture:features:check':'node scripts/check-feature-modules.mjs'}}));await rejects(f,'enforcement-command');
});
test('CONTROL failing prerequisite stays a failed gate, not a guard bypass',async t=>{
 const f=await fixture(t);const command='false && pnpm architecture:features:check';
 const processResult=spawnSync(command,[],{cwd:f.repositoryRoot,encoding:'utf8',shell:true});assert.equal(processResult.status,1);
 const pkg=JSON.parse(await readFile(join(f.repositoryRoot,"package.json"),"utf8"));
 pkg.scripts.check=`false && ${pkg.scripts.check}`;
 await f.write("package.json",JSON.stringify(pkg)); await expectPass(f);
});

// Promoted independent transport review regressions and controls.
for(const layer of ['adapters','application']){test(`CONTROL transport SDK types in ${layer}`,async t=>{
 const f=await fixture(t);const dir=`${f.sourceRoot}/features/alpha/${layer}`;
 if(layer==='adapters'){f.profile.modules[0].features[0].layers.push({role:'adapters',roots:[dir]});f.sourcePolicy.boundaries.push(boundary('adapter',[dir],[`${dir}/index.ts`]));}
 const b=f.sourcePolicy.boundaries.find(x=>x.roots.includes(dir));b.allow.packages.push('@modelcontextprotocol/server');
 await f.write('packages/example/package.json',JSON.stringify({name:'@fixture/example',version:'1.0.0',type:'module',exports:{'.':'./src/index.ts'},dependencies:{'@modelcontextprotocol/server':'1.0.0'}}));
 await f.write(`${dir}/index.ts`,'import type { CallToolResult } from "@modelcontextprotocol/server";\nexport const execute = (value:CallToolResult) => value;\n');
 if(layer==='adapters'){await expectPass(f);}else{await rejects(f,'inner-infrastructure');}
});}

// Promoted independent typed-assembly review regressions and controls.
test('FN typed-compatible delegated argument still conceals assembly policy',async t=>{
 const f=await fixture(t);
 await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`,'export const execute = (value:number):number => value;\n');
 await f.write(`${f.sourceRoot}/index.ts`,'import {execute as run} from "./features/alpha/application/index.js";\nexport const execute = (value: number):number => run(value < 0 ? 0 : value * 2);\n');
 await f.write('tsconfig.json',JSON.stringify({compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',strict:true,noEmit:true,types:[]},include:['packages/example/src/**/*.ts']}));
 const compiled=spawnSync('node',[join(import.meta.dirname, "../node_modules/typescript/bin/tsc"),'-p',join(f.repositoryRoot,'tsconfig.json'),'--pretty','false'],{cwd:f.repositoryRoot,encoding:'utf8'});
 await f.write('typecheck-result.json',JSON.stringify({status:compiled.status,stdout:compiled.stdout,stderr:compiled.stderr},null,2));
 assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
 await rejects(f,'assembly-behavior');
});

async function workspaceSurface(t, consumer, publicSource) {
  const f = await fixture(t), root = "packages/other", src = `${root}/src`;
  const module = { id: "other", packageName: "@fixture/other", root, sourceRoot: src, role: "platform",
    preferredFeatureRoot: `${src}/features`, publicEntrypoints: [`${src}/index.ts`], moduleAssembly: [`${src}/index.ts`],
    generatedRoots: [], exceptions: [], features: [{ id: "storage", role: "platform", testRoots: ["tests"], layers: [] }] };
  f.profile.modules.push(module);
  const otherAssembly = boundary("other-assembly", [`${src}/index.ts`], [`${src}/index.ts`]);
  f.sourcePolicy.boundaries.push(otherAssembly);
  f.sourcePolicy.governedRoots.push(src);
  const declarations = {
    domain: 'export const compare = (a:string,b:string) => a < b ? -1 : a > b ? 1 : 0; export interface Token { readonly value: string }',
    application: 'export const inspect = (value:string) => value.length;',
    adapters: 'import {readFileSync} from "node:fs"; export const read = (path:string) => readFileSync(path,"utf8"); export interface ReadAdapter { read: typeof read }',
    contracts: 'export interface Transport { payload: string }'
  };
  for (const [role, source] of Object.entries(declarations)) {
    const layerRoot = `${src}/features/storage/${role}`, path = `${layerRoot}/index.ts`;
    module.features[0].layers.push({ role, roots: [layerRoot] });
    const entry = boundary(`other-${role}`, [layerRoot], [path]);
    if (role === "adapters") {entry.allow.builtins.push("node:fs");}
    f.sourcePolicy.boundaries.push(entry);
    otherAssembly.allow.boundaries.push(entry.id);
    await f.write(path, source);
  }
  await f.write(`${root}/package.json`, JSON.stringify({ name: "@fixture/other", version: "1.0.0", type: "module", exports: { ".": "./src/index.ts" } }));
  await f.write("packages/example/package.json", JSON.stringify({ name: "@fixture/example", version: "1.0.0", type: "module", exports: { ".": "./src/index.ts" }, dependencies: { "@fixture/other": "workspace:*" } }));
  await f.write(`${src}/index.ts`, publicSource ?? 'export {compare, type Token} from "./features/storage/domain/index.js"; export {read, type ReadAdapter} from "./features/storage/adapters/index.js"; export {inspect} from "./features/storage/application/index.js"; export type {Transport} from "./features/storage/contracts/index.js";');
  await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`, consumer);
  f.sourcePolicy.boundaries[0].allow.packages.push("@fixture/other");
  return { ...f, module, otherAssembly, check: () => f.check([{ name: "@fixture/example", root: "packages/example" }, { name: "@fixture/other", root }]) };
}
for (const [label, consumer, rejection] of [
  ["pure function from mixed root", 'import {compare} from "@fixture/other"; export const execute = () => compare("a","b");'],
  ["opaque stable type", 'import type {Token} from "@fixture/other"; export type Execute = Token;'],
  ["pure named re-export", 'export {compare as execute} from "@fixture/other";'],
  ["opaque type re-export", 'export type {Token as Execute} from "@fixture/other";'],
  ["pure import type query", 'export type Execute = import("@fixture/other").Token;'],
  ["concrete adapter type", 'import type {ReadAdapter} from "@fixture/other"; export type Execute = ReadAdapter;', "layer-direction"],
  ["concrete adapter re-export", 'export {read as execute} from "@fixture/other";', "layer-direction"],
  ["concrete adapter type re-export", 'export type {ReadAdapter} from "@fixture/other";', "layer-direction"],
  ["concrete adapter import type query", 'export type Execute = import("@fixture/other").ReadAdapter;', "layer-direction"],
  ["transport type", 'import type {Transport} from "@fixture/other"; export type Execute = Transport;', "layer-direction"],
  ["mixed namespace", 'import * as api from "@fixture/other"; export const execute = api.read;', "layer-direction"],
  ["unknown binding", 'export {missing as execute} from "@fixture/other";', "surface-ownership"]
]) {test(`workspace surface: ${label}`, async (t) => {
  const f = await workspaceSurface(t, consumer);
  if (rejection) {await rejects(f, rejection);} else {await expectPass(f);}
});}
test("workspace ownership follows a named imported alias and rejects its adapter origin", async (t) => {
  const f = await workspaceSurface(t, 'import {execute} from "@fixture/other"; export {execute};',
    'import {read} from "./features/storage/adapters/index.js"; const alias = read; export {alias as execute};');
  await rejects(f, "layer-direction");
});
test("workspace pure primitive keeps exact direct and public-surface consumers", async (t) => {
  const f = await workspaceSurface(t, 'export {compare as execute} from "@fixture/other";',
    'export {compare} from "./features/storage/domain/index.js";');
  const path = "packages/other/src/features/storage/domain/index.ts";
  f.module.features[0].layers = f.module.features[0].layers.filter(({ role }) => role !== "domain");
  f.sourcePolicy.boundaries.find(({ id }) => id === "other-domain").roots = [path];
  const record = await primitiveDecision(f, path, [
    { path: "packages/other/src/index.ts", owner: "other/@assembly" },
    { path: `${f.sourceRoot}/features/alpha/application/index.ts`, owner: "example/alpha" }
  ]);
  f.module.exceptions.push(record);
  await f.write(path, 'export const compare = (a:string,b:string) => a < b ? -1 : a > b ? 1 : 0;');
  await expectPass(f);
  await f.write(path, 'export const compare = (a:string,b:string) => a < b ? -1 : a > b ? 1 : 0; export type Token = string;');
  await f.write("packages/other/src/index.ts", 'export {compare} from "./features/storage/domain/index.js"; export type {Token} from "./features/storage/domain/index.js";');
  for (const source of ['import type {Token} from "@fixture/other"; export type Execute = Token;', 'export type Execute = typeof import("@fixture/other").compare;']) {
    await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`, source); await expectPass(f);
  }
  record.consumers.pop();
  await rejects(f, "primitive-consumer");
});
test("workspace pure default and namespace surfaces retain their owned semantics", async (t) => {
  const f = await workspaceSurface(t, 'import compare from "@fixture/other"; export const execute = () => compare("a","b");',
    'export {compare as default} from "./features/storage/domain/index.js";');
  await expectPass(f);
  await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`, 'import * as api from "@fixture/other"; export const execute = () => api.default("a","b");');
  await expectPass(f);
});
test("workspace derived assembly types retain the imported semantic owner", async (t) => {
  const f = await workspaceSurface(t, 'export type {Operation as Execute} from "@fixture/other";',
    'import {compare} from "./features/storage/domain/index.js"; export type Operation = typeof compare;');
  await expectPass(f);
  await f.write("packages/other/src/index.ts", 'import {read} from "./features/storage/adapters/index.js"; export type Operation = typeof read;');
  await rejects(f, "layer-direction");
});
test("workspace feature-owned generic data types keep their owner", async (t) => {
  const f = await workspaceSurface(t, 'export type {Token as Execute} from "@fixture/other";',
    'export type {Token} from "./features/storage/domain/index.js";');
  await f.write("packages/other/src/features/storage/domain/index.ts", 'export type Token = Readonly<{value:string}>;');
  await expectPass(f);
});
test("workspace dist ownership uses manifest exports and the exact packageExports claim", async (t) => {
  const f = await workspaceSurface(t, 'import {compare} from "@fixture/other"; export const execute = () => compare("a","b");');
  await f.write("packages/other/package.json", JSON.stringify({ name: "@fixture/other", version: "1.0.0", type: "module", exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } } }));
  f.otherAssembly.packageExports = ["."];
  await expectPass(f);
  f.sourcePolicy.boundaries.find(({ id }) => id === "other-domain").packageExports = ["."];
  assert.equal((await f.check()).outcome, "failed", "duplicate export owners must fail closed");
});
test("workspace source projection rejects a contradictory export claim", async (t) => {
  const f = await workspaceSurface(t, 'export {compare as execute} from "@fixture/other";');
  await f.write("packages/other/package.json", JSON.stringify({ name: "@fixture/other", version: "1.0.0", type: "module", exports: { ".": "./dist/index.js" } }));
  f.sourcePolicy.boundaries.find(({ id }) => id === "other-domain").packageExports = ["."];
  await rejects(f, "surface-ownership");
});
for (const [role, binding, permitted] of [["domain", "compare", true], ["domain", "inspect", false], ["adapters", "inspect", true], ["adapters", "read", true]]) {
  test(`workspace ${role} access to ${binding} preserves its semantic direction`, async (t) => {
    const f = await workspaceSurface(t, `export {${binding} as execute} from "@fixture/other";`);
    f.profile.modules[0].features[0].layers[0].role = role;
    if (permitted) {await expectPass(f);} else {await rejects(f, "layer-direction");}
  });
}
for (const [label, source] of [
  ["shadowed import", 'export const execute = (run: () => number) => run();'],
  ["nested callback", 'export const execute = () => run(() => 123);'],
  ["computed wiring key", 'export const execute = (value: string) => run({[value]: 1});'],
  ["getter policy", 'export const execute = () => run({get value() {return 123;}});'],
  ["IIFE in argument", 'export const execute = () => run((() => 123)());'],
  ["computed callee", 'export const execute = (value: string) => run[value]();'],
  ["local model", 'export interface Request { amount: number }'],
  ["local type policy", 'type Execute = { amount: number }; export const execute = run;'],
  ["literal policy record", 'export const execute = { enabled: true };'],
  ["named expression shadows import", 'export const execute = function run() {return run();};']
]) {test(`assembly rejects ${label}`, async (t) => {
  const f = await fixture(t);
  await f.write(`${f.sourceRoot}/index.ts`, `import {execute as run} from "./features/alpha/application/index.js";\n${source}`);
  await rejects(f, "assembly-behavior");
});}
test("assembly permits imported factories and explicit dependency wiring", async (t) => {
  const f = await fixture(t);
  await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`, 'export const create = (input: {value:number}) => ({value:input.value});');
  await f.write(`${f.sourceRoot}/index.ts`, 'import {create} from "./features/alpha/application/index.js"; export function execute(input: {value:number}) {return create({value:input.value});}');
  await expectPass(f);
});
test("only a designated executable may start resources, await readiness and dispose", async (t) => {
  const f = await fixture(t), cli = `${f.sourceRoot}/cli.ts`;
  f.profile.modules[0].moduleAssembly.push(cli);
  const entry = boundary("cli", [cli], [cli]); entry.allow.boundaries.push("alpha");
  f.sourcePolicy.boundaries.push(entry);
  await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`, 'export const create = () => ({start:async()=>{}, ready:async()=>{}, dispose:async()=>{}});');
  await f.write(cli, 'import {create} from "./features/alpha/application/index.js"; const app = create(); try {await app.start(); await app.ready();} finally {await app.dispose();}');
  await rejects(f, "assembly-behavior");
  await f.write("packages/example/package.json", JSON.stringify({ name: "@fixture/example", version: "1.0.0", type: "module", exports: { ".": "./src/index.ts" }, bin: { example: "./src/cli.ts" } }));
  await expectPass(f);
});

async function primitiveDecision(f, path, consumers, semantics = "Ordinal string comparison") {
  const record = { path, role: "domain", decision: "primitive.md", consumers };
  const scope = { semantics, owner: "platform-maintainers",
    rationale: "One ordering concept; duplication would break interoperability",
    purity: "Deterministic explicit inputs, no ambient or shared mutable state",
    versioning: "Version semantic changes with a successor decision and parity evidence",
    reviewTrigger: "Successor decision for semantic scope, owner, versioning or consuming feature/module changes",
    consumers: [...new Set(consumers.map((consumer) => consumer.owner))] };
  await f.write(record.decision, `---\n${YAML.stringify({ id: "ADR-9998", status: "accepted", primitiveScopes: { [path]: scope } })}---\n# Fixture decision only\n`);
  return record;
}
async function primitiveFixture(t, semantics) {
  const f = await fixture(t), path = `${f.sourceRoot}/compare.ts`;
  const record = await primitiveDecision(f, path, ["alpha", "beta"].map((id) => ({
    path: `${f.sourceRoot}/features/${id}/application/index.ts`, owner: `example/${id}`
  })), semantics);
  f.profile.modules[0].exceptions.push(record);
  await f.write(path, 'export const compare = (a:string,b:string) => a < b ? -1 : a > b ? 1 : 0;');
  f.sourcePolicy.boundaries.push(boundary("primitive", [path], [path]));
  for (const [index, consumer] of record.consumers.entries()) {
    f.sourcePolicy.boundaries[index].allow.boundaries.push("primitive");
    await f.write(consumer.path, 'import {compare} from "../../../compare.js"; export const execute = () => compare("a","b");');
  }
  return { ...f, record };
}

registerSemverPrimitiveCases(primitiveFixture, expectPass, rejects, qualifyPrimitive);
registerPrimitiveErrorCases(primitiveFixture, expectPass, rejects, qualifyPrimitive);
registerJsonInspectionCases(primitiveFixture, expectPass, rejects);
registerAssemblyFacadeCases(fixture, expectPass, rejects, compileFixture);

test("primitive admission rejects an undeclared consumer even with a source-policy edge", async (t) => {
  const f = await primitiveFixture(t); f.record.consumers.pop();
  await rejects(f, "primitive-consumer");
});
test("primitive admission requires actual current use by every listed consumer", async (t) => {
  const f = await primitiveFixture(t);
  await f.write(f.record.consumers[1].path, "export const execute = () => 1;");
  await rejects(f, "primitive-consumer");
});
for (const source of ['export const compare = () => Date.now();', 'export const compare = () => Math.random();', 'let counter = 0; export const compare = () => ++counter;']) {
  test(`primitive rejects impurity: ${source}`, async (t) => {
    const f = await primitiveFixture(t); await f.write(f.record.path, source); await rejects(f, "impure-primitive");
  });
}
test("primitive does not waive filesystem or reverse feature imports", async (t) => {
  const f = await primitiveFixture(t), entry = f.sourcePolicy.boundaries.at(-1);
  entry.allow.builtins.push("node:fs");
  await f.write(f.record.path, 'import {readFileSync} from "node:fs"; export const compare = () => readFileSync("data");');
  await rejects(f, "inner-infrastructure");
  entry.allow.boundaries.push("alpha");
  await f.write(f.record.path, 'import {execute} from "./features/alpha/application/index.js"; export const compare = execute;');
  await rejects(f, "layer-direction");
});
for (const source of [
  'import {randomUUID} from "node:crypto"; export const execute = randomUUID;',
  'import {createHash} from "node:crypto"; export const execute = createHash;',
  'import {createHash} from "node:crypto"; export const execute = (algorithm:string, bytes:Uint8Array) => createHash(algorithm).update(bytes).digest("hex");',
  'import * as crypto from "node:crypto"; export const execute = () => crypto.randomUUID();',
  'import {createHash} from "node:crypto"; export const execute = (createHash:Function, bytes:Uint8Array) => createHash("sha256").update(bytes).digest("hex");'
]) {test(`crypto operation remains bounded: ${source}`, async (t) => {
  const f = await fixture(t); f.sourcePolicy.boundaries[0].allow.builtins.push("node:crypto");
  await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`, source); await rejects(f, "inner-infrastructure");
});}
test("renamed fixed explicit-byte hash remains pure", async (t) => {
  const f = await fixture(t); f.sourcePolicy.boundaries[0].allow.builtins.push("node:crypto");
  await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`, 'import {createHash as hash} from "node:crypto"; export const execute = (bytes:Uint8Array) => hash("sha256").update(bytes).digest("hex");');
  await expectPass(f);
});

async function generatedFixture(t) {
  const f = await fixture(t), root = `${f.sourceRoot}/features/alpha/generated`, path = `${root}/data.ts`;
  f.profile.modules[0].features[0].layers[0].roots.push(root);
  f.profile.modules[0].generatedRoots.push({ root, generator: "generate.mjs", sources: ["input.json"] });
  await f.write("generate.mjs", "// Fixture generator identity"); await f.write("input.json", '{"value":1}');
  await f.write(path, "export const value = 1;");
  const entry = boundary("generated", [root], [path]); f.sourcePolicy.boundaries.push(entry);
  return { ...f, generatedPath: path, generatedBoundary: entry };
}
test("generated application source retains forbidden imports and feature cycles", async (t) => {
  const f = await generatedFixture(t);
  await expectPass(f);
  f.generatedBoundary.allow.builtins.push("node:fs");
  await f.write(f.generatedPath, 'import {readFileSync} from "node:fs"; export const value = readFileSync("data");');
  await rejects(f, "inner-infrastructure");
  await f.write(f.generatedPath, 'import {execute} from "../../beta/application/index.js"; export const value = execute();');
  f.generatedBoundary.allow.boundaries.push("beta"); f.sourcePolicy.boundaries[1].allow.boundaries.push("generated");
  await f.write(`${f.sourceRoot}/features/beta/application/index.ts`, 'import {value} from "../../alpha/generated/data.js"; export const execute = () => value;');
  await rejects(f, "feature-cycle");
});
test("generated provenance cannot replace semantic ownership or omit source identities", async (t) => {
  const f = await generatedFixture(t);
  f.profile.modules[0].features[0].layers[0].roots.pop();
  await rejects(f, "generated-root");
  f.profile.modules[0].features[0].layers[0].roots.push(f.profile.modules[0].generatedRoots[0].root);
  f.profile.modules[0].generatedRoots[0].sources = [];
  await rejects(f, "generated-provenance");
});
for (const [extension, emitted] of [["ts", "js"], ["mts", "mjs"], ["cts", "cjs"]]) {
  test(`manifest conditional .${emitted}/.d.${extension} exports and bin use the exact source owner`, async (t) => {
    const f = await fixture(t), source = `${f.sourceRoot}/entry.${extension}`;
    f.profile.modules[0].publicEntrypoints.push(source); f.profile.modules[0].moduleAssembly.push(source);
    const entry = boundary("entry", [source], [source]); entry.allow.boundaries.push("alpha"); f.sourcePolicy.boundaries.push(entry);
    await f.write(source, 'export {execute} from "./features/alpha/application/index.js";');
    const manifest = { name: "@fixture/example", version: "1.0.0", type: "module", exports: { ".": { types: `./dist/entry.d.${extension}`, import: `./dist/entry.${emitted}`, require: `./dist/entry.${emitted}` }, "./schema": "./schema.json" }, bin: `./dist/entry.${emitted}` };
    await f.write("packages/example/schema.json", "{}"); await f.write("packages/example/package.json", JSON.stringify(manifest));
    await expectPass(f);
    manifest.exports["."].types = `./dist/features/beta/application/private.d.${extension}`;
    await f.write("packages/example/package.json", JSON.stringify(manifest)); await rejects(f, "module-export");
  });
}
for (const extension of ["mjs", "cjs", "d.ts", "d.mts", "d.cts"]) {
  test(`manifest closes private wildcard .${extension}`, async (t) => {
    const f = await fixture(t);
    await f.write("packages/example/package.json", JSON.stringify({ name: "@fixture/example", version: "1.0.0", type: "module", exports: { ".": "./src/index.ts", "./private/*": `./dist/features/beta/application/*.${extension}` } }));
    await rejects(f, "wildcard-export");
  });
}
for (const bin of ["./dist/index.d.ts", "./dist/index.d.mts", "./dist/index.d.cts", "./dist/missing.js", "./src/../index.js"]) {
  test(`manifest rejects non-executable bin ${bin}`, async (t) => {
    const f = await fixture(t);
    await f.write("packages/example/package.json", JSON.stringify({ name: "@fixture/example", version: "1.0.0", type: "module", exports: { ".": "./src/index.ts" }, bin }));
    await rejects(f, "module-executable");
  });
}
test("nested import-only descendants are empty, and invalid syntax is retained as failure", async (t) => {
  const f = await fixture(t), path = `${f.sourceRoot}/features/alpha/application/empty/index.ts`;
  await f.write(path, 'import "../index.js"; export {};'); await rejects(f, "empty-layer");
  await f.write(path, "export const = ;");
  const result = await f.check(); assert.equal(result.outcome, "failed");
  assert.ok(result.problems.some(({ message }) => message.includes(path)));
});
for (const entry of ["check", "check:fast"]) {
  for (const command of ["true || pnpm architecture:features:check", "echo pnpm architecture:features:check", "pnpm architecture:features:check || true", "pnpm architecture:features:check; true"]) {
    test(`connectivity rejects ${entry}: ${command}`, async (t) => {
      const f = await fixture(t), pkg = JSON.parse(await readFile(join(f.repositoryRoot, "package.json"), "utf8"));
      pkg.scripts[entry] = command; await f.write("package.json", JSON.stringify(pkg)); await rejects(f, "enforcement-command");
    });
  }
}

// New independent review findings, qualified against actual tools below.
async function compileFixture(f) {
  await f.write("tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, types: [] }, include: ["packages/**/*.ts"] }));
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "../node_modules/typescript/bin/tsc"), "-p", join(f.repositoryRoot, "tsconfig.json"), "--pretty", "false"], { cwd: f.repositoryRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}
for (const [label, source] of [
  ["const object increment", "const state = {count: 0}; export const compare = () => ++state.count;"],
  ["const array push", "const state: number[] = []; export const compare = () => {state.push(1); return state.length;};"],
  ["const function object escape", 'const state = () => 0; export const compare = () => {const count = Reflect.get(state, "count") ?? 0; Reflect.set(state, "count", count + 1); return count + 1;};']
]) {test(`primitive rejects runtime state: ${label}`, async (t) => {
  const f = await primitiveFixture(t); await expectPass(f);
  await f.write(f.record.path, source);
  for (const consumer of f.record.consumers) {await f.write(consumer.path, 'import {compare} from "../../../compare.js"; export const execute = () => compare();');}
  await compileFixture(f);
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", `import {compare} from ${JSON.stringify(pathToFileURL(join(f.repositoryRoot, f.record.path)).href)}; console.log(JSON.stringify([compare(),compare()]));`], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr); assert.deepEqual(JSON.parse(run.stdout), [1, 2]);
  await rejects(f, "impure-primitive");
});}
for (const source of [
  "const state = {count: 0}; export const compare = () => {state.count = 1; return 1;};",
  "const state = {nested: {count: 0}}; export const compare = () => ++state.nested.count;",
  "const state = [0]; export const compare = () => ++state[0];",
  "const state = {count: 0}; export const compare = () => {const alias = state; return ++alias.count;};",
  "const state = {count: 0}; export const compare = () => state;",
  "const state = {nested: {count: 0}}; export const compare = () => ({value: state.nested});",
  "const state = {count: 0}; declare function unknown(value: unknown): number; export const compare = () => unknown(state);",
  "const state = {count: 0}; export const compare = () => Object.assign(state, {count: 1});",
  "const state = {count: 0}; export const compare = () => {delete state.count; return 1;};",
  "const state = {count: 0}; export const compare = () => {({value: state.count} = {value: 1}); return 1;};",
  "const state = {count: 0}; export const compare = () => ({...state});",
  "const state = {count: 0}; export const compare = (key: keyof typeof state) => state[key];",
  "const state = new Map(); export const compare = () => state.set('count', 1);",
  "const state = (() => ({count: 0}))(); export const compare = () => state.count;",
  "export const state = {count: 0}; export const compare = () => state.count;",
  "const state = {count: 0}; export {state}; export const compare = () => state.count;",
  "const state = () => 0; export const compare = () => ++state.count;",
  "function state(state: number) {return state;} export const compare = () => ++state.count;",
  "function state() {return 0;} export const compare = () => {const alias = state; Reflect.set(alias, 'count', 1); return 1;};"
]) {test(`primitive rejects module data mutation or unknown escape: ${source}`, async (t) => {
  const f = await primitiveFixture(t); await f.write(f.record.path, source); await rejects(f, "impure-primitive");
});}
for (const source of [
  "const table = {a: -1, b: 1} as const; export const compare = () => table.a + table['b'];",
  "const table = [-1, 0, 1] as const; export const compare = () => table[0] + table.length;",
  "const table = {nested: {value: 1}}; export const compare = () => table.nested.value;",
  "export const compare = () => {const state = {count: 0}; return ++state.count;};",
  "export const compare = () => {const state: number[] = []; state.push(1); return state.length;};"
]) {test(`primitive retains immutable tables or local working state: ${source}`, async (t) => {
  const f = await primitiveFixture(t); await f.write(f.record.path, source); await expectPass(f);
});}
test("primitive same-owner internal rename changes only the current caller mapping", async (t) => {
  const f = await primitiveFixture(t); await expectPass(f);
  const before = await readFile(join(f.repositoryRoot, f.record.decision));
  const caller = f.record.consumers[0], old = caller.path, current = old.replace("index.ts", "operation.ts");
  await f.write(current, await readFile(join(f.repositoryRoot, old), "utf8"));
  await f.write(old, 'export {execute} from "./operation.js";'); caller.path = current;
  await expectPass(f); assert.deepEqual(await readFile(join(f.repositoryRoot, f.record.decision)), before);
  assert.ok(!before.toString().includes(current) && !before.toString().includes(old));
});
for (const [label, mutate] of [
  ["wrong current owner", (f) => {f.record.consumers[0].owner = "example/beta";}],
  ["unknown current owner", (f) => {f.record.consumers[0].owner = "example/unknown";}],
  ["package-wide owner", (f) => {f.record.consumers[0].owner = "example";}],
  ["new semantic feature", (f) => {f.profile.modules[0].features[0].id = "gamma"; f.record.consumers[0].owner = "example/gamma";}],
  ["duplicate current path", (f) => {f.record.consumers.push(f.record.consumers[0]);}],
  ["stale current path", async (f) => {const path = `${f.sourceRoot}/features/alpha/application/unused.ts`; await f.write(path, "export const unused = 1;"); f.record.consumers.push({path, owner: "example/alpha"});}]
]) {test(`primitive consumer mapping rejects ${label}`, async (t) => {
  const f = await primitiveFixture(t); await mutate(f); await rejects(f, "primitive-consumer");
});}
for (const field of ["semantics", "owner", "rationale", "purity", "versioning", "reviewTrigger", "consumers"]) {
  test(`primitive decision requires ${field}`, async (t) => {
    const f = await primitiveFixture(t), text = await readFile(join(f.repositoryRoot, f.record.decision), "utf8");
    const metadata = YAML.parse(text.split("---")[1]); delete metadata.primitiveScopes[f.record.path][field];
    await f.write(f.record.decision, `---\n${YAML.stringify(metadata)}---\n`); await rejects(f, "exception-decision");
  });
}
for (const script of ["lint:typed", "architecture:patterns"]) {
  test(`feature adoption detects disconnected actual ${script} despite declaration`, async (t) => {
    const f = await fixture(t), pkg = JSON.parse(await readFile(join(f.repositoryRoot, "package.json"), "utf8"));
    pkg.scripts[script] = "true"; await f.write("package.json", JSON.stringify(pkg)); await rejects(f, "enforcement-command");
  });
}

async function qualifyPrimitive(f, source, expected, lintRule) {
  await f.write(f.record.path, source);
  for (const consumer of f.record.consumers) {await f.write(consumer.path, 'import {compare} from "../../../compare.js"; export const execute = () => compare();');} await compileFixture(f);
  const root = join(import.meta.dirname, "..");
  await symlink(join(root, "node_modules"), join(f.repositoryRoot, "node_modules"), "junction");
  const typed = JSON.parse(await readFile(join(root, ".oxlintrc.type-aware.json"), "utf8")); typed.extends = typed.extends.map((path) => join(root, path));
  await f.write("typed.json", JSON.stringify(typed)); const lint = spawnSync(process.execPath, [join(root, "node_modules/oxlint/bin/oxlint"), "--config", "typed.json", "--deny-warnings", "--no-ignore", "--disable-nested-config", f.record.path], { cwd: f.repositoryRoot, encoding: "utf8" });
  assert.equal(lint.status, lintRule ? 1 : 0, lint.stdout + lint.stderr); if (lintRule) {assert.match(lint.stdout + lint.stderr, lintRule);}
  const compiled = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json", "--noEmit", "false", "--outDir", "compiled", "--rootDir", "packages/example/src", "--pretty", "false"], { cwd: f.repositoryRoot, encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const emitted = await readFile(join(f.repositoryRoot, "compiled/compare.js"), "utf8");
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", emitted + "\nconsole.log(JSON.stringify([compare(), compare()]));"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr); assert.deepEqual(JSON.parse(run.stdout), expected); return { compile: compiled.status, typedLint: lint.status, runtime: JSON.parse(run.stdout) };
}
for (const [label, source] of [
  ["R1 satisfies update", "const state = {count: 0}; export const compare = (): number => { (state.count satisfies number)++; return state.count; };"],
  ["R2 ambient Object alias", 'export const compare = (): number => { const target = Object; const previous: unknown = Reflect.get(target, "__ef_count"); const count = typeof previous === "number" ? previous : 0; Reflect.set(target, "__ef_count", count + 1); return count + 1; };']
]) {test(`typed compiled primitive rejects ${label}`, async (t) => {
  const f = await primitiveFixture(t);
  const proof = await qualifyPrimitive(f, source, [1, 2]); const result = await f.check(); t.diagnostic(JSON.stringify({ label, ...proof, guard: result }));
  assert.ok(result.problems.some(({code}) => code === "impure-primitive"), JSON.stringify(result));
});}

for (const wrap of [value => `(${value} satisfies number)`, value => `(${value} as number)`, value => `${value}!`, value => `(<number>${value})`, value => `(((${value} as number)! satisfies number) as number)`]) {
  for (const target of ["state.count", "state.nested.count", "list[0]", "count"]) {
    for (const operation of [value => `${value} = 1`, value => `${value}++`, value => `delete ${value}`, value => `({value: ${value}} = {value: 1})`]) {
      const expression = operation(wrap(target));
      test(`primitive wrapped module write rejects ${expression}`, async (t) => {
        const f = await primitiveFixture(t);
        await f.write(f.record.path, `const state = {count: 0, nested: {count: 0}}; const list = [0]; const count = 0; export const compare = () => {${expression}; return 1;};`);
        await rejects(f, "impure-primitive");
      });
    } } }
for (const body of [
  'enum Values { count = Reflect.set(Object, "count", 1) ? 1 : 0 } return Values.count;',
  'const write = Object.assign<object, object>; return write({}, {});',
  'const one = Object; const two = (one satisfies ObjectConstructor); Reflect.set(two, "count", 1);',
  'const target = Array; const write = Reflect.set; write(target, "count", 1);',
  'const target = JSON; const {set: write} = Reflect; const alias = write; alias(target, "count", 1);',
  'const target = Math; const operations = Object; const {assign: write} = operations; write(target, {count: 1});',
  'const target = Number.isFinite; const write = Object["defineProperty"]; write(target, "count", {value: 1});',
  'const target = Object; Reflect.deleteProperty(target, "count");',
  'const target = Object; Object.defineProperties(target, {count: {value: 1}});',
  'const target = Object; Reflect.setPrototypeOf(target, {});',
  'const target = Object; target.count = 1;',
  'const target = Object; (target.count satisfies number)++;',
  'const target = Object; delete (target.count satisfies number);',
  'const target = Object; return target;',
  'const target = Object; const box = {target}; return box;',
  'const target = Object; return [...[target]];',
  'const target = Object; ((value: unknown) => value)(target);',
  'const target = Object; const identity = (value: unknown) => value; Reflect.set(identity(target), "count", 1);',
  'const target = {}; const {getPrototypeOf} = Object; Reflect.set(getPrototypeOf(target), "count", 1);',
  'const target = {}; Reflect.set(target.constructor, "count", 1);',
  'const target = {}; const key = "set"; Reflect[key](target, "count", 1);',
  'const target = {}; Reflect.set(target, "count", 1, Object);',
  'const target = {}; Reflect.set(...[target, "count", 1]);',
  'const target = {}; Reflect.apply(Object.assign, undefined, [target, {count: 1}]);',
  'const target = {}; Object.assign.call(undefined, target, {count: 1});',
  'const target = {}; const write = Reflect.set.bind(Reflect); write(target, "count", 1);',
  'const {set = Object.assign} = Reflect; set({}, "count", 1);',
  'const {...operations} = Reflect; operations.set(Object, "count", 1);',
  'let target = Object; Reflect.set(target, "count", 1);',
  'const target = {} as object; const opaque = (value: object) => value; Reflect.set(opaque(target), "count", 1);',
  'const target = {}; { const target = Object; Reflect.set(target, "count", 1); }',
  'const target = Object; { const Object = {}; Reflect.set(target, "count", 1); }',
  'const source = Math; const {random} = source; return random();',
  'const source = performance; const {now} = source; return now();',
  'const source = JSON; const method = source.stringify; return method;',
  'Reflect.set(compare, "count", 1);'
]) {test(`primitive ambient or unknown escape rejects ${body}`, async (t) => {
  const f = await primitiveFixture(t); await f.write(f.record.path, `export function compare() {${body} return 1;}`); await rejects(f, "impure-primitive");
});}
for (const source of [
  'const table = {nested: {value: 1}} as const; export const compare = () => (((table satisfies typeof table).nested)!).value;',
  'const table = [1, 2] as const; export const compare = () => ((table as typeof table) satisfies typeof table)[0];',
  'function read() {return 1;} export const compare = () => (read satisfies typeof read)();',
  'function read(read: number) {return read + 1;} export const compare = () => read(0);',
  'const read = (() => 1) satisfies () => number; export const compare = () => (read satisfies typeof read)();',
  'const state = {count: 1}; export const compare = () => {const state = {count: 0}; return ++(state.count satisfies number);};',
  'export const compare = () => {const target = {}; const alias = (target satisfies object); Reflect.set(alias, "count", 1); Reflect.deleteProperty(alias, "count"); return 1;};',
  'export const compare = () => {const list: number[] = []; const alias = list; const {assign} = Object; assign(alias, {0: 1}); alias.push(2); return alias.length;};',
  'export const compare = () => {const Object = {count: 0}; const target = Object; const {set: write} = Reflect; write(target, "count", 1); return Object.count;};',
  'export const compare = () => {const Reflect = {set: (target: {count: number}) => ++target.count}; const target = {count: 0}; return Reflect.set(target);};',
  'export const compare = (Object: number) => Object + 1;',
  'export const compare = (state: number) => {const nested = (state: number) => state + 1; return nested(state);};',
  'export const compare = () => {const value = {process: 1, Object: 2}; return value.process + value.Object;};',
  'export const compare = () => {const {floor} = Math; const round = floor; return round(Math.PI);};'
]) {test(`primitive finite origins accept ${source}`, async (t) => {
  const f = await primitiveFixture(t); await f.write(f.record.path, source); await expectPass(f);
});}
for (const [label, source, expected] of [
  ["readonly scalar projection", 'const table = {nested: {value: 1}} as const; export const compare = (): number => ((table satisfies typeof table).nested.value satisfies number);', [1, 1]],
  ["local object and array mutation", 'export const compare = (): number => { const Object = {count: 0}; const alias = Object; const {set: write} = Reflect; write(alias, "count", 1); (alias.count satisfies number)++; const list: number[] = []; list.push(alias.count); return list.length + alias.count; };', [3, 3]]
]) {test(`typed compiled primitive accepts ${label}`, async (t) => {
  const f = await primitiveFixture(t); const proof = await qualifyPrimitive(f, source, expected); await expectPass(f); t.diagnostic(JSON.stringify({ label, ...proof }));
});}

for (const operation of ['Object.assign(target, {count: 1})', 'Object.defineProperty(target, "count", {value: 1})', 'Object.defineProperties(target, {count: {value: 1}})', 'Object.freeze(target)', 'Object.seal(target)', 'Object.preventExtensions(target)', 'Reflect.set(target, "count", 1)', 'Reflect.deleteProperty(target, "count")', 'Reflect.defineProperty(target, "count", {value: 1})', 'Reflect.preventExtensions(target)']) {
  test(`primitive finite local target accepts ${operation}`, async (t) => {
    const f = await primitiveFixture(t); await f.write(f.record.path, `export const compare = () => {const target = {count: 0}; ${operation}; return target.count;};`); await expectPass(f);
  }); }
test("primitive origin bound fails closed", async (t) => {
  const f = await primitiveFixture(t), aliases = Array.from({length: 70}, (_, index) => `const alias${index + 1} = alias${index};`).join(" ");
  await f.write(f.record.path, `export const compare = () => {const alias0 = Reflect; ${aliases} return alias70;};`); await rejects(f, "impure-primitive");
});
test("typed composed Function control remains an existing Oxlint failure", async (t) => {
  const f = await primitiveFixture(t), proof = await qualifyPrimitive(f, 'export const compare = (): number => (Function("return 1") as () => number)();', [1, 1], /no-new-func/u);
  t.diagnostic(JSON.stringify({label: "existing Function restriction, not a third purity defect", ...proof}));
});

registerExecutableArgumentsCases(fixture, expectPass, rejects);
registerAssemblyOverloadsCases(fixture, expectPass, rejects);
registerNamespaceSurfaceCases(workspaceSurface, expectPass, rejects);

registerFactorySurfaceCases({ test, assert, workspaceSurface, rejects, expectPass });

registerFactoryReviewCases({ test, assert });
registerCrossModuleFactoryCases({ test, assert, workspaceSurface });
