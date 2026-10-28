import { parseStrictJson } from "@agent-teams/repository-mutation/serialization";
import { createRequire } from "node:module";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  CapabilityInputError,
  assertNotCancelled,
  type QualityDependencyDeclaration,
  type QualityFileReader,
} from "../api.js";

function reject(name: string, reason: string): never {
  throw new CapabilityInputError({
    code: "QUALITY_TOOLCHAIN_INVALID",
    message: `${name}: ${reason}`,
    phase: "quality-toolchain",
    retryable: false,
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function declaration(name: string, dependencies: readonly QualityDependencyDeclaration[]): string {
  const matches = dependencies.filter(({ dependencyName }) => dependencyName === name);
  const candidate = matches[0];
  if (
    matches.length !== 1 ||
    candidate === undefined ||
    candidate.section !== "devDependencies" ||
    candidate.targetPackageName !== name ||
    candidate.normalizationProblem !== undefined ||
    !/^\d+\.\d+\.\d+$/u.test(candidate.effectiveVersionSpecifier)
  ) {
    reject(name, "requires one exact consumer root development dependency.");
  }
  return candidate.effectiveVersionSpecifier;
}

async function observeInstalledPackage(
  root: string,
  name: string,
  version: string,
  read: QualityFileReader,
  options: { readonly bin?: string; readonly from?: string } = {},
): Promise<string> {
  let manifestPath: string;
  try {
    manifestPath = await realpath(
      createRequire(options.from ?? join(root, "package.json")).resolve(`${name}/package.json`),
    );
  } catch {
    reject(name, "is not installed in the consumer toolchain.");
  }
  if (!within(join(root, "node_modules"), manifestPath)) {
    reject(name, "resolved outside consumer node_modules.");
  }
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      await read({ root, candidate: manifestPath, maxBytes: 2 * 1024 * 1024 }),
    ),
  );
  if (!record(value) || value["name"] !== name || value["version"] !== version) {
    reject(name, "installed identity does not match the exact declared pin.");
  }
  if (options.bin === undefined) {
    return manifestPath;
  }
  const binaries = value["bin"];
  const target =
    typeof binaries === "string" ? binaries : record(binaries) ? binaries[options.bin] : undefined;
  if (typeof target !== "string" || target.length === 0 || isAbsolute(target)) {
    reject(name, "has no supported executable entrypoint.");
  }
  const packageRoot = dirname(manifestPath);
  const executable = await realpath(join(packageRoot, target));
  if (!within(packageRoot, executable)) {
    reject(name, "executable escapes its installed package.");
  }
  await read({ root, candidate: executable, maxBytes: 16 * 1024 * 1024 });
  return executable;
}

/** Resolution starts at the consumer, and explicitly rejects ancestor/global fallback. */
export async function inspectConsumerToolchain(input: {
  readonly consumerRoot: string;
  readonly dependencies: readonly QualityDependencyDeclaration[];
  readonly read: QualityFileReader;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly oxlintEntrypoint: string;
  readonly compilerEntrypoint: string;
  readonly typedEntrypoint: string;
}> {
  assertNotCancelled(input.signal);
  const root = await realpath(input.consumerRoot);
  const toolchainVersion = declaration("stack-toolchain", input.dependencies);
  const toolchainManifest = await observeInstalledPackage(
    root,
    "stack-toolchain",
    toolchainVersion,
    input.read,
  );
  const packageValue: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      await input.read({ root, candidate: toolchainManifest, maxBytes: 2 * 1024 * 1024 }),
    ),
  );
  if (!record(packageValue) || !record(packageValue["dependencies"])) {
    reject("stack-toolchain", "has no declared dependency graph.");
  }
  const graph = packageValue["dependencies"];
  const pinsPath = await realpath(join(dirname(toolchainManifest), "toolchain-manifest.json"));
  if (!within(dirname(toolchainManifest), pinsPath)) {
    reject("stack-toolchain", "version manifest escapes its package.");
  }
  const pins: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      await input.read({ root, candidate: pinsPath, maxBytes: 2 * 1024 * 1024 }),
    ),
  );
  if (!record(pins) || pins["schemaVersion"] !== 1) {
    reject("stack-toolchain", "unsupported version manifest.");
  }
  const versions = qualifiedVersions(pins, graph);
  const oxlintEntrypoint = await observeInstalledPackage(
    root,
    "oxlint",
    versions["oxlint"]!,
    input.read,
    { bin: "oxlint", from: toolchainManifest },
  );
  const compilerEntrypoint = await observeInstalledPackage(
    root,
    "typescript",
    versions["typescript"]!,
    input.read,
    { bin: "tsc", from: toolchainManifest },
  );
  const typedWrapper = await observeInstalledPackage(
    root,
    "oxlint-tsgolint",
    versions["oxlint-tsgolint"]!,
    input.read,
    { bin: "tsgolint", from: toolchainManifest },
  );
  const nativeName = `@oxlint-tsgolint/${process.platform}-${process.arch}`;
  const nativeManifest = await observeInstalledPackage(
    root,
    nativeName,
    versions["oxlint-tsgolint"]!,
    input.read,
    { from: typedWrapper },
  );
  const nativeRoot = dirname(nativeManifest);
  const typedEntrypoint = await realpath(
    join(nativeRoot, process.platform === "win32" ? "tsgolint.exe" : "tsgolint"),
  );
  if (!within(nativeRoot, typedEntrypoint)) {
    reject(nativeName, "executable escapes its installed package.");
  }
  await input.read({ root, candidate: typedEntrypoint, maxBytes: 128 * 1024 * 1024 });
  for (const dependency of input.dependencies.filter(({ dependencyName }) =>
    dependencyName.startsWith("@types/"),
  )) {
    await observeInstalledPackage(
      root,
      dependency.dependencyName,
      declaration(dependency.dependencyName, input.dependencies),
      input.read,
    );
  }
  assertNotCancelled(input.signal);
  return { oxlintEntrypoint, compilerEntrypoint, typedEntrypoint };
}

