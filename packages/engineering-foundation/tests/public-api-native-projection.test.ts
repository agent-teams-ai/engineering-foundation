import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ApiDeclaredItem, ExcerptTokenKind, type ApiItem } from "@microsoft/api-extractor-model";
import { withNativePublicApiProject, type NativePublicApiContext } from "../dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/native-public-api-engine.js";
import { captureNativePublicApiInputs } from "../dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/native-public-api-inputs.js";
import { createNativePublicApiModel } from "../dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/native-public-api-model.js";

type Projection = "stored-surface" | "declaration-graph";
type NativeModel = ReturnType<typeof createNativePublicApiModel>;
async function fixture(source: string, inspect: (context: NativePublicApiContext, entryPointPath: string) => void, options: {
  readonly dependency?: string;
  readonly nodeTypes?: boolean;
  readonly compilerOptions?: Readonly<Record<string, unknown>>;
} = {}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "foundation-native-projection-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "projection-fixture", version: "1.0.0", type: "module",
      ...(options.dependency === undefined ? {} : { dependencies: { "@fixture/dependency": "1.0.0" } }) }));
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2024", module: "NodeNext", strict: true,
      types: options.nodeTypes === true ? ["node"] : [], ...options.compilerOptions }, files: ["index.d.ts"] }));
    const entryPointPath = join(root, "index.d.ts");
    await writeFile(entryPointPath, source);
    if (options.dependency !== undefined) {
      const dependency = join(root, "node_modules", "@fixture", "dependency");
      await mkdir(dependency, { recursive: true });
      await writeFile(join(dependency, "package.json"), JSON.stringify({ name: "@fixture/dependency", version: "1.0.0", type: "module", exports: { ".": { types: "./index.d.ts" } } }));
      await writeFile(join(dependency, "index.d.ts"), options.dependency);
    }
    if (options.nodeTypes === true) {
      const require = createRequire(import.meta.url);
      await mkdir(join(root, "node_modules", "@types"), { recursive: true });
      await symlink(dirname(require.resolve("@types/node/package.json")), join(root, "node_modules", "@types", "node"), "junction");
    }
    const files = await captureNativePublicApiInputs({ stagingRoot: root, packageRoot: root });
    await withNativePublicApiProject({ cwd: root, configPath: join(root, "tsconfig.json"), files, declarationEntryPoint: entryPointPath }, context => inspect(context, entryPointPath));
  } finally { await rm(root, { recursive: true, force: true }); }
}
function models(context: NativePublicApiContext, entryPointPath: string): readonly [NativeModel, NativeModel, NativeModel] {
  const options = { packageName: "projection-fixture", entryPointPath, includeForgottenExports: false };
  return [createNativePublicApiModel(context, { ...options, referenceProjection: "stored-surface" }),
    createNativePublicApiModel(context, options), createNativePublicApiModel(context, { ...options, referenceProjection: "declaration-graph" })];
}
function declarations(item: ApiItem): ApiDeclaredItem[] {
  return [...(item instanceof ApiDeclaredItem ? [item] : []), ...item.members.flatMap(declarations)];
}
function ownItems(result: NativeModel) {
  return declarations(result.apiPackage).map(item => ({ canonicalReference: item.canonicalReference.toString(), kind: item.kind,
    parentReference: item.parent?.canonicalReference.toString(), parentKind: item.parent?.kind,
    signature: item.excerpt.text.replaceAll("\r\n", "\n").trim() })).toSorted((left, right) => left.canonicalReference < right.canonicalReference ? -1 : left.canonicalReference > right.canonicalReference ? 1 : 0);
}
function errors(result: NativeModel) { return result.diagnostics.filter(diagnostic => diagnostic.severity === "error"); }
function contentOnly(result: NativeModel): void {
  assert.ok(declarations(result.apiPackage).every(item => item.excerpt.tokens.every(token => token.kind === ExcerptTokenKind.Content)));
}

test("stored surfaces preserve official own identities and text from a fully bound declaration graph", async () => {
  await fixture("export interface Box { value: string; } export declare function read(value: Box): Box;\n", (context, entryPointPath) => {
    const [stored, defaultGraph, explicitGraph] = models(context, entryPointPath);
    for (const result of [stored, defaultGraph, explicitGraph]) {
      assert.equal(result.succeeded, true);
      assert.deepEqual(errors(result), []);
      assert.deepEqual(ownItems(result), [
        { canonicalReference: "projection-fixture!Box#value:member", kind: "PropertySignature", parentReference: "projection-fixture!Box:interface", parentKind: "Interface", signature: "value: string;" },
        { canonicalReference: "projection-fixture!Box:interface", kind: "Interface", parentReference: "projection-fixture!", parentKind: "EntryPoint", signature: "export interface Box" },
        { canonicalReference: "projection-fixture!read:function(1)", kind: "Function", parentReference: "projection-fixture!", parentKind: "EntryPoint", signature: "export declare function read(value: Box): Box;" }
      ]);
    }
    contentOnly(stored);
    for (const graph of [defaultGraph, explicitGraph]) {
      assert.deepEqual(declarations(graph.apiPackage).flatMap(item => item.excerpt.tokens.filter(token => token.kind === ExcerptTokenKind.Reference).map(token => token.canonicalReference?.toString())), ["projection-fixture!Box:interface", "projection-fixture!Box:interface"]);
      assert.equal(JSON.stringify(ownItems(stored)), JSON.stringify(ownItems(graph)));
    }
  });
});

