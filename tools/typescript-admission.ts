import { constants } from "node:fs";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { parsePnpmWorkspaceAuthority } from "./runtime-policy.mts";

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Repository TypeScript admission requires object metadata.");
  }
  return value as Readonly<Record<string, unknown>>;
}

async function manifest(path: string): Promise<Readonly<Record<string, unknown>>> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  return record(value);
}

function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

async function admittedFile(path: string, root: string): Promise<string> {
  const physical = await realpath(path);
  if (!within(root, physical) || !(await stat(physical)).isFile()) {
    throw new Error("Repository TypeScript file escapes its installed package or is not regular.");
  }
  return physical;
}

async function installedWrapperLayout(owner: string): Promise<void> {
  const library = join(owner, "lib").split(sep).join("/");
  if (
    library.endsWith("/_packages/typescript/lib") ||
    library.endsWith("/built/npm/typescript/lib")
  ) {
    throw new Error(
      "Repository TypeScript source-build layouts do not select the admitted native package.",
    );
  }
  for (const directory of ["bin", "lib"]) {
    const nested = await lstat(join(owner, directory, "package.json")).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    });
    if (nested !== undefined) {
      throw new Error("Repository TypeScript wrapper must not introduce a nested package scope.");
    }
  }
}

async function wrapperFile(owner: string, path: string): Promise<string> {
  const expected = join(owner, path);
  const physical = await admittedFile(expected, owner);
  if (physical !== expected) {
    throw new Error(
      "Repository TypeScript wrapper file aliases change its package scope or resolution context.",
    );
  }
  return physical;
}

async function nativeOwnerManifest(
  resolver: string,
  nativeName: string,
  installation: string,
): Promise<string> {
  // Use the runtime's own issuer search paths. Keep the lookup inside this
  // installation and read the first package owner before exports redirect it.
  for (const modules of createRequire(resolver).resolve.paths(nativeName) ?? []) {
    if (!within(installation, modules)) {
      continue;
    }
    const owner = join(modules, nativeName);
    const directory = await stat(owner).catch((error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      ) {
        return;
      }
      throw error;
    });
    if (directory !== undefined && directory.isDirectory()) {
      return admittedFile(join(owner, "package.json"), installation);
    }
  }
  throw new Error("Repository TypeScript native package metadata is unavailable.");
}

async function declaredVersion(root: string): Promise<string> {
  const repository = await manifest(join(root, "package.json"));
  const declaration = record(repository["devDependencies"])["typescript"];
  const version =
    declaration === "catalog:"
      ? parsePnpmWorkspaceAuthority(await readFile(join(root, "pnpm-workspace.yaml"), "utf8"))
          .catalog["typescript"]
      : declaration;
  const match =
    typeof version === "string"
      ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version)
      : null;
  const [major, minor, patch] = (match?.slice(1) ?? []).map(Number);
  if (
    typeof version !== "string" ||
    major === undefined ||
    minor === undefined ||
    patch === undefined ||
    ![major, minor, patch].every(Number.isSafeInteger) ||
    major < 7 ||
    (major === 7 && minor === 0 && patch < 2)
  ) {
    throw new Error("Repository TypeScript requires an exact declared stable pin >=7.0.2.");
  }
  return version;
}

/** Metadata-only version/selection admission, not executable-byte attestation. */
export async function admitRepositoryTypeScript(root: string): Promise<{
  readonly entry: string;
  readonly version: string;
}> {
  const version = await declaredVersion(root);
  const installation = await realpath(join(root, "node_modules"));
  const owner = await realpath(join(installation, "typescript"));
  if (!within(installation, owner)) {
    throw new Error("Repository TypeScript package escapes the repository installation.");
  }
  await installedWrapperLayout(owner);
  const metadata = await manifest(await admittedFile(join(owner, "package.json"), owner));
  const bin = record(metadata["bin"]);
  if (
    metadata["name"] !== "typescript" ||
    metadata["version"] !== version ||
    Object.keys(bin).length !== 1 ||
    bin["tsc"] !== "./bin/tsc" ||
    record(metadata["imports"])["#getExePath"] !== "./lib/getExePath.js"
  ) {
    throw new Error(
      "Repository TypeScript wrapper identity, version or entrypoint differs from its pin.",
    );
  }
  const entry = await wrapperFile(owner, "bin/tsc");
  await wrapperFile(owner, "lib/tsc.js");
  const resolver = await wrapperFile(owner, "lib/getExePath.js");
  const nativeName = `@typescript/typescript-${process.platform}-${process.arch}`;
  if (record(metadata["optionalDependencies"])[nativeName] !== version) {
    throw new Error("Repository TypeScript native dependency declaration differs from its pin.");
  }
  // No SDK or candidate resolver code runs during admission. Canonical exports
  // prevent import/require conditions from selecting different native metadata.
  const nativeManifest = await nativeOwnerManifest(resolver, nativeName, installation);
  const native = await manifest(nativeManifest);
  if (
    native["name"] !== nativeName ||
    native["version"] !== version ||
    record(native["exports"])["./package.json"] !== "./package.json"
  ) {
    throw new Error(
      "Repository TypeScript native identity, version or metadata export differs from its pin.",
    );
  }
  if (
    (await realpath(createRequire(resolver).resolve(`${nativeName}/package.json`))) !==
    nativeManifest
  ) {
    throw new Error("Repository TypeScript native metadata resolution differs from its owner.");
  }
  const executable = await admittedFile(
    join(dirname(nativeManifest), "lib", process.platform === "win32" ? "tsc.exe" : "tsc"),
    dirname(nativeManifest),
  );
  await access(executable, process.platform === "win32" ? constants.F_OK : constants.X_OK);
  return { entry, version };
}
