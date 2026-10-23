import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import type {
  PublicApiPackagePolicy,
  PublicApiSnapshot,
} from "../src/capabilities/public-api-compatibility/application/model/public-api.js";
import { TypeScriptPublicApiExtractor } from "../dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/microsoft-public-api-extractor.js";
import { withNativePublicApiProject } from "../dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/native-public-api-engine.js";
import {
  readContainedRegularFile,
  pathTraversesSymbolicLink,
} from "../dist/source-inventory/node.js";
import {
  classifyPublicApiChange,
  evaluatePublicApiCompatibility,
} from "../dist/capabilities/public-api-compatibility/application/policies/evaluate-public-api-compatibility.js";

const extractor = new TypeScriptPublicApiExtractor({
  files: { read: readContainedRegularFile },
  paths: { traversesSymbolicLink: pathTraversesSymbolicLink },
});

async function fixture(
  source: string,
  action: (root: string, policy: PublicApiPackagePolicy) => Promise<void>,
  options: {
    readonly compilerOptions?: Readonly<Record<string, unknown>>;
    readonly extraFiles?: Readonly<Record<string, string>>;
    readonly inherited?: boolean;
    readonly packageType?: "commonjs" | "module";
  } = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "foundation-native-extraction-"));
  try {
    await mkdir(join(root, "dist"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "native-fixture",
        version: "1.0.0",
        type: options.packageType ?? "module",
        exports: { ".": { types: "./dist/index.d.ts" } },
      }),
    );
    const compilerOptions = {
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      target: "ES2024",
      types: [],
      ...options.compilerOptions,
    };
    if (options.inherited === true) {
      await writeFile(join(root, "tsconfig.base.json"), JSON.stringify({ compilerOptions }));
    }
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        ...(options.inherited === true ? { extends: "./tsconfig.base.json" } : { compilerOptions }),
        files: ["dist/index.d.ts"],
      }),
    );
    await writeFile(join(root, "dist/index.d.ts"), source);
    for (const [path, contents] of Object.entries(options.extraFiles ?? {})) {
      await writeFile(join(root, path), contents);
    }
    await action(root, {
      packageName: "native-fixture",
      packageRoot: ".",
      manifestPath: "package.json",
      tsconfigPath: "tsconfig.json",
      entrypoints: [{ exportPath: ".", declarationEntryPoint: "dist/index.d.ts" }],
      nonTypeExports: [],
      releasedBaselinePath: "architecture/public-api/native-fixture.json",
      approvedBreakingChanges: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function items(snapshot: PublicApiSnapshot) {
  assert.equal(snapshot.extractorVersion, "typescript-native/7.0.2");
  assert.equal(snapshot.entrypoints?.length, 1);
  assert(snapshot.entrypoints);
  const entrypoint = snapshot.entrypoints[0];
  assert(entrypoint);
  assert.equal(entrypoint.exportPath, ".");
  return entrypoint.items;
}

test("native declaration projects use one canonical virtual config path without physical writes", async () => {
  const source = "export declare const stable: string;\n";
  await fixture(source, async (root) => {
    const configPath = join(root, "tsconfig.json");
    const declarationEntryPoint = join(root, "dist/index.d.ts");
    const originalConfig = await readFile(configPath, "utf8");
    const generatedPath = join(root, ".foundation-native-api.tsconfig.json").replaceAll("\\", "/");
    await withNativePublicApiProject(
      {
        cwd: root,
        configPath,
        declarationEntryPoint,
        files: new Map([
          [configPath, originalConfig],
          [declarationEntryPoint, source],
          [join(root, "package.json"), await readFile(join(root, "package.json"), "utf8")],
        ]),
      },
      async (context) => {
        assert.equal(context.project.configFileName, generatedPath);
        assert.ok(context.files.has(generatedPath));
        assert.ok([...context.files.keys()].every((path) => !path.includes("\\")));
        assert.equal((await context.program.getSourceFile(declarationEntryPoint))?.text, source);
        assert.ok(context.readFiles.has(resolve(generatedPath)));
      },
    );
    assert.equal(await readFile(configPath, "utf8"), originalConfig);
    await assert.rejects(readFile(join(root, ".foundation-native-api.tsconfig.json")), {
      code: "ENOENT",
    });
  });
});

test("native extraction retains literal public identities across ordinary declaration kinds", async () => {
  const source =
    'declare const brand: unique symbol; export type Box<T = string> = { readonly [brand]: T }; export declare const make: <T>(x: T) => Box<T>; export declare function f(x: string): string; export declare function f(x: number): number; export interface Callable { (x: number): string; new(x: string): Box; readonly [x: number]: string; } export declare class C { constructor(); static n: number; protected x: string; m<T>(x:T): T; get value(): number; set value(x: number); } export enum E { A, B = 2 } export * as tools from "./tools.js";\n';
  await fixture(
    source,
    async (root, policy) => {
      const snapshot = await extractor.extract(root, policy, "1.0.0");
      const actual = items(snapshot);
      assert.deepEqual(
        actual.map((item) => [item.canonicalReference, item.kind]),
        [
          ["native-fixture!Box:type", "TypeAlias"],
          ["native-fixture!C#m:member(1)", "Method"],
          ["native-fixture!C#value:member", "Property"],
          ["native-fixture!C#x:member", "Property"],
          ["native-fixture!C.n:member", "Property"],
          ["native-fixture!C:class", "Class"],
          ["native-fixture!C:constructor(1)", "Constructor"],
          ["native-fixture!Callable:call(1)", "CallSignature"],
          ["native-fixture!Callable:index(1)", "IndexSignature"],
          ["native-fixture!Callable:interface", "Interface"],
          ["native-fixture!Callable:new(1)", "ConstructSignature"],
          ["native-fixture!E.A:member", "EnumMember"],
          ["native-fixture!E.B:member", "EnumMember"],
          ["native-fixture!E:enum", "Enum"],
          ["native-fixture!f:function(1)", "Function"],
          ["native-fixture!f:function(2)", "Function"],
          ["native-fixture!make:function(1)", "Function"],
          ["native-fixture!tools.inspect:function(1)", "Function"],
          ["native-fixture!tools:namespace", "Namespace"],
        ],
      );
      assert.equal(
        actual.find((item) => item.canonicalReference === "native-fixture!make:function(1)")
          ?.signature,
        "make: <T>(x: T) => Box<T>",
      );
      assert.equal(
        actual.find((item) => item.canonicalReference === "native-fixture!C:class")?.signature,
        "export declare class C",
      );
      assert.deepEqual(await extractor.extract(root, policy, "1.0.0"), snapshot);
    },
    { extraFiles: { "dist/tools.d.ts": "export declare function inspect(): void;\n" } },
  );
});

for (const inherited of [false, true]) {
  for (const option of ["noCheck", "skipLibCheck", "skipDefaultLibCheck"]) {
    test(`native extraction independently checks declarations despite ${inherited ? "inherited" : "direct"} ${option}`, async () => {
      await fixture(
        "export declare function f(): Missing;\n",
        async (root, policy) => {
          const originalConfig = await readFile(join(root, "tsconfig.json"), "utf8");
          await assert.rejects(
            extractor.extract(root, policy, "1.0.0"),
            (error: unknown) => error instanceof Error && /TS2304/u.test(error.message),
          );
          await writeFile(join(root, "dist/index.d.ts"), "export declare function f(): string;\n");
          assert.deepEqual(
            items(await extractor.extract(root, policy, "1.0.0")).map(
              (item) => item.canonicalReference,
            ),
            ["native-fixture!f:function(1)"],
          );
          assert.equal(await readFile(join(root, "tsconfig.json"), "utf8"), originalConfig);
        },
        { compilerOptions: { [option]: true }, inherited },
      );
    });
  }
}

test("plain hidden symbols remain forgotten exports; the unique-symbol brand control remains valid", async () => {
  await fixture(
    "declare const hidden: symbol; declare function f(v: typeof hidden): void; export { f };\n",
    async (root, policy) => {
      await assert.rejects(
        extractor.extract(root, policy, "1.0.0"),
        (error: unknown) => error instanceof Error && /ae-forgotten-export/u.test(error.message),
      );
      await writeFile(
        join(root, "dist/index.d.ts"),
        "declare const brand: unique symbol; export interface Branded { readonly [brand]: true; }\n",
      );
      assert.ok(
        items(await extractor.extract(root, policy, "1.0.0")).some(
          (item) => item.canonicalReference === "native-fixture!Branded:interface",
        ),
      );
    },
  );
});

test("static and instance overloads keep independent stable identities", async () => {
  await fixture(
    "export declare class C { static m(x: string): number; m(x: number): string; }\n",
    async (root, policy) => {
      const withStatic = items(await extractor.extract(root, policy, "1.0.0"));
      assert.deepEqual(
        withStatic.filter((item) => item.kind === "Method").map((item) => item.canonicalReference),
        ["native-fixture!C#m:member(1)", "native-fixture!C.m:member(1)"],
      );
      await writeFile(
        join(root, "dist/index.d.ts"),
        "export declare class C { m(x: number): string; }\n",
      );
      const withoutStatic = items(await extractor.extract(root, policy, "1.0.0"));
      assert.deepEqual(
        withoutStatic.find((item) => item.kind === "Method"),
        withStatic.find((item) => item.canonicalReference === "native-fixture!C#m:member(1)"),
      );
    },
  );
});

test("a type exported through a public namespace is consumable without a duplicate top-level export", async () => {
  const use =
    'import type { Visible } from "./types.js"; export declare function f(x: Visible): Visible;\n';
  await fixture(
    `${use}export * as types from "./types.js";\n`,
    async (root, policy) => {
      assert.deepEqual(
        items(await extractor.extract(root, policy, "1.0.0")).map(
          (item) => item.canonicalReference,
        ),
        [
          "native-fixture!f:function(1)",
          "native-fixture!types.Visible#value:member",
          "native-fixture!types.Visible:interface",
          "native-fixture!types:namespace",
        ],
      );
      await writeFile(join(root, "dist/index.d.ts"), use);
      await assert.rejects(
        extractor.extract(root, policy, "1.0.0"),
        (error: unknown) => error instanceof Error && /ae-forgotten-export/u.test(error.message),
      );
    },
    { extraFiles: { "dist/types.d.ts": "export interface Visible { value: string; }\n" } },
  );
});

test("native observations cannot qualify a legacy baseline even when every declaration is identical", async () => {
  await fixture("export declare function stable(): string;\n", async (root, policy) => {
    const current = await extractor.extract(root, policy, "1.0.0");
    const released: PublicApiSnapshot = { ...current, extractorVersion: "7.58.12" };
    const retained = JSON.stringify(released);
    const fingerprint = {
      sha256: (value: string) => createHash("sha256").update(value).digest("hex"),
    };
    const change = classifyPublicApiChange(released, current, fingerprint);
    assert.equal(change.classification, "none");
    const input = {
      policy,
      released,
      current,
      change,
      releaseEvidence: { packageName: policy.packageName, packageVersion: "1.0.0" },
      acceptedDecision: undefined,
    };
    const rejected = evaluatePublicApiCompatibility(input);
    assert.deepEqual(
      rejected.map((diagnostic) => diagnostic.ruleId),
      ["package.public-api-compatibility.baseline-tool-mismatch"],
    );
    assert.deepEqual(evaluatePublicApiCompatibility({ ...input, released: current }), []);
    assert.equal(JSON.stringify(released), retained);
  });
});

for (const members of [
  "static get value(): string; set value(x: number);",
  "get value(): string; static set value(x: number);",
]) {
  test(`native accessor pairing preserves both scopes: ${members}`, async () => {
    await fixture(`export declare class C { ${members} }\n`, async (root, policy) => {
      assert.deepEqual(
        items(await extractor.extract(root, policy, "1.0.0"))
          .filter((item) => item.kind === "Property")
          .map((item) => item.canonicalReference),
        ["native-fixture!C#value:member", "native-fixture!C.value:member"],
      );
    });
  });
}

test("paired accessors retain setter changes in the actual compatibility decision", async () => {
  await fixture(
    "export declare class C { get value(): string; set value(x: string | number); }\n",
    async (root, policy) => {
      const original = await extractor.extract(root, policy, "1.0.0");
      const property = items(original).find(
        (item) => item.canonicalReference === "native-fixture!C#value:member",
      );
      assert.equal(property?.signature, "get value(): string;\nset value(x: string | number);");
      const fingerprint = {
        sha256: (value: string) => createHash("sha256").update(value).digest("hex"),
      };
      for (const members of [
        "get value(): string;",
        "get value(): string; set value(x: string);",
      ]) {
        await writeFile(join(root, "dist/index.d.ts"), `export declare class C { ${members} }\n`);
        const changed = await extractor.extract(root, policy, "1.0.0");
        assert.equal(
          classifyPublicApiChange(original, changed, fingerprint).classification,
          "breaking",
        );
        assert.notEqual(
          items(changed).find((item) => item.canonicalReference === property?.canonicalReference)
            ?.signature,
          property?.signature,
        );
      }
      await writeFile(
        join(root, "dist/index.d.ts"),
        "interface Hidden { value: string; } export declare class C { get value(): string; set value(x: Hidden); }\n",
      );
      assert.ok(
        items(await extractor.extract(root, policy, "1.0.0")).some(
          (item) => item.canonicalReference === "native-fixture!Hidden:interface",
        ),
      );
      // An explicit export list makes Hidden private in an ambient declaration module.
      await writeFile(
        join(root, "dist/index.d.ts"),
        "interface Hidden { value: string; } declare class C { get value(): string; set value(x: Hidden); } export { C };\n",
      );
      await assert.rejects(
        extractor.extract(root, policy, "1.0.0"),
        (error: unknown) => error instanceof Error && /ae-forgotten-export/u.test(error.message),
      );
    },
  );
});

for (const declaration of [
  "declare class C { value: string; } export = C;",
  "declare function f(): string; export = f;",
]) {
  test(`CommonJS export assignment cannot silently qualify an empty surface: ${declaration}`, async () => {
    await fixture(
      `${declaration}\n`,
      async (root, policy) => {
        await assert.rejects(
          extractor.extract(root, policy, "1.0.0"),
          (error: unknown) =>
            error instanceof Error && /native-export-assignment/u.test(error.message),
        );
        await writeFile(
          join(root, "dist/index.d.ts"),
          "export declare class C { value: string; }\n",
        );
        assert.ok(
          items(await extractor.extract(root, policy, "1.0.0")).some(
            (item) => item.canonicalReference === "native-fixture!C:class",
          ),
        );
      },
      { packageType: "commonjs" },
    );
  });
}

test("whole-module import types cannot silently qualify a surface without dependency edges", async () => {
  await fixture(
    'export type Module = typeof import("./tools.js");\n',
    async (root, policy) => {
      await assert.rejects(
        extractor.extract(root, policy, "1.0.0"),
        (error: unknown) =>
          error instanceof Error && /native-whole-module-import-reference/u.test(error.message),
      );
    },
    { extraFiles: { "dist/tools.d.ts": "export declare function inspect(): void;\n" } },
  );
});

test("curated SDK authority entrypoint has no forgotten public type exports", async () => {
  const root = resolve(".");
  const manifest = JSON.parse(
    await readFile(join(root, "packages/engineering-foundation/package.json"), "utf8"),
  ) as { readonly name: string; readonly version: string };
  const snapshot = await extractor.extract(
    root,
    {
      packageName: manifest.name,
      packageRoot: "packages/engineering-foundation",
      manifestPath: "packages/engineering-foundation/package.json",
      tsconfigPath: "packages/engineering-foundation/tsconfig.json",
      entrypoints: [
        {
          exportPath: "./sdk-growth-authority",
          declarationEntryPoint: "packages/engineering-foundation/dist/sdk-growth-authority.d.ts",
        },
      ],
      nonTypeExports: [],
      releasedBaselinePath: "architecture/public-api/engineering-foundation.json",
      approvedBreakingChanges: [],
    },
    manifest.version,
  );
  assert.equal(snapshot.extractorVersion, "typescript-native/7.0.2");
  assert.equal(snapshot.entrypoints?.length, 1);
  assert(snapshot.entrypoints);
  assert.equal(snapshot.entrypoints[0]?.exportPath, "./sdk-growth-authority");
  assert.ok((snapshot.entrypoints[0]?.items.length ?? 0) > 0);
  assert.ok(
    snapshot.entrypoints[0]?.items.some(
      (item) =>
        item.canonicalReference ===
        "@agent-teams/engineering-foundation!createSdkGrowthAuthorityVerifier:function(1)",
    ),
  );
});
