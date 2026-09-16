import { createRequire } from "node:module";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { CapabilityInputError, assertNotCancelled, type QualityDependencyDeclaration, type QualityFileReader } from "../api.js";

// This is the qualified adapter version set, not a dependency installer or a range resolver.
const SUPPORTED = { oxlint: "1.83.0", "oxlint-tsgolint": "7.0.2001", typescript: "7.0.2" } as const;

function reject(name: string, reason: string): never {
  throw new CapabilityInputError({ code: "QUALITY_TOOLCHAIN_INVALID", message: `${name}: ${reason}`, phase: "quality-toolchain", retryable: false });
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
  if (matches.length !== 1 || candidate === undefined || candidate.section !== "devDependencies" ||
    candidate.targetPackageName !== name || candidate.normalizationProblem !== undefined ||
    !/^\d+\.\d+\.\d+$/u.test(candidate.effectiveVersionSpecifier)) {
    reject(name, "requires one exact consumer root development dependency.");
  }
  return candidate.effectiveVersionSpecifier;
}

async function observeInstalledPackage(
  root: string, name: string, version: string, read: QualityFileReader,
  options: { readonly bin?: string; readonly from?: string } = {}
): Promise<string> {
  let manifestPath: string;
  try {
    manifestPath = await realpath(createRequire(options.from ?? join(root, "package.json")).resolve(`${name}/package.json`));
  } catch { reject(name, "is not installed in the consumer toolchain."); }
  if (!within(join(root, "node_modules"), manifestPath)) { reject(name, "resolved outside consumer node_modules."); }
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await read({ root, candidate: manifestPath, maxBytes: 2 * 1024 * 1024 })));
  if (!record(value) || value["name"] !== name || value["version"] !== version) {
    reject(name, "installed identity does not match the exact declared pin.");
  }
  if (options.bin === undefined) { return manifestPath; }
  const binaries = value["bin"];
  const target = typeof binaries === "string" ? binaries : record(binaries) ? binaries[options.bin] : undefined;
  if (typeof target !== "string" || target.length === 0 || isAbsolute(target)) { reject(name, "has no supported executable entrypoint."); }
  const packageRoot = dirname(manifestPath);
  const executable = await realpath(join(packageRoot, target));
  if (!within(packageRoot, executable)) { reject(name, "executable escapes its installed package."); }
  await read({ root, candidate: executable, maxBytes: 16 * 1024 * 1024 });
  return executable;
}

/** Resolution starts at the consumer, and explicitly rejects ancestor/global fallback. */
export async function inspectConsumerToolchain(input: {
  readonly consumerRoot: string;
  readonly dependencies: readonly QualityDependencyDeclaration[];
  readonly read: QualityFileReader;
  readonly signal?: AbortSignal;
}): Promise<{ readonly oxlintEntrypoint: string; readonly compilerEntrypoint: string; readonly typedEntrypoint: string }> {
  assertNotCancelled(input.signal);
  const root = await realpath(input.consumerRoot);
  for (const [name, version] of Object.entries(SUPPORTED)) {
    if (declaration(name, input.dependencies) !== version) { reject(name, `unsupported version; this adapter qualifies ${version}.`); }
  }
  const oxlintEntrypoint = await observeInstalledPackage(root, "oxlint", SUPPORTED.oxlint, input.read, { bin: "oxlint" });
  const compilerEntrypoint = await observeInstalledPackage(root, "typescript", SUPPORTED.typescript, input.read, { bin: "tsc" });
  const typedWrapper = await observeInstalledPackage(root, "oxlint-tsgolint", SUPPORTED["oxlint-tsgolint"], input.read, { bin: "tsgolint" });
  const nativeName = `@oxlint-tsgolint/${process.platform}-${process.arch}`;
  const nativeManifest = await observeInstalledPackage(root, nativeName, SUPPORTED["oxlint-tsgolint"], input.read, { from: typedWrapper });
  const nativeRoot = dirname(nativeManifest);
  const typedEntrypoint = await realpath(join(nativeRoot, process.platform === "win32" ? "tsgolint.exe" : "tsgolint"));
  if (!within(nativeRoot, typedEntrypoint)) { reject(nativeName, "executable escapes its installed package."); }
  await input.read({ root, candidate: typedEntrypoint, maxBytes: 128 * 1024 * 1024 });
  for (const dependency of input.dependencies.filter(({ dependencyName }) => dependencyName.startsWith("@types/"))) {
    await observeInstalledPackage(root, dependency.dependencyName, declaration(dependency.dependencyName, input.dependencies), input.read);
  }
  assertNotCancelled(input.signal);
  return { oxlintEntrypoint, compilerEntrypoint, typedEntrypoint };
}
