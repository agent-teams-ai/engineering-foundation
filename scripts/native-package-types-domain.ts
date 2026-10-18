import { posix } from "node:path";

import { inspectCompressedTarArchive, portableEntryIdentity } from "./pack-artifact-archive.mjs";

export interface NativeTypedEntrypoint {
  readonly subpath: string;
  readonly types: string;
  readonly implementation: string;
}

interface NativeDataWildcard {
  readonly subpath: string;
  readonly target: string;
}

export interface NativePackageDomain {
  readonly name: string;
  readonly version: string;
  readonly files: ReadonlyMap<string, string>;
  readonly codeFiles: readonly string[];
  readonly entrypoints: readonly NativeTypedEntrypoint[];
  readonly dataEntrypoints: ReadonlyMap<string, string>;
  readonly dataWildcards: readonly NativeDataWildcard[];
  readonly imports: ReadonlyMap<string, string>;
}

export function nativePackageFailure(message: string): never {
  throw new Error(`Native package type qualification failed: ${message}.`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    nativePackageFailure(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function json(text: string, label: string): unknown {
  try { return JSON.parse(text) as unknown; }
  catch { return nativePackageFailure(`${label} must be valid JSON`); }
}

function portablePath(value: unknown, label: string, wildcard = false): string {
  if (typeof value !== "string" || !value.startsWith("./") || value.length < 3) {
    nativePackageFailure(`${label} must be a relative package path`);
  }
  const path = value.slice(2);
  const stars = path.split("*").length - 1;
  if (stars !== (wildcard ? 1 : 0)) { nativePackageFailure(`${label} has an unsupported wildcard form`); }
  portableEntryIdentity(`package/${path.replace("*", "wildcard")}`);
  return path;
}

function existingFile(files: ReadonlyMap<string, string>, path: string, label: string): string {
  const value = files.get(path);
  if (value === undefined) { nativePackageFailure(`${label} is missing from the archive: ${path}`); }
  return value;
}

function dataTarget(files: ReadonlyMap<string, string>, target: unknown, label: string): string {
  const path = portablePath(target, label);
  if (!path.endsWith(".json")) { nativePackageFailure(`${label} must identify JSON data`); }
  json(existingFile(files, path, label), label);
  return path;
}

function dataWildcard(files: ReadonlyMap<string, string>, subpath: string, target: string): NativeDataWildcard {
  portablePath(subpath, `Export ${subpath}`, true);
  const path = portablePath(target, `Export ${subpath}`, true);
  const [prefix, suffix] = path.split("*");
  if (prefix === undefined || suffix === undefined || !prefix.includes("/")) {
    nativePackageFailure(`Export ${subpath} must have a bounded data directory`);
  }
  const matches = [...files.keys()].filter(name => name.startsWith(prefix) && name.endsWith(suffix));
  if (matches.length === 0) { nativePackageFailure(`Export ${subpath} has no packed data members`); }
  for (const member of matches) { dataTarget(files, `./${member}`, `Export ${subpath} member`); }
  return { subpath, target: path };
}

function wildcardParts(pattern: string): { prefix: string; suffix: string } {
  const star = pattern.indexOf("*");
  return { prefix: pattern.slice(0, star), suffix: pattern.slice(star + 1) };
}

function overlappingWildcards(left: string, right: string): boolean {
  const a = wildcardParts(left);
  const b = wildcardParts(right);
  return (a.prefix.startsWith(b.prefix) || b.prefix.startsWith(a.prefix)) &&
    (a.suffix.endsWith(b.suffix) || b.suffix.endsWith(a.suffix));
}

function wildcardRuntimeTarget(wildcards: readonly NativeDataWildcard[], subpath: string): string | undefined {
  for (const wildcard of wildcards) {
    const { prefix, suffix } = wildcardParts(wildcard.subpath);
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length > prefix.length + suffix.length) {
      const capture = subpath.slice(prefix.length, subpath.length - suffix.length);
      return wildcard.target.replace("*", capture);
    }
  }
  return undefined;
}

function typedTarget(files: ReadonlyMap<string, string>, value: unknown, label: string, declaration: boolean): string {
  const path = portablePath(value, label);
  if (!path.startsWith("dist/") || !(declaration ? /\.d\.(?:ts|mts)$/u : /\.(?:js|mjs)$/u).test(path)) {
    nativePackageFailure(`${label} has an unsupported ${declaration ? "declaration" : "ESM implementation"} target`);
  }
  existingFile(files, path, label);
  return path;
}

function rejectLegacyEntrypoint(files: ReadonlyMap<string, string>, subpath: string): void {
  const base = subpath === "." ? "index" : subpath.slice(2);
  const candidates = [base, `${base}/index`].flatMap(path => [path, `${path}.js`, `${path}.d.ts`, `${path}.json`]);
  if (candidates.some(path => files.has(path))) {
    nativePackageFailure(`Export ${subpath} has an alternative legacy entrypoint`);
  }
}

function archiveFiles(archiveBytes: Buffer, expectedPackageName: string): ReadonlyMap<string, string> {
  const inspection = inspectCompressedTarArchive(archiveBytes, expectedPackageName);
  const files = new Map<string, string>();
  const identities = new Set<string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const entry of inspection.entries) {
    const identity = portableEntryIdentity(entry.name);
    if (identities.has(identity)) { nativePackageFailure(`duplicate archive member ${entry.name}`); }
    identities.add(identity);
    if (!entry.name.startsWith("package/") || !["0", "5"].includes(entry.type)) {
      nativePackageFailure(`unsupported archive member ${entry.name}`);
    }
    if (entry.type === "5") { continue; }
    const path = entry.name.slice("package/".length);
    if (path !== "package.json" && path.endsWith("/package.json")) {
      nativePackageFailure(`nested package scope ${path}`);
    }
    try { files.set(path, decoder.decode(entry.data)); }
    catch { nativePackageFailure(`archive member is not UTF-8 text: ${path}`); }
  }
  return files;
}

function packageIdentity(manifest: Record<string, unknown>, expectedPackageName: string): { name: string; version: string } {
  const name = manifest["name"];
  const version = manifest["version"];
  if (name !== expectedPackageName || typeof name !== "string" || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(name)) {
    nativePackageFailure("packed package name differs from the projected package identity");
  }
  if (typeof version !== "string" || version.length === 0) { nativePackageFailure("package version is missing"); }
  if (manifest["type"] !== "module") { nativePackageFailure("package must declare type:module"); }
  for (const field of ["main", "module", "types", "typings", "typesVersions", "browser", "jsnext:main"]) {
    if (Object.hasOwn(manifest, field)) { nativePackageFailure(`unsupported legacy resolution field ${field}`); }
  }
  return { name, version };
}

function exportedEntrypoints(manifest: Record<string, unknown>, files: ReadonlyMap<string, string>): {
  entrypoints: readonly NativeTypedEntrypoint[]; dataEntrypoints: ReadonlyMap<string, string>; dataWildcards: readonly NativeDataWildcard[];
} {
  const entrypoints: NativeTypedEntrypoint[] = [];
  const dataEntrypoints = new Map<string, string>();
  const dataWildcards: NativeDataWildcard[] = [];
  for (const [subpath, value] of Object.entries(object(manifest["exports"], "Package exports"))) {
    if (subpath !== ".") { portablePath(subpath, `Export ${subpath}`, subpath.includes("*")); }
    if (typeof value === "string") {
      if (subpath.includes("*") || value.includes("*")) {
        if (dataWildcards.some(wildcard => overlappingWildcards(wildcard.subpath, subpath))) {
          nativePackageFailure(`overlapping data wildcard exports at ${subpath}`);
        }
        dataWildcards.push(dataWildcard(files, subpath, value));
      }
      else { dataEntrypoints.set(subpath, dataTarget(files, value, `Export ${subpath}`)); }
      continue;
    }
    const conditions = object(value, `Export ${subpath}`);
    if (Object.keys(conditions).join("\0") !== "types\0import" || subpath.includes("*")) {
      nativePackageFailure(`Export ${subpath} must have exactly first types and then import conditions`);
    }
    rejectLegacyEntrypoint(files, subpath);
    entrypoints.push({ subpath,
      types: typedTarget(files, conditions["types"], `Export ${subpath} types`, true),
      implementation: typedTarget(files, conditions["import"], `Export ${subpath} import`, false) });
  }
  if (entrypoints.length === 0) { nativePackageFailure("package has no typed ESM entrypoints"); }
  return { entrypoints, dataEntrypoints, dataWildcards };
}

function packageImports(manifest: Record<string, unknown>, files: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const imports = new Map<string, string>();
  if (manifest["imports"] !== undefined) {
    for (const [key, value] of Object.entries(object(manifest["imports"], "Package imports"))) {
      if (!/^#[A-Za-z0-9._/-]+$/u.test(key) || key.startsWith("#/")) { nativePackageFailure(`unsupported package import ${key}`); }
      imports.set(key, typedTarget(files, value, `Package import ${key}`, false));
    }
  }
  return imports;
}

/** A checked input domain, not a general replacement for ATTW's CJS heuristics. */
export function inspectNativePackageDomain(archiveBytes: Buffer, expectedPackageName: string): NativePackageDomain {
  const files = archiveFiles(archiveBytes, expectedPackageName);
  const manifest = object(json(existingFile(files, "package.json", "Package manifest"), "Package manifest"), "Package manifest");
  const identity = packageIdentity(manifest, expectedPackageName);
  const codeFiles = [...files.keys()].filter(path => /\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/u.test(path));
  for (const path of codeFiles) {
    if (!path.startsWith("dist/") || !/\.(?:js|mjs|d\.ts|d\.mts)$/u.test(path)) {
      nativePackageFailure(`unsupported code file ${path}`);
    }
  }
  return { ...identity, files, codeFiles, ...exportedEntrypoints(manifest, files), imports: packageImports(manifest, files) };
}

export function isOwnPackageReference(name: string, reference: string): boolean {
  return reference.startsWith(".") || reference.startsWith("#") || reference.startsWith("/") ||
    /^[A-Za-z]:/u.test(reference) || reference === name || reference.startsWith(`${name}/`);
}

/** JS runtime references must resolve to packed JS/data, never declaration siblings. */
export function ownRuntimeTarget(domain: NativePackageDomain, from: string, reference: string): string {
  let target: string | undefined;
  if (reference.startsWith(".")) { target = posix.normalize(posix.join(posix.dirname(from), reference)); }
  else if (reference.startsWith("#")) { target = domain.imports.get(reference); }
  else {
    const subpath = reference === domain.name ? "." : `.${reference.slice(domain.name.length)}`;
    target = domain.entrypoints.find(entry => entry.subpath === subpath)?.implementation ??
      domain.dataEntrypoints.get(subpath) ?? wildcardRuntimeTarget(domain.dataWildcards, subpath);
  }
  if (target === undefined || target.startsWith("../") || !/\.(?:js|mjs|json)$/u.test(target) || !domain.files.has(target)) {
    nativePackageFailure(`unresolved own runtime import ${reference} in ${from}`);
  }
  return target;
}
