import { registerNativeSpellingCases } from "./public-api-native-spelling-cases.ts";
import { registerNativeAsyncSignatureCases } from "./public-api-native-async-cases.ts";
import { registerAsyncClassificationCases } from "./public-api-async-classification-cases.ts";
import { createHash } from "node:crypto";
import type {
  PublicApiSnapshot,
  PublicApiItem,
} from "../src/capabilities/public-api-compatibility/application/model/public-api.js";
import { createNativeTypeParenthesisEquivalence } from "../dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/native-type-parenthesis-equivalence.js";
import { classifyPublicApiChange } from "../dist/capabilities/public-api-compatibility/application/policies/evaluate-public-api-compatibility.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ApiDeclaredItem, ExcerptTokenKind, type ApiItem } from "@microsoft/api-extractor-model";
import {
  withNativePublicApiProject,
  type NativePublicApiContext,
} from "../dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/native-public-api-engine.js";
import { captureNativePublicApiInputs } from "../dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/native-public-api-inputs.js";
import { createNativePublicApiModel } from "../dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/native-public-api-model.js";

type Projection = "stored-surface" | "declaration-graph";
type NativeModel = Awaited<ReturnType<typeof createNativePublicApiModel>>;
async function fixture(
  source: string,
  inspect: (context: NativePublicApiContext, entryPointPath: string) => void | Promise<void>,
  options: {
    readonly dependency?: string;
    readonly nodeTypes?: boolean;
    readonly compilerOptions?: Readonly<Record<string, unknown>>;
  } = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "foundation-native-projection-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "projection-fixture",
        version: "1.0.0",
        type: "module",
        ...(options.dependency === undefined
          ? {}
          : { dependencies: { "@fixture/dependency": "1.0.0" } }),
      }),
    );
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2024",
          module: "NodeNext",
          strict: true,
          types: options.nodeTypes === true ? ["node"] : [],
          ...options.compilerOptions,
        },
        files: ["index.d.ts"],
      }),
    );
    const entryPointPath = join(root, "index.d.ts");
    await writeFile(entryPointPath, source);
    if (options.dependency !== undefined) {
      const dependency = join(root, "node_modules", "@fixture", "dependency");
      await mkdir(dependency, { recursive: true });
      await writeFile(
        join(dependency, "package.json"),
        JSON.stringify({
          name: "@fixture/dependency",
          version: "1.0.0",
          type: "module",
          exports: { ".": { types: "./index.d.ts" } },
        }),
      );
      await writeFile(join(dependency, "index.d.ts"), options.dependency);
    }
    if (options.nodeTypes === true) {
      const require = createRequire(import.meta.url);
      await mkdir(join(root, "node_modules", "@types"), { recursive: true });
      await symlink(
        dirname(require.resolve("@types/node/package.json")),
        join(root, "node_modules", "@types", "node"),
        "junction",
      );
    }
    const files = await captureNativePublicApiInputs({ stagingRoot: root, packageRoot: root });
    await withNativePublicApiProject(
      {
        cwd: root,
        configPath: join(root, "tsconfig.json"),
        files,
        declarationEntryPoint: entryPointPath,
      },
      (context) => inspect(context, entryPointPath),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function models(
  context: NativePublicApiContext,
  entryPointPath: string,
): Promise<readonly [NativeModel, NativeModel, NativeModel]> {
  const options = {
    packageName: "projection-fixture",
    entryPointPath,
    includeForgottenExports: false,
  };
  return [
    await createNativePublicApiModel(context, {
      ...options,
      referenceProjection: "stored-surface",
    }),
    await createNativePublicApiModel(context, options),
    await createNativePublicApiModel(context, {
      ...options,
      referenceProjection: "declaration-graph",
    }),
  ];
}
function declarations(item: ApiItem): ApiDeclaredItem[] {
  return [
    ...(item instanceof ApiDeclaredItem ? [item] : []),
    ...item.members.flatMap(declarations),
  ];
}
function ownItems(result: NativeModel) {
  return declarations(result.apiPackage)
    .map((item) => ({
      canonicalReference: item.canonicalReference.toString(),
      kind: item.kind,
      parentReference: item.parent?.canonicalReference.toString(),
      parentKind: item.parent?.kind,
      signature: item.excerpt.text.replaceAll("\r\n", "\n").trim(),
    }))
    .toSorted((left, right) =>
      left.canonicalReference < right.canonicalReference
        ? -1
        : left.canonicalReference > right.canonicalReference
          ? 1
          : 0,
    );
}
function errors(result: NativeModel) {
  return result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
}
function contentOnly(result: NativeModel): void {
  assert.ok(
    declarations(result.apiPackage).every((item) =>
      item.excerpt.tokens.every((token) => token.kind === ExcerptTokenKind.Content),
    ),
  );
}

void test("stored surfaces preserve official own identities and text from a fully bound declaration graph", async () => {
  await fixture(
    "export interface Box { value: string; } export declare function read(value: Box): Box;\n",
    async (context, entryPointPath) => {
      const [stored, defaultGraph, explicitGraph] = await models(context, entryPointPath);
      for (const result of [stored, defaultGraph, explicitGraph]) {
        assert.equal(result.succeeded, true);
        assert.deepEqual(errors(result), []);
        assert.deepEqual(ownItems(result), [
          {
            canonicalReference: "projection-fixture!Box#value:member",
            kind: "PropertySignature",
            parentReference: "projection-fixture!Box:interface",
            parentKind: "Interface",
            signature: "value: string;",
          },
          {
            canonicalReference: "projection-fixture!Box:interface",
            kind: "Interface",
            parentReference: "projection-fixture!",
            parentKind: "EntryPoint",
            signature: "export interface Box",
          },
          {
            canonicalReference: "projection-fixture!read:function(1)",
            kind: "Function",
            parentReference: "projection-fixture!",
            parentKind: "EntryPoint",
            signature: "export declare function read(value: Box): Box;",
          },
        ]);
      }
      contentOnly(stored);
      for (const graph of [defaultGraph, explicitGraph]) {
        assert.deepEqual(
          declarations(graph.apiPackage).flatMap((item) =>
            item.excerpt.tokens
              .filter((token) => token.kind === ExcerptTokenKind.Reference)
              .map((token) => token.canonicalReference?.toString()),
          ),
          ["projection-fixture!Box:interface", "projection-fixture!Box:interface"],
        );
        assert.equal(JSON.stringify(ownItems(stored)), JSON.stringify(ownItems(graph)));
      }
    },
  );
});

void test("stored surfaces retain external callable text while both graph selections reject an overloaded target", async () => {
  await fixture(
    'import { fn } from "@fixture/dependency"; export type Callable = typeof fn;\n',
    async (context, entryPointPath) => {
      const [stored, defaultGraph, explicitGraph] = await models(context, entryPointPath);
      assert.equal(stored.succeeded, true);
      assert.deepEqual(errors(stored), []);
      contentOnly(stored);
      assert.deepEqual(ownItems(stored), [
        {
          canonicalReference: "projection-fixture!Callable:type",
          kind: "TypeAlias",
          parentReference: "projection-fixture!",
          parentKind: "EntryPoint",
          signature: "export type Callable = typeof fn;",
        },
      ]);
      for (const graph of [defaultGraph, explicitGraph]) {
        assert.equal(graph.succeeded, false);
        assert.deepEqual(
          errors(graph).map((diagnostic) => [diagnostic.source, diagnostic.id]),
          [["extractor", "native-external-overload-reference"]],
        );
        assert.deepEqual(ownItems(graph), ownItems(stored));
        assert.deepEqual(
          declarations(graph.apiPackage).flatMap((item) =>
            item.excerpt.tokens.filter((token) => token.kind === ExcerptTokenKind.Reference),
          ),
          [],
        );
      }
    },
    {
      dependency:
        "export declare function fn(value: string): string; export declare function fn(value: number): number;\n",
    },
  );
});

void test("real installed Node types qualify stored text without claiming an external declaration graph", async () => {
  await fixture(
    'import type { mkdir, realpath } from "node:fs/promises"; export interface NodePorts { readonly mkdir: typeof mkdir; readonly realpath: typeof realpath; bytes: Buffer; timeout: NodeJS.Timeout; }\n',
    async (context, entryPointPath) => {
      assert.ok(
        [...context.files.keys()].some((path) =>
          path.endsWith("/node_modules/@types/node/package.json"),
        ),
      );
      const [stored, defaultGraph, explicitGraph] = await models(context, entryPointPath);
      assert.equal(stored.succeeded, true, JSON.stringify(errors(stored)));
      assert.deepEqual(errors(stored), []);
      contentOnly(stored);
      assert.deepEqual(ownItems(stored), [
        {
          canonicalReference: "projection-fixture!NodePorts#bytes:member",
          kind: "PropertySignature",
          parentReference: "projection-fixture!NodePorts:interface",
          parentKind: "Interface",
          signature: "bytes: Buffer;",
        },
        {
          canonicalReference: "projection-fixture!NodePorts#mkdir:member",
          kind: "PropertySignature",
          parentReference: "projection-fixture!NodePorts:interface",
          parentKind: "Interface",
          signature: "readonly mkdir: typeof mkdir;",
        },
        {
          canonicalReference: "projection-fixture!NodePorts#realpath:member",
          kind: "PropertySignature",
          parentReference: "projection-fixture!NodePorts:interface",
          parentKind: "Interface",
          signature: "readonly realpath: typeof realpath;",
        },
        {
          canonicalReference: "projection-fixture!NodePorts#timeout:member",
          kind: "PropertySignature",
          parentReference: "projection-fixture!NodePorts:interface",
          parentKind: "Interface",
          signature: "timeout: NodeJS.Timeout;",
        },
        {
          canonicalReference: "projection-fixture!NodePorts:interface",
          kind: "Interface",
          parentReference: "projection-fixture!",
          parentKind: "EntryPoint",
          signature: "export interface NodePorts",
        },
      ]);
      for (const graph of [defaultGraph, explicitGraph]) {
        assert.equal(graph.succeeded, false);
        assert.deepEqual(
          errors(graph).filter((diagnostic) => diagnostic.source === "compiler"),
          [],
        );
        assert.ok(
          errors(graph).some(
            (diagnostic) =>
              diagnostic.source === "extractor" &&
              diagnostic.id === "native-external-overload-reference",
          ),
        );
        assert.deepEqual(ownItems(graph), ownItems(stored));
      }
    },
    { nodeTypes: true },
  );
});

void test("both private projections retain real compiler errors with suppressed consumer checking", async () => {
  await fixture(
    "export declare function fail(value: Missing): void;\n",
    async (context, entryPointPath) => {
      for (const referenceProjection of [
        "stored-surface",
        "declaration-graph",
      ] satisfies readonly Projection[]) {
        const result = await createNativePublicApiModel(context, {
          packageName: "projection-fixture",
          entryPointPath,
          includeForgottenExports: false,
          referenceProjection,
        });
        assert.equal(result.succeeded, false);
        assert.ok(
          errors(result).some(
            (diagnostic) => diagnostic.source === "compiler" && diagnostic.id === "TS2304",
          ),
        );
      }
    },
    { compilerOptions: { noCheck: true, skipLibCheck: true, skipDefaultLibCheck: true } },
  );
});

const signatureProof = createNativeTypeParenthesisEquivalence();
const signatureFingerprint = {
  sha256: (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex"),
};
function aliasSnapshot(
  signature: string,
  metadata: Partial<PublicApiItem> = {},
): PublicApiSnapshot {
  return {
    schemaVersion: 1,
    packageName: "syntax-fixture",
    packageVersion: "1.0.0",
    extractorVersion: "typescript-native/7.0.2",
    entrypoints: [
      {
        exportPath: ".",
        items: [
          {
            canonicalReference: "syntax-fixture!Alias:type",
            kind: "TypeAlias",
            parentKind: "EntryPoint",
            signature,
            ...metadata,
          },
        ],
      },
    ],
  };
}
async function compareAlias(before: PublicApiSnapshot, after: PublicApiSnapshot) {
  return await classifyPublicApiChange(
    before,
    after,
    signatureFingerprint,
    undefined,
    signatureProof,
  );
}

// Exact excerpts retained from Get Modular's immutable native baseline and its
// Oxfmt 0.74 candidate on 2026-10-22. Neither source is generated by this proof.
void test("redundant type parentheses preserve the actual Get Modular IsUnion signature in both directions", async () => {
  const before = aliasSnapshot(
    "export type IsUnion<T, Whole = T> = T extends Whole ? [\n    Whole\n] extends [\n    T\n] ? false : true : never;",
  );
  const after = aliasSnapshot(
    "export type IsUnion<T, Whole = T> = T extends Whole ? ([\n    Whole\n] extends [\n    T\n] ? false : true) : never;",
  );
  const raw = JSON.stringify([before, after]);
  assert.equal(
    (await classifyPublicApiChange(before, after, signatureFingerprint)).classification,
    "breaking",
  );
  assert.equal((await compareAlias(before, after)).classification, "none");
  assert.equal((await compareAlias(after, before)).classification, "none");
  assert.equal(JSON.stringify([before, after]), raw);
});
void test("redundant type parentheses preserve the actual Get Modular ValidDeclaration signature in both directions", async () => {
  const before = aliasSnapshot(
    'export type ValidDeclaration<C, D extends ModuleDeclaration> = true extends IsUnion<D> | IsUnion<D["slots"]> | IsUnion<D["provides"]> | (D["slots"] extends infer Slots extends readonly unknown[] ? {\n    [K in keyof Slots]: IsUnion<Slots[K]>;\n}[number] : never) | (D["provides"] extends infer Provides extends readonly unknown[] ? {\n    [K in keyof Provides]: IsUnion<Provides[K]>;\n}[number] : never) ? never : number extends D["provides"]["length"] | D["slots"]["length"] ? never : [\n    (D["provides"][number] | D["slots"][number] extends infer P ? P extends {\n        readonly capabilityId: infer K extends string;\n        readonly compatibility: infer T;\n    } ? string extends K ? P : true extends IsUnion<K> ? P : K extends keyof C ? [\n        T,\n        (K extends keyof C ? C[K] extends {\n            readonly compatibility: infer Compat;\n        } ? Compat : never : never)\n    ] extends [\n        (K extends keyof C ? C[K] extends {\n            readonly compatibility: infer Compat;\n        } ? Compat : never : never),\n        T\n    ] ? never : P : P : P : never) | (D["slots"][number] extends infer S ? S extends {\n        readonly slotId: infer K extends string;\n        readonly cardinality: {\n            readonly kind: infer Q;\n        };\n    } ? string extends K ? S : true extends IsUnion<K> | IsUnion<Q> ? S : never : S : never)\n] extends [\n    never\n] ? unknown : never;',
  );
  const after = aliasSnapshot(
    'export type ValidDeclaration<C, D extends ModuleDeclaration> = true extends IsUnion<D> | IsUnion<D["slots"]> | IsUnion<D["provides"]> | (D["slots"] extends infer Slots extends readonly unknown[] ? {\n    [K in keyof Slots]: IsUnion<Slots[K]>;\n}[number] : never) | (D["provides"] extends infer Provides extends readonly unknown[] ? {\n    [K in keyof Provides]: IsUnion<Provides[K]>;\n}[number] : never) ? never : number extends D["provides"]["length"] | D["slots"]["length"] ? never : [\n    (D["provides"][number] | D["slots"][number] extends infer P ? P extends {\n        readonly capabilityId: infer K extends string;\n        readonly compatibility: infer T;\n    } ? string extends K ? P : true extends IsUnion<K> ? P : K extends keyof C ? [\n        T,\n        K extends keyof C ? C[K] extends {\n            readonly compatibility: infer Compat;\n        } ? Compat : never : never\n    ] extends [\n        K extends keyof C ? C[K] extends {\n            readonly compatibility: infer Compat;\n        } ? Compat : never : never,\n        T\n    ] ? never : P : P : P : never) | (D["slots"][number] extends infer S ? S extends {\n        readonly slotId: infer K extends string;\n        readonly cardinality: {\n            readonly kind: infer Q;\n        };\n    } ? string extends K ? S : true extends IsUnion<K> | IsUnion<Q> ? S : never : S : never)\n] extends [\n    never\n] ? unknown : never;',
  );
  const raw = JSON.stringify([before, after]);
  assert.equal(
    (await classifyPublicApiChange(before, after, signatureFingerprint)).classification,
    "breaking",
  );
  assert.equal((await compareAlias(before, after)).classification, "none");
  assert.equal((await compareAlias(after, before)).classification, "none");
  assert.equal(JSON.stringify([before, after]), raw);
});

for (const [before, after] of [
  ["export type Alias<A, B> = (A | B)[];", "export type Alias<A, B> = A | B[];"],
  [
    "export type Alias<T> = T extends string ? (true) : false;",
    "export type Alias<T> = T extends string ? false : (true);",
  ],
  ["export type Alias<T> = (T);", "export type Alias<U> = (U);"],
  ["export type Alias = (Left);", "export type Alias = (Right);"],
  ["export type Alias<T> = keyof (T);", "export type Alias<T> = readonly (T)[];"],
  ["export type Alias<A, B, C> = ((A | B) & C);", "export type Alias<A, B, C> = (A | (B & C));"],
  ["export type Alias<A, B> = (() => A) | B;", "export type Alias<A, B> = () => (A | B);"],
  ['export type Alias = ("left");', 'export type Alias = ("right");'],
] as const) {
  void test(`type parenthesis proof preserves binding and every other token: ${before}`, async () => {
    const left = aliasSnapshot(before),
      right = aliasSnapshot(after);
    assert.equal((await compareAlias(left, right)).classification, "breaking");
    assert.equal((await compareAlias(right, left)).classification, "breaking");
    assert.equal(
      (await compareAlias(left, right)).fingerprint,
      (await classifyPublicApiChange(left, right, signatureFingerprint)).fingerprint,
    );
  });
}

void test("parenthesis proof refuses malformed, unsupported, metadata-drifted and over-budget inputs", async () => {
  const before = aliasSnapshot("export type Alias<T> = T extends string ? (true) : false;");
  const after = aliasSnapshot("export type Alias<T> = T extends string ? true : false;");
  for (const unsupported of [
    aliasSnapshot("export type Alias<T> = T extends string ? (true) : ;"),
    aliasSnapshot(after.entrypoints[0]!.items[0]!.signature, { kind: "Interface" }),
    aliasSnapshot(after.entrypoints[0]!.items[0]!.signature, { parentKind: "Namespace" }),
    aliasSnapshot(after.entrypoints[0]!.items[0]!.signature, {
      parentReference: "syntax-fixture!Other:namespace",
    }),
    aliasSnapshot(after.entrypoints[0]!.items[0]!.signature, {
      canonicalReference: "syntax-fixture!Other:type",
    }),
    { ...after, extractorVersion: "api-extractor/historical" },
  ]) {
    assert.equal((await compareAlias(before, unsupported)).classification, "breaking");
    assert.equal((await compareAlias(unsupported, before)).classification, "breaking");
  }
});

void test("unsupported alias forms and work limits never become a parenthesis proof", async () => {
  for (const [before, after] of [
    ["export type Alias<T> = `prefix${T}`;", "export type Alias<T> = (`prefix${T}`);"],
    [
      "export type Alias = string; export type Extra = number;",
      "export type Alias = (string); export type Extra = number;",
    ],
    [
      "export type Alias = string;",
      "export type Alias = " + "(".repeat(130) + "string" + ")".repeat(130) + ";",
    ],
    ["export type Alias = string;", "export type Alias = (string);" + " ".repeat(10_000)],
  ] as const) {
    assert.equal(
      (await compareAlias(aliasSnapshot(before), aliasSnapshot(after))).classification,
      "breaking",
    );
    assert.equal(
      (await compareAlias(aliasSnapshot(after), aliasSnapshot(before))).classification,
      "breaking",
    );
  }
});

registerNativeSpellingCases(aliasSnapshot, compareAlias);
registerNativeAsyncSignatureCases();
registerAsyncClassificationCases();
