const digest = text => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const inputFile = (path, text) => ({ path, digest: `sha256:${createHash("sha256").update(text).digest("hex")}` });
import { writeFileSync as requireWrite } from "node:fs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32, posix } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { ApiModel } from "@microsoft/api-extractor-model";
import { Extractor, ExtractorConfig } from "@microsoft/api-extractor";
import { MicrosoftPublicApiExtractor } from "../dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/microsoft-public-api-extractor.js";
import { MicrosoftPublicApiObserver } from "../dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/microsoft-public-api-observer.js";
import { projectPublicApiObservation } from "../dist/capabilities/public-api-compatibility/application/policies/project-public-api-observation.js";
import { publicApiAuditPairEligibility, publicApiAuditEligibility } from "../dist/capabilities/public-api-compatibility/application/policies/public-api-audit-eligibility.js";

async function fixture(source, action) {
  const root = await mkdtemp(join(tmpdir(), "foundation-audit-observer-test-"));
  try {
    const files = { "package.json": JSON.stringify({ name: "audit-fixture", version: "1.0.0", types: "index.d.ts", exports: { ".": { types: "./index.d.ts" } } }),
      "index.d.ts": source, "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", strict: true, skipLibCheck: false }, files: ["index.d.ts"] }) };
    for (const [path, text] of Object.entries(files)) {await writeFile(join(root, path), text);}
    const declarations = { packages: [{ packageName: "audit-fixture", packageVersion: "1.0.0", manifestPath: "package.json", tsconfigPath: "tsconfig.json", entrypoints: [{ exportPath: ".", declarationEntryPoint: "index.d.ts" }], nonTypeExports: [] }],
      files: Object.entries(files).map(([path, text]) => ({ path, digest: `sha256:${createHash("sha256").update(text).digest("hex")}` })),
      resolutionUniverse: [{ packageName: "audit-fixture", exportPath: ".", declarationPath: "index.d.ts" }] };
    await action(new MicrosoftPublicApiObserver(), { consumerRoot: root, subject: "A", declarations });
  } finally { await rm(root, { recursive: true, force: true }); }
}
test("observer preserves failed extraction while independently admitting bounded hidden graph", async () => {
  await fixture("type Hidden = string; declare function f(x: Hidden): Hidden; export { f };\n", async (observer, input) => {
    const observations = await observer.observe(input);
    assert.equal(observations.length, 1);
    const observation = observations[0];
    assert.deepEqual(observation.unsupported, []);
    assert.equal(observation.compilerDiagnosticsCollected, true);
    assert.equal(observation.invocation.succeeded, false);
    assert.equal(observation.modelPresent, true);
    assert.deepEqual(observation.items.map(item => item.identity.canonicalReference).toSorted(), ["audit-fixture!f:function(1)", "audit-fixture!~Hidden:type"]);
    assert.deepEqual(publicApiAuditEligibility(observations), { eligible: true, reasons: [] });
  });
});
test("compiler errors remain independently observable even when SDK throws", async () => {
  await fixture("type Hidden = MissingType; declare function f(x: Hidden): Hidden; export { f };\n", async (observer, input) => {
    const observations = await observer.observe(input);
    assert.equal(observations[0].compilerDiagnosticsCollected, true);
    assert.equal(observations[0].invocation.outcome, "exception");
    assert.equal(observations[0].modelPresent, false);
    assert.ok(observations[0].diagnostics.some(diagnostic => diagnostic.source === "compiler" && diagnostic.id === "TS2304" && diagnostic.severity === "error"));
    assert.equal(publicApiAuditEligibility(observations).eligible, false);
  });
});
test("finite builtin binding is proved against the pinned libraries", async () => {
  await fixture("export declare function f(signal: AbortSignal, bytes: Uint8Array, map: Readonly<Record<string, string>>, x: NoInfer<string | number>): Promise<Extract<string | number, string> | Error>;\n", async (observer, input) => {
    const observations = await observer.observe(input);
    assert.deepEqual(observations[0].unsupported, []);
    const references = observations[0].items.flatMap(item => item.references);
    assert.deepEqual(references.map(reference => [reference.canonicalReference, reference.resolution]), ["!AbortSignal:interface", "!Uint8Array:interface", "!Readonly:type", "!Record:type", "!NoInfer:type", "!Promise:interface", "!Extract:type", "!Error:interface"].map(reference => [reference, "verified-external-library"]));
    assert.ok(references.every(reference => reference.library.declarations.length > 0));
    assert.equal(publicApiAuditEligibility(observations).eligible, true, JSON.stringify({ eligibility: publicApiAuditEligibility(observations), diagnostics: observations[0].diagnostics, references: observations[0].items.flatMap(item => item.references), identities: observations[0].items.map(item => item.identity.canonicalReference) }));
  });
});
test("global augmentation cannot pass by matching a builtin spelling", async () => {
  await fixture("declare global { interface Promise<T> { extra: T } } export declare function f(x: Promise<string>): void;\n", async (observer, input) => {
    const observations = await observer.observe(input);
    assert.ok(observations[0].items.flatMap(item => item.references).some(reference => reference.canonicalReference === "!Promise:interface" && reference.resolution === "unresolved"));
    assert.equal(publicApiAuditEligibility(observations).eligible, false);
  });
});
test("tampered input and cancellation fail closed", async () => {
  await fixture("export declare function f(): void;\n", async (observer, input) => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(observer.observe({ ...input, signal: controller.signal }));
    await writeFile(join(input.consumerRoot, "index.d.ts"), "export declare function changed(): void;\n");
    const observations = await observer.observe(input);
    assert.equal(publicApiAuditEligibility(observations).eligible, false);
    assert.equal(observations[0].inputBytesRevalidated, false);
  });
});
test("public members inherit their namespace/class visibility; hidden containers do not export members", async () => {
  await fixture("declare namespace Hidden { export class Box { constructor(); value: string; } } export namespace Visible { class Box { constructor(); value: string; } } declare function f(x: Hidden.Box): void; export { f };\n", async (observer, input) => {
    const observations = await observer.observe(input);
    const items = observations[0].items;
    const visible = items.filter(item => item.identity.canonicalReference.includes("Visible"));
    const hidden = items.filter(item => item.identity.canonicalReference.includes("~Hidden"));
    assert.equal(visible.length, 4);
    assert.equal(hidden.length, 4);
    assert.deepEqual(visible.map(item => [item.kind, item.public]).toSorted(), [["Class", true], ["Constructor", true], ["Namespace", true], ["Property", true]]);
    assert.deepEqual(hidden.map(item => [item.kind, item.public]).toSorted(), [["Class", false], ["Constructor", false], ["Namespace", false], ["Property", false]]);
    assert.equal(visible.find(item => item.kind === "Constructor").isExported, null);
    // The pinned SDK emits inconsistent navigation for this hidden namespace member.
    // Neither the production adapter nor this oracle rewrites opaque identities.
    assert.equal(hidden.find(item => item.kind === "Class").identity.canonicalReference, "audit-fixture!~Hidden~Box:class");
    assert.deepEqual(items.flatMap(item => item.references).map(reference => [reference.canonicalReference, reference.resolution]), [["audit-fixture!~Hidden.Box:class", "unresolved"]]);
    assert.deepEqual(publicApiAuditEligibility(observations), { eligible: false, reasons: ["incomplete-reference-resolution"] });
    const duplicate = { ...observations[0], items: [...items, items[0]] };
    assert.ok(publicApiAuditEligibility([duplicate]).reasons.includes("duplicate-scoped-identity"));
    assert.ok(publicApiAuditEligibility([{ ...observations[0], modelPresent: false }]).reasons.includes("missing-model"));
    assert.ok(publicApiAuditEligibility([{ ...observations[0], invocation: { ...observations[0].invocation, outcome: "exception" } }]).reasons.includes("incomplete-invocation"));
    const unexpected = { source: "extractor", id: "ae-unexpected", severity: "error", text: "unexpected" };
    assert.ok(publicApiAuditEligibility([{ ...observations[0], diagnostics: [...observations[0].diagnostics, unexpected] }]).reasons.includes("non-forgotten-export-error"));
  });
});

