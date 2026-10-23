import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { createSourceCensusReader } from "../../../packages/engineering-foundation/dist/capabilities/source-dependencies/module.js";
import { readContainedRegularFile } from "../../../packages/engineering-foundation/dist/source-inventory/node.js";
import { copyInstalledToolchainPresets } from "./copied-toolchain.mjs";
export const moduleRoot = "packages/contexts/private-worker";
export const sourceRoot = `${moduleRoot}/src`;
export const main = `${sourceRoot}/main.ts`;
export const compilerProject = `${sourceRoot}/tsconfig.json`;
export const topology = {
  productionRoots: ["packages"],
  applicationRoots: [],
  excludedRoots: ["spikes"],
  modules: [{ root: moduleRoot, sourceRoot, testRoots: [`${moduleRoot}/tests`] }],
} as const;
export const authority = {
  workspaceManifestPath: "pnpm-workspace.yaml",
  boundaries: [{ id: "worker", roots: [sourceRoot] }],
} as const;
export const censusReader = createSourceCensusReader({ read: readContainedRegularFile });

export interface SourceObservationFixture {
  readonly root: string;
  readonly put: (path: string, value: string) => Promise<void>;
  readonly census: () => ReturnType<typeof censusReader.read>;
}

export async function fixture(t: TestContext): Promise<SourceObservationFixture> {
  const root = await mkdtemp(join(tmpdir(), "quality coverage nested "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copyInstalledToolchainPresets(root);
  const put = async (path: string, value: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), value);
  };
  await put(
    `${moduleRoot}/package.json`,
    JSON.stringify({ name: "@fixture/worker", private: true, type: "module" }),
  );
  await put(main, "export const value = 1;\n");
  return {
    root,
    put,
    census: () => censusReader.read({ consumerRoot: root, roots: ["packages"] }),
  };
}
