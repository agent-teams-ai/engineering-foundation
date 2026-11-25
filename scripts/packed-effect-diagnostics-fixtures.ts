import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

export function rows(value: unknown): readonly Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map(record);
}

type CheckInstalledEffectFixture = (
  projects: readonly string[],
  outcome: string,
  exitCode: number,
  cancelled?: boolean,
) => Promise<Record<string, unknown>>;

async function qualifyMultilineDiagnostics(
  root: string,
  check: CheckInstalledEffectFixture,
): Promise<void> {
  const source =
    'const source = { response: { count: "wrong" } };\n' +
    "export const result: { response: { count: number } } = source;\n";
  const rejected = await writeEffectProject(root, "ordinary-chain", source);
  const accepted = await writeEffectProject(
    root,
    "after-chain",
    'export const ready: string = "checked";\n',
  );
  const before = await readFile(join(root, rejected));
  const details = await check([rejected, accepted], "diagnostics", 1);
  assert.deepEqual(details["selected"], [rejected, accepted]);
  assert.deepEqual(details["unattempted"], []);
  const projects = rows(details["projects"]);
  assert.deepEqual(
    projects.map((project) => [project["project"], project["status"], project["diagnosticCodes"]]),
    [
      [rejected, "diagnostics", [2322]],
      [accepted, "passed", []],
    ],
  );
  const diagnostic = String(projects[0]?.["stdout"]);
  assert.match(diagnostic, /index\.ts\(2,14\): error TS2322:/u);
  assert.match(
    diagnostic,
    /\r?\n {2}The types of 'response\.count' are incompatible between these types\.\r?\n {4}Type 'string' is not assignable to type 'number'\./u,
  );
  assert.equal(projects[0]?.["stderr"], "");
  assert.equal(projects[1]?.["stdout"], "");
  assert.equal(projects[1]?.["stderr"], "");
  assert.equal(await readFile(join(root, "ordinary-chain/index.ts"), "utf8"), source);
  assert.deepEqual(await readFile(join(root, rejected)), before);
}

export const strictEffectCompilerOptions = Object.freeze({
  strict: true,
  skipLibCheck: false,
  noEmit: true,
  target: "ES2024",
  module: "NodeNext",
  moduleResolution: "NodeNext",
  types: [],
  lib: ["ES2024", "ESNext.Disposable", "ESNext.Promise", "DOM"],
  allowImportingTsExtensions: true,
});

export function effectFixturePlugin(allowedUnstableApis: readonly string[] = []) {
  return {
    name: "@effect/language-service",
    diagnostics: true,
    includeSuggestionsInTsc: false,
    ignoreEffectWarningsInTscExitCode: false,
    ignoreEffectErrorsInTscExitCode: false,
    diagnosticSeverity: { unstableApiUsage: "error", apiStabilityLeak: "error" },
    allowedUnstableApis,
  };
}

export async function writeEffectProject(
  root: string,
  name: string,
  source: string,
  allowed: readonly string[] = [],
  configuration: {
    readonly compilerOptions?: Readonly<Record<string, unknown>>;
    readonly files?: readonly string[];
  } = {},
): Promise<string> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "index.ts"), source);
  const project = `${name}/tsconfig.json`;
  await writeFile(
    join(root, project),
    JSON.stringify(
      {
        files: configuration.files ?? ["index.ts"],
        compilerOptions: {
          ...strictEffectCompilerOptions,
          plugins: [effectFixturePlugin(allowed)],
          ...configuration.compilerOptions,
        },
      },
      null,
      2,
    ),
  );
  return project;
}

async function qualifyInheritedOverrides(
  root: string,
  check: CheckInstalledEffectFixture,
  source: string,
): Promise<void> {
  const project = await writeEffectProject(root, "inherited-overrides", source);
  const filename = join(root, project);
  const leaf = JSON.stringify({
    ...record(JSON.parse(await readFile(filename, "utf8"))),
    extends: "./parent.json",
  });
  const parent = JSON.stringify({
    compilerOptions: {
      plugins: [
        {
          ...effectFixturePlugin(),
          overrides: [
            {
              include: ["./**/*.ts"],
              options: { diagnosticSeverity: { unstableApiUsage: "off", apiStabilityLeak: "off" } },
            },
          ],
        },
      ],
    },
  });
  const parentPath = join(root, "inherited-overrides/parent.json");
  await writeFile(filename, leaf);
  await writeFile(parentPath, parent);
  assert.equal((await check([project], "invalid-input", 2))["reason"], "EFFECT_PROJECT_EXTENDS");
  assert.equal(await readFile(filename, "utf8"), leaf);
  assert.equal(await readFile(parentPath, "utf8"), parent);
  assert.equal(await readFile(join(root, "inherited-overrides/index.ts"), "utf8"), source);
}