test("production extraction keeps false mode and rejects failure before loading a model", async () => {
  await fixture("type Hidden = string; declare function f(x: Hidden): Hidden; export { f };\n", async (_observer, input) => {
    const originalLoad = ApiModel.prototype.loadPackage;
    const originalPrepare = ExtractorConfig.prepare;
    let modelLoads = 0;
    const modes = [];
    const trims = [];
    ApiModel.prototype.loadPackage = function () { modelLoads++; throw new Error("MODEL_LOAD_MUST_NOT_RUN"); };
    ExtractorConfig.prepare = function (options) { modes.push(options.configObject.docModel.includeForgottenExports); trims.push(options.configObject.docModel.releaseTagsToTrim); return originalPrepare.call(this, options); };
    try {
      const extractor = new MicrosoftPublicApiExtractor({ files: { read: async ({ candidate }) => readFile(candidate) }, paths: { traversesSymbolicLink: async () => false } });
      const policy = { ...input.declarations.packages[0], packageRoot: ".", releasedBaselinePath: "baseline.json", approvedBreakingChanges: [] };
      await assert.rejects(extractor.extract(input.consumerRoot, policy, "1.0.0"), error => error.message.includes("ae-forgotten-export"));
      assert.deepEqual(modes, [false]);
      assert.deepEqual(trims, [undefined]);
      assert.equal(modelLoads, 0);
    } finally { ApiModel.prototype.loadPackage = originalLoad; ExtractorConfig.prepare = originalPrepare; }
  });
});
for (const form of ["named-root", "named-extra", "inline-extra", "unused-root-inline-extra", "mixed-inline-paths"]) {
  const importedPath = form === "named-root" ? "." : "./extra";
  const inline = form.includes("inline");
  const paths = form === "mixed-inline-paths" ? [".", "./extra"] : inline ? [importedPath] : [importedPath, importedPath];
  const declaration = form === "mixed-inline-paths"
    ? 'export declare function use(x: import("@fixture/core").Core, y: import("@fixture/core/extra").Core): void;\n'
    : inline
    ? `${form === "unused-root-inline-extra" ? 'import type { Core as Unused } from "@fixture/core";\n' : ""}export declare function use(x: import("@fixture/core/extra").Core): void;\n`
    : `import type { Core } from "@fixture/core${importedPath === "." ? "" : "/extra"}"; export declare function use(x: Core): Core;\n`;
  test(`cross-package ${form} binding preserves repeated canonical identities across A/C`, async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-audit-dependency-test-"));
  try {
    const files = {};
    const packages = [];
    for (const name of ["core", "assembly"]) {
      const directory = name === "core" ? "node_modules/@fixture/core" : "assembly";
      await mkdir(join(root, directory), { recursive: true });
      files[`${directory}/package.json`] = JSON.stringify({ name: `@fixture/${name}`, version: "1.0.0", ...(name === "assembly" ? { dependencies: { "@fixture/core": "1.0.0" } } : {}), types: "index.d.ts", exports: { ".": { types: "./index.d.ts" }, ...(name === "core" ? { "./extra": { types: "./index.d.ts" } } : {}) } });
      files[`${directory}/index.d.ts`] = name === "core" ? "export interface Core { value: string }\n" : declaration;
      files[`${directory}/tsconfig.json`] = JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", strict: true, skipLibCheck: false, baseUrl: "..", paths: { "@fixture/core": ["node_modules/@fixture/core/index.d.ts"] } }, files: ["index.d.ts"] });
      packages.push({ packageName: `@fixture/${name}`, packageVersion: "1.0.0", manifestPath: `${directory}/package.json`, tsconfigPath: `${directory}/tsconfig.json`, entrypoints: [{ exportPath: ".", declarationEntryPoint: `${directory}/index.d.ts` }, ...(name === "core" ? [{ exportPath: "./extra", declarationEntryPoint: `${directory}/index.d.ts` }] : [])], nonTypeExports: [] });
    }
    for (const [path, bytes] of Object.entries(files)) {await writeFile(join(root, path), bytes);}
    const declarations = { packages, files: Object.entries(files).map(([path, bytes]) => ({ path, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` })), resolutionUniverse: packages.flatMap(pkg => pkg.entrypoints.map(entry => ({ packageName: pkg.packageName, exportPath: entry.exportPath, declarationPath: entry.declarationEntryPoint }))) };
    const observations = await new MicrosoftPublicApiObserver().observe({ consumerRoot: root, subject: "A", declarations });
    assert.deepEqual(observations.flatMap(observation => observation.unsupported), []);
    const assembly = observations.find(observation => observation.packageName === "@fixture/assembly");
    assert.deepEqual(assembly.items.flatMap(item => item.references).map(reference => [reference.resolution, reference.target?.subject, reference.target?.packageName, reference.target?.exportPath, reference.target?.canonicalReference]),
      paths.map(path => ["same-subject-dependency", "A", "@fixture/core", path, "@fixture/core!Core:interface"]));
    assert.equal(publicApiAuditEligibility(observations).eligible, true);
    const candidate = await new MicrosoftPublicApiObserver().observe({ consumerRoot: root, subject: "C", declarations });
    assert.deepEqual(publicApiAuditPairEligibility(observations, candidate), { eligible: true, reasons: [] });
    assert.deepEqual(projectPublicApiObservation(observations, "@fixture/assembly").snapshot,
      projectPublicApiObservation(candidate, "@fixture/assembly").snapshot);
    assert.deepEqual(candidate.find(observation => observation.packageName === "@fixture/assembly").items.flatMap(item => item.references).map(reference => reference.target.subject), paths.map(() => "C"));
    assert.deepEqual(observations.filter(observation => observation.packageName === "@fixture/core").map(observation => [observation.exportPath, observation.items.map(item => item.identity.canonicalReference)]), [
      [".", ["@fixture/core!Core:interface", "@fixture/core!Core#value:member"]],
      ["./extra", ["@fixture/core!Core:interface", "@fixture/core!Core#value:member"]]
    ]);
    const withoutCoreModel = observations.filter(observation => observation.packageName !== "@fixture/core");
    assert.equal(publicApiAuditEligibility(withoutCoreModel).eligible, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});}
test("a locally shadowed builtin remains a local declaration rather than a library boundary", async () => {
  await fixture("interface Promise<T> { local: T } declare function f(x: Promise<string>): void; export { f };\n", async (observer, input) => {
    const observations = await observer.observe(input);
    const references = observations[0].items.flatMap(item => item.references);
    assert.ok(references.some(reference => reference.canonicalReference === "audit-fixture!~Promise_2:interface" && reference.resolution === "local"), JSON.stringify({ references, observation: observations[0] }));
    assert.ok(references.every(reference => reference.resolution !== "verified-external-library"));
    assert.deepEqual(publicApiAuditEligibility(observations), { eligible: true, reasons: [] });
  });
});
test("config dependencies are captured; suppressed diagnostics and model-count exhaustion are refused", async () => {
  await fixture("export declare function f(): void;\n", async (observer, input) => {
    const base = JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", skipLibCheck: false } });
    const config = JSON.stringify({ extends: "./base.json", files: ["index.d.ts"] });
    await writeFile(join(input.consumerRoot, "base.json"), base);
    await writeFile(join(input.consumerRoot, "tsconfig.json"), config);
    const declarations = { ...input.declarations, files: [...input.declarations.files.filter(item => item.path !== "tsconfig.json"), inputFile("tsconfig.json", config), inputFile("base.json", base)] };
    const observations = await observer.observe({ ...input, declarations });
    assert.deepEqual(observations[0].configurationDependencies.map(item => item.path).toSorted(), ["base.json", "package.json", "tsconfig.json"]);
    assert.ok(observations[0].sourceFiles.some(item => item.path === "index.d.ts"));
    assert.ok(!observations[0].compilerEnvironment.includes("foundation-public-api-audit-"));
    assert.deepEqual(publicApiAuditEligibility(observations), { eligible: true, reasons: [] });
    const suppressed = JSON.stringify({ compilerOptions: { skipLibCheck: true }, files: ["index.d.ts"] });
    await writeFile(join(input.consumerRoot, "tsconfig.json"), suppressed);
    const invalid = await observer.observe({ ...input, declarations: { ...input.declarations, files: [...input.declarations.files.filter(item => item.path !== "tsconfig.json"), inputFile("tsconfig.json", suppressed)] } });
    assert.equal(invalid[0].invocation.outcome, "not-invoked");
    assert.ok(invalid[0].unsupported.some(reason => reason.includes("suppression")));
    await assert.rejects(observer.observe({ ...input, declarations: { ...input.declarations, packages: [{ ...input.declarations.packages[0], entrypoints: Array.from({ length: 65 }, (_, i) => ({ exportPath: `./entry-${i}`, declarationEntryPoint: "index.d.ts" })) }] } }), /64-model/u);
  });
});


test("undeclared nested resolution metadata cannot change admission behind identical digests", async () => {
  await fixture('export { f } from "./sub/entry.js";\n', async (observer, input) => {
    const root = input.consumerRoot;
    await mkdir(join(root, "sub"));
    const files = {
      "package.json": JSON.stringify({ name: "audit-fixture", version: "1.0.0", type: "module", types: "index.d.ts", exports: { ".": { types: "./index.d.ts" } } }),
      "sub/entry.d.ts": 'import type { T } from "./types"; export declare function f(): T;\n',
      "sub/types.d.ts": 'export type T = string;\n'
    };
    for (const [path, text] of Object.entries(files)) {await writeFile(join(root, path), text);}
    const declarations = { ...input.declarations, files: [...input.declarations.files.filter(file => file.path !== "package.json"), ...Object.entries(files).map(([path, text]) => ({ path, digest: digest(text) }))] };
    for (const type of ["commonjs", "module"]) {
      await writeFile(join(root, "sub/package.json"), JSON.stringify({ type }));
      const observations = await observer.observe({ ...input, declarations });
      assert.equal(publicApiAuditEligibility(observations).eligible, false);
      assert.equal(observations[0].inputBytesRevalidated, false);
      assert.equal(observations[0].invocation.outcome, "not-invoked");
      assert.ok(observations[0].unsupported.some(reason => reason.includes("resolution metadata")));
    }
    const metadata = JSON.stringify({ type: "commonjs" });
    await writeFile(join(root, "sub/package.json"), metadata);
    declarations.files.push({ path: "sub/package.json", digest: digest(metadata) });
    const admitted = await observer.observe({ ...input, declarations });
    assert.equal(publicApiAuditEligibility(admitted).eligible, true, JSON.stringify(admitted));
    assert.ok(admitted[0].configurationDependencies.some(file => file.path === "sub/package.json" && file.digest === digest(metadata)));
    const originalInvoke = Extractor.invoke;
    Extractor.invoke = function (...args) {
      // Mutation after compiler creation must invalidate custody even if extraction completes.
      const result = originalInvoke.apply(this, args);
      requireWrite(join(root, "sub/package.json"), JSON.stringify({ type: "module" }));
      return result;
    };
    try {
      const changed = await observer.observe({ ...input, declarations });
      assert.equal(changed[0].inputBytesRevalidated, false);
      assert.equal(publicApiAuditEligibility(changed).eligible, false);
      assert.ok(changed[0].unsupported.some(reason => reason.includes("changed during observation")));
    } finally { Extractor.invoke = originalInvoke; }
  });
});


test("enclosing manifest outside the supplied root is an explicit unsupported boundary", async () => {
  await fixture("export declare function f(): void;\n", async (observer, input) => {
    const nested = join(input.consumerRoot, "nested");
    await mkdir(nested);
    for (const file of input.declarations.files) {await writeFile(join(nested, file.path), await readFile(join(input.consumerRoot, file.path)));}
    const observations = await observer.observe({ ...input, consumerRoot: nested });
    assert.equal(publicApiAuditEligibility(observations).eligible, false);
    assert.equal(observations[0].inputBytesRevalidated, false);
    const enclosingManifest = join(await realpath(input.consumerRoot), "package.json");
    assert.ok(observations[0].unsupported.some(reason => reason.includes(`resolution metadata: ${enclosingManifest}`)));
  });
});

test("audit uses Extractor TypeScript 5.9.3 and refuses an incompatible loaded SDK", async () => {
  const { pinnedCompiler, compilerPath } = await import("../dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/load-pinned-audit-sdk.js");
  const { createRequire } = await import("node:module");
  const require = createRequire(new URL("../package.json", import.meta.url));
  assert.equal(pinnedCompiler.version, "5.9.3");
  assert.equal(compilerPath, createRequire(require.resolve("@microsoft/api-extractor")).resolve("typescript"));
  const descriptor = Object.getOwnPropertyDescriptor(Extractor, "version");
  try {
    Object.defineProperty(Extractor, "version", { configurable: true, get: () => "0.0.0" });
    await assert.rejects(new MicrosoftPublicApiObserver().observe({ consumerRoot: "/unused", subject: "A", declarations: { packages: [], files: [] } }), /Unsupported audit toolchain/);
  } finally { Object.defineProperty(Extractor, "version", descriptor); }
});


test("observer canonicalizes a symlinked root ancestor without admitting symlinked inputs", async () => {
  await fixture("export declare function f(): void;\n", async (observer, input) => {
    const aliases = await mkdtemp(join(tmpdir(), "foundation-audit-root-alias-"));
    try {
      await symlink(await realpath(input.consumerRoot), join(aliases, "root"), "dir");
      const aliased = { ...input, consumerRoot: join(aliases, "root") };
      const observed = await observer.observe(aliased);
      assert.equal(publicApiAuditEligibility(observed).eligible, true);
      assert.equal(observed[0].inputBytesRevalidated, true);
      await symlink(join(aliases, "outside.d.ts"), join(input.consumerRoot, "linked.d.ts"));
      await writeFile(join(aliases, "outside.d.ts"), "export declare const outside: true;\n");
      await assert.rejects(observer.observe({ ...aliased, declarations: { ...input.declarations,
        files: [...input.declarations.files, inputFile("linked.d.ts", "export declare const outside: true;\n")] } }), /Audit symlink unsupported/);
      await assert.rejects(observer.observe({ ...aliased, declarations: { ...input.declarations,
        files: [inputFile("../outside.d.ts", "")] } }), /Invalid audit path/);
    } finally { await rm(aliases, { recursive: true, force: true }); }
  });
});


test("audit stage remapping handles Windows SDK paths without capturing outside evidence", async () => {
  const { remapAuditStagePath } = await import("../dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/public-api-audit-inputs.js");
  const stage = String.raw`C:\temp\audit\evidence`;
  const root = String.raw`D:\consumer`;
  for (const path of [String.raw`C:\temp\audit\evidence\sub\index.d.ts`, "C:/temp/audit/evidence/sub/index.d.ts", "c:/temp/audit/evidence/sub/index.d.ts"]) {
    assert.equal(remapAuditStagePath(path, stage, root, win32), String.raw`D:\consumer\sub\index.d.ts`);
  }
  for (const path of ["C:/temp/audit/evidence-other/index.d.ts", "C:/temp/audit/evidence/../outside.d.ts", "C:/temp/audit", "E:/temp/audit/evidence/index.d.ts", "//server/share/index.d.ts", "relative/index.d.ts"]) {
    assert.equal(remapAuditStagePath(path, stage, root, win32), path);
  }
  assert.equal(remapAuditStagePath("//server/share/stage/sub/file", String.raw`\\server\share\stage`, root, win32), String.raw`D:\consumer\sub\file`);
  assert.equal(remapAuditStagePath("/stage/sub/file", "/stage", "/consumer", posix), "/consumer/sub/file");
  assert.equal(remapAuditStagePath("/stage-other/file", "/stage", "/consumer", posix), "/stage-other/file");
});

test("audit portable input paths reject Windows absolutes and drive-relative escapes on every host", async () => {
  const { auditInputPath } = await import("../dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/public-api-audit-inputs.js");
  for (const path of ["C:/temp/input.json", "C:input.json", "sub/C:input.json", String.raw`C:\temp\input.json`, "//server/share/input.json", "../input.json", "sub/../../input.json"]) {
    await assert.rejects(auditInputPath("/unused", path), /Invalid audit path/);
  }
});


test("observer serializes native canonical temp inputs relative to the request root", async () => {
  await fixture("export declare function f(): void;\n", async (observer, input) => {
    // On Windows tmpdir may contain RUNNER~1 while native realpath expands it.
    // A separate alias also exercises root canonicalization on POSIX hosts.
    const aliases = await mkdtemp(join(tmpdir(), "foundation-audit-root-alias-"));
    try {
      const alias = join(aliases, "request");
      await symlink(await realpath(input.consumerRoot), alias, "junction");
      for (const consumerRoot of [input.consumerRoot, alias]) {
        const [observation] = await observer.observe({ ...input, consumerRoot });
        assert.deepEqual(observation.unsupported, []);
        assert.equal(observation.inputBytesRevalidated, true);
        assert.deepEqual(observation.configurationDependencies.map(file => file.path).toSorted(), ["package.json", "tsconfig.json"]);
        assert.ok(observation.sourceFiles.some(file => file.path === "index.d.ts"));
        assert.equal(publicApiAuditEligibility([observation]).eligible, true);
      }
    } finally { await rm(aliases, { recursive: true, force: true }); }
  });
});
