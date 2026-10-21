import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import { isRegularFile, resolveQualificationExecutables } from "../tools/executable-policy.mts";
import { readRepositoryRuntimePolicy, repositoryRoot } from "../tools/runtime-policy.mts";

/** Bind packaging to this repository's installed manager, without a PATH shim. */
export async function resolvePackagingPnpm(): Promise<{
  readonly node: string;
  readonly entrypoint: string;
}> {
  const policy = await readRepositoryRuntimePolicy();
  const packageRoot = await realpath(resolve(repositoryRoot, "node_modules/pnpm"));
  const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
    readonly name?: unknown;
    readonly version?: unknown;
    readonly bin?: { readonly pnpm?: unknown };
  } | null;
  const declared = manifest?.bin?.pnpm;
  if (manifest?.name !== "pnpm" || manifest.version !== policy.toolchain.pnpm.version ||
      typeof declared !== "string" || isAbsolute(declared) || !/\.(?:c|m)?js$/u.test(declared)) {
    throw new Error("Packaging requires the repository's pinned pnpm package and declared JavaScript bin.");
  }
  const entrypoint = await realpath(resolve(packageRoot, declared));
  if (!entrypoint.startsWith(packageRoot + sep) || !await isRegularFile(entrypoint)) {
    throw new Error("The packaging pnpm bin must remain inside its installed package.");
  }
  const { node } = await resolveQualificationExecutables("node");
  return { node, entrypoint };
}