async function qualifyInputPolicy(root: string, check: CheckInstalledEffectFixture): Promise<void> {
  const safe = 'export const ready: string = "ready";\n';
  for (const [id, options] of [
    ["missing-policy", { plugins: [] }],
    ["unchecked", { noCheck: true }],
    ["skipped-libraries", { skipLibCheck: true }],
  ] as const) {
    const project = await writeEffectProject(root, id, safe, [], { compilerOptions: options });
    await check([project], "invalid-input", 2);
  }
  const unstable = 'import { get } from "effect/http/HttpClient";\n';
  const use = 'export const request = get("https://example.invalid");\n';
  await qualifyInheritedOverrides(root, check, unstable + use);
  for (const policy of [
    {
      id: "effect",
      direct: unstable + "// @effect-diagnostics-next-line unstableApiUsage:off\n" + use,
      imported: "// @effect-diagnostics *:skip-file\n" + unstable + use,
      reason: "EFFECT_SOURCE_DIRECTIVE",
    },
    {
      id: "typescript",
      direct: "// @ts-nocheck\n" + unstable + use,
      imported: "// @ts-nocheck\n" + unstable + use,
      reason: "EFFECT_SOURCE_NOCHECK",
    },
  ]) {
    const project = await writeEffectProject(root, `${policy.id}-suppressed`, policy.direct);
    assert.equal((await check([project], "invalid-input", 2))["reason"], policy.reason);
    const imported = await writeEffectProject(
      root,
      `${policy.id}-imported-suppression`,
      'import "./suppressed.ts";\n' + safe,
      [],
      { files: ["index.ts", "suppressed.ts"] },
    );
    const filename = join(root, `${policy.id}-imported-suppression/suppressed.ts`);
    await writeFile(filename, policy.imported);
    assert.equal((await check([imported], "invalid-input", 2))["reason"], policy.reason);
    assert.equal(await readFile(filename, "utf8"), policy.imported);
  }
  const declarationProject = await writeEffectProject(
    root,
    "local-declaration",
    'import type { LocalPort } from "./local.js";\n' +
      'export const port: LocalPort = { value: "ready" };\n',
    [],
    { files: ["index.ts", "local.d.ts"] },
  );
  const declaration = "export interface LocalPort { readonly value: string; }\n";
  await writeFile(join(root, "local-declaration/local.d.ts"), declaration);
  const declarationFailure = await check([declarationProject], "invalid-input", 2);
  assert.equal(declarationFailure["reason"], "EFFECT_DECLARATION_SOURCE_UNSUPPORTED");
  assert.equal(await readFile(join(root, "local-declaration/local.d.ts"), "utf8"), declaration);
  const composite = await writeEffectProject(root, "incremental", safe, [], {
    compilerOptions: {
      composite: true,
      incremental: true,
      tsBuildInfoFile: "unexpected.tsbuildinfo",
    },
  });
  const config = await readFile(join(root, composite));
  const source = await readFile(join(root, "incremental/index.ts"));
  await check([composite], "passed", 0);
  assert.deepEqual(await readFile(join(root, composite)), config);
  assert.deepEqual(await readFile(join(root, "incremental/index.ts")), source);
  await assert.rejects(readFile(join(root, "incremental/unexpected.tsbuildinfo")), {
    code: "ENOENT",
  });
  await check([composite], "cancelled", 130, true);
}

