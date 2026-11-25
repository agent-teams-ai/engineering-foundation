import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
  compilerOptions: Readonly<Record<string, unknown>> = {},
): Promise<string> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "index.ts"), source);
  const project = `${name}/tsconfig.json`;
  await writeFile(
    join(root, project),
    JSON.stringify(
      {
        files: ["index.ts"],
        compilerOptions: {
          ...strictEffectCompilerOptions,
          plugins: [effectFixturePlugin(allowed)],
          ...compilerOptions,
        },
      },
      null,
      2,
    ),
  );
  return project;
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
    await writeEffectProject(root, "backend", backend),
    await writeEffectProject(root, "frontend", frontend),
  ];
}