function qualifiedVersions(
  pins: Record<string, unknown>,
  graph: Record<string, unknown>,
): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const name of ["oxlint", "oxlint-tsgolint", "typescript"]) {
    const version = pins[name];
    if (
      typeof version !== "string" ||
      !/^\d+\.\d+\.\d+$/u.test(version) ||
      graph[name] !== version
    ) {
      reject(name, "toolchain version manifest disagrees with its exact dependency graph.");
    }
    versions[name] = version;
  }
  return versions;
}

/** Narrow independent Stack identity admission; it does not require compiler/lint lanes. */
export async function inspectConsumerStackPackage(
  root: string,
  read: QualityFileReader,
): Promise<string> {
  const value: unknown = parseStrictJson(
    new TextDecoder("utf-8", { fatal: true }).decode(
      await read({ root, candidate: join(root, "package.json"), maxBytes: 1024 * 1024 }),
    ),
  );
  if (!record(value)) {
    reject("stack-toolchain", "invalid root manifest.");
  }
  let pin: unknown;
  let declarations = 0;
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const entries = value[section];
    if (!record(entries)) {
      continue;
    }
    for (const [name, version] of Object.entries(entries)) {
      if (
        name === "stack-toolchain" ||
        (typeof version === "string" && /^npm:stack-toolchain(?:@|$)/u.test(version))
      ) {
        declarations += 1;
        if (name !== "stack-toolchain" || section !== "devDependencies") {
          reject("stack-toolchain", "requires a single canonical development pin.");
        }
        pin = version;
      }
    }
  }
  if (
    declarations !== 1 ||
    typeof pin !== "string" ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(pin)
  ) {
    reject("stack-toolchain", "requires an exact stable root development pin.");
  }
  for (const key of ["bundledDependencies", "bundleDependencies"]) {
    const bundled = value[key];
    if (Array.isArray(bundled) && bundled.some((name: unknown) => name === "stack-toolchain")) {
      reject("stack-toolchain", "cannot be bundled.");
    }
  }
  return observeInstalledPackage(root, "stack-toolchain", pin, read);
}