async function qualifyWorkspaceRoots(
  root: string,
  consumerRoot: string,
  check: CheckInstalledEffectFixture,
): Promise<void> {
  const name = "foundation-effect-workspace-fixture";
  const packageRoot = join(root, "packages/linked");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name,
      version: "0.0.0",
      private: true,
      type: "module",
      exports: "./index.ts",
    }),
  );
  const source =
    'import { get } from "effect/http/HttpClient";\n' +
    'export const request = get("https://example.invalid");\n';
  await writeFile(join(packageRoot, "index.ts"), source);
  const main = `import { request } from "${name}";\nexport const application = request;\n`;
  const project = await writeEffectProject(root, "workspace-host", main);
  const before = await readFile(join(root, project));
  const completeProject = "workspace-host/complete.json";
  await writeFile(
    join(root, completeProject),
    JSON.stringify({
      ...record(JSON.parse(before.toString("utf8"))),
      files: ["index.ts", "../packages/linked/index.ts"],
    }),
  );
  // Only this disposable installation gets the temporary workspace link. None of
  // the five verified upstream package payloads is modified or replaced.
  const link = join(consumerRoot, "node_modules", name);
  await symlink(packageRoot, link, "dir");
  try {
    assert.equal(
      (await check([project], "invalid-input", 2))["reason"],
      "EFFECT_SOURCE_ROOT_CLOSURE",
    );
    const details = await check([completeProject], "diagnostics", 1);
    const projects = rows(details["projects"]);
    assert.equal(projects.length, 1);
    assert.equal(projects[0]?.["project"], completeProject);
    assert.equal(projects[0]?.["status"], "diagnostics");
    assert.deepEqual(projects[0]?.["diagnosticCodes"], [377136]);
    assert.deepEqual(projects[0]?.["sourceFiles"], [
      "packages/linked/index.ts",
      "workspace-host/index.ts",
    ]);
    assert.match(
      String(projects[0]?.["stdout"]),
      /packages\/linked\/index\.ts\(2,\d+\): error TS377136:/u,
    );
    assert.deepEqual(details["unattempted"], []);
    assert.equal(projects[0]?.["stderr"], "");
    assert.equal(await readFile(join(packageRoot, "index.ts"), "utf8"), source);
    assert.equal(await readFile(join(root, "workspace-host/index.ts"), "utf8"), main);
    assert.deepEqual(await readFile(join(root, project)), before);
  } finally {
    await rm(link);
  }
}

/** Installed public invocation stays with the caller; these fixtures only assert policy. */
export async function qualifyEffectFixturePolicies(
  root: string,
  consumerRoot: string,
  check: CheckInstalledEffectFixture,
): Promise<void> {
  await qualifyMultilineDiagnostics(root, check);
  await qualifyInputPolicy(root, check);
  await qualifyWorkspaceRoots(root, consumerRoot, check);
}

const sdk = `import type * as Effect from "effect/Effect";
export type EffectVersionAnchor = Effect.Effect<void>;
/** @stability stable */
export interface ReadPort { readonly read: (key: string) => Promise<string>; }
`;

const backend = `import { defineContract, declareModule, type CapabilitiesOf } from "@get-modular/assembly";
import { required } from "@get-modular/core";
import { effectFor, implement } from "@get-modular/effect";
import { Context, Effect } from "effect";
import type { ReadPort } from "../sdk/index.ts";
interface Store { readonly get: Effect.Effect<string>; }
const StorePort = defineContract<Store>()({ id: "fixture/store", revision: 1 });
interface Ports extends CapabilitiesOf<typeof StorePort> {}
const owner = { authority: "fixture", path: ["backend"] };
const store = implement<Ports>()(declareModule({
  moduleId: "fixture/store", implementationId: "fixture/store/memory", owner,
  provides: [StorePort.provide()], slots: [],
}), () => Effect.sync(() => {
  const value: Store = { get: Effect.succeed("foundation-ready") };
  return { instance: value, capabilities: { [StorePort.id]: value } };
}));
const app = implement<Ports>()(declareModule({
  moduleId: "fixture/app", implementationId: "fixture/app/default", owner,
  provides: [], slots: [StorePort.slot("store", required())],
}), ({ store }) => Effect.succeed({ instance: store, capabilities: {} }));
class Roots extends Context.Service<Roots, { readonly app: Store }>()("fixture/Roots") {}
export async function read(_key: string): Promise<string> {
  const result = await effectFor<Ports>().prepare({
    profileId: "fixture/backend", modules: [store, app], roots: { app },
  });
  if (result.status !== "prepared") throw new Error("Fixture composition rejected");
  return Effect.runPromise(Effect.provide(
    Effect.flatMap(Roots, (roots) => roots.app.get), result.prepared.layer(Roots),
  ));
}
export const adapter: ReadPort = { read };
`;

const frontend = `import type { ReadPort } from "../sdk/index.ts";
export async function renderLabel(port: ReadPort): Promise<string> {
  return "Status: " + await port.read("status");
}
export const browserContract: (target: EventTarget) => void = (target) => {
  target.dispatchEvent(new Event("ready"));
};
`;

/** Independent composition and portable boundary contracts, not a browser Host. */
export async function writeEffectBoundaryProjects(root: string): Promise<readonly string[]> {
  return [
    await writeEffectProject(root, "sdk", sdk),
    await writeEffectProject(root, "backend", backend, [], {
      files: ["index.ts", "../sdk/index.ts"],
    }),
    await writeEffectProject(root, "frontend", frontend, [], {
      compilerOptions: { module: "ESNext", moduleResolution: "Bundler" },
      files: ["index.ts", "../sdk/index.ts"],
    }),
  ];
}