test("stored surfaces retain external callable text while both graph selections reject an overloaded target", async () => {
  await fixture('import { fn } from "@fixture/dependency"; export type Callable = typeof fn;\n', (context, entryPointPath) => {
    const [stored, defaultGraph, explicitGraph] = models(context, entryPointPath);
    assert.equal(stored.succeeded, true);
    assert.deepEqual(errors(stored), []);
    contentOnly(stored);
    assert.deepEqual(ownItems(stored), [{ canonicalReference: "projection-fixture!Callable:type", kind: "TypeAlias", parentReference: "projection-fixture!", parentKind: "EntryPoint", signature: "export type Callable = typeof fn;" }]);
    for (const graph of [defaultGraph, explicitGraph]) {
      assert.equal(graph.succeeded, false);
      assert.deepEqual(errors(graph).map(diagnostic => [diagnostic.source, diagnostic.id]), [["extractor", "native-external-overload-reference"]]);
      assert.deepEqual(ownItems(graph), ownItems(stored));
      assert.deepEqual(declarations(graph.apiPackage).flatMap(item => item.excerpt.tokens.filter(token => token.kind === ExcerptTokenKind.Reference)), []);
    }
  }, { dependency: "export declare function fn(value: string): string; export declare function fn(value: number): number;\n" });
});

test("real installed Node types qualify stored text without claiming an external declaration graph", async () => {
  await fixture('import type { mkdir, realpath } from "node:fs/promises"; export interface NodePorts { readonly mkdir: typeof mkdir; readonly realpath: typeof realpath; bytes: Buffer; timeout: NodeJS.Timeout; }\n', (context, entryPointPath) => {
    assert.ok([...context.files.keys()].some(path => path.endsWith("/node_modules/@types/node/package.json")));
    const [stored, defaultGraph, explicitGraph] = models(context, entryPointPath);
    assert.equal(stored.succeeded, true, JSON.stringify(errors(stored)));
    assert.deepEqual(errors(stored), []);
    contentOnly(stored);
    assert.deepEqual(ownItems(stored), [
      { canonicalReference: "projection-fixture!NodePorts#bytes:member", kind: "PropertySignature", parentReference: "projection-fixture!NodePorts:interface", parentKind: "Interface", signature: "bytes: Buffer;" },
      { canonicalReference: "projection-fixture!NodePorts#mkdir:member", kind: "PropertySignature", parentReference: "projection-fixture!NodePorts:interface", parentKind: "Interface", signature: "readonly mkdir: typeof mkdir;" },
      { canonicalReference: "projection-fixture!NodePorts#realpath:member", kind: "PropertySignature", parentReference: "projection-fixture!NodePorts:interface", parentKind: "Interface", signature: "readonly realpath: typeof realpath;" },
      { canonicalReference: "projection-fixture!NodePorts#timeout:member", kind: "PropertySignature", parentReference: "projection-fixture!NodePorts:interface", parentKind: "Interface", signature: "timeout: NodeJS.Timeout;" },
      { canonicalReference: "projection-fixture!NodePorts:interface", kind: "Interface", parentReference: "projection-fixture!", parentKind: "EntryPoint", signature: "export interface NodePorts" }
    ]);
    for (const graph of [defaultGraph, explicitGraph]) {
      assert.equal(graph.succeeded, false);
      assert.deepEqual(errors(graph).filter(diagnostic => diagnostic.source === "compiler"), []);
      assert.ok(errors(graph).some(diagnostic => diagnostic.source === "extractor" && diagnostic.id === "native-external-overload-reference"));
      assert.deepEqual(ownItems(graph), ownItems(stored));
    }
  }, { nodeTypes: true });
});

test("both private projections retain real compiler errors with suppressed consumer checking", async () => {
  await fixture("export declare function fail(value: Missing): void;\n", (context, entryPointPath) => {
    for (const referenceProjection of ["stored-surface", "declaration-graph"] satisfies readonly Projection[]) {
      const result = createNativePublicApiModel(context, { packageName: "projection-fixture", entryPointPath, includeForgottenExports: false, referenceProjection });
      assert.equal(result.succeeded, false);
      assert.ok(errors(result).some(diagnostic => diagnostic.source === "compiler" && diagnostic.id === "TS2304"));
    }
  }, { compilerOptions: { noCheck: true, skipLibCheck: true, skipDefaultLibCheck: true } });
});
