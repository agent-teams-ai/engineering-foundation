import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire, isBuiltin, registerHooks } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSync, Visitor } from "oxc-parser";

export type PublishedFoundationVersion = "0.11.0" | "0.12.0" | "0.14.0";
type PublishedSubpath = "scaffolding" | "local-mode";

const publishedArtifacts = {
  "0.11.0": { integrity: "sha512-L/mWa40ziy3veWzEwp3uH4PTSNInmQb02Na0FeyTk8VoXHNApJon2tegQLOkpbwxEAZCP9aSywCm+1hYbxcUrg==",
    dormantImportHash: "1a2fe7eb84aacfa6ed5ce5eda2cd7d5f4569fc381bcbda3088430e27128225b0" },
  "0.12.0": { integrity: "sha512-LWey96bQBwA/91eD1T9pZRKrNUPlAt/8NEOQ5gnWfW6Mzs+kdvyOUNQFXUUR2TTrfzfgiYPgjg5aBTUkCrZ0WQ==",
    dormantImportHash: "55caeb52f8d24fda738172b903aaa0e0c19d5323c55f6a4e73e3d9b772bbef1f" },
  "0.14.0": { integrity: "sha512-4wLDBtGKwLvvd9LuD6g6nuI/BE/qD0IlKATegMqo0ItT1eeT8Lhd0x6lnV6QnHkKWx+sX+H6vsKs/9fNSDhm9Q==",
    dormantImportHash: "55caeb52f8d24fda738172b903aaa0e0c19d5323c55f6a4e73e3d9b772bbef1f" },
} as const;
const packageName = "@agent-teams/engineering-foundation";
const maximumFiles = 512;
const maximumFileBytes = 2 * 1024 * 1024;
const maximumTotalBytes = 16 * 1024 * 1024;
let floorActive = false;

function fail(message: string): never { throw new Error(`Published Foundation operation preflight failed: ${message}.`); }

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) { fail(`${label} must be an object`); }
  return value as Record<string, unknown>;
}

export function publishedFoundationIntegrity(version: PublishedFoundationVersion): string {
  if (!Object.hasOwn(publishedArtifacts, version)) { fail(`unsupported historical version ${version}`); }
  return publishedArtifacts[version].integrity;
}

function compilerName(name: string): boolean {
  return /^(?:typescript(?:\/|$)|@typescript\/|@microsoft\/api-extractor(?:\/|$))/u.test(name);
}

function compilerBoundary(reference: string): boolean {
  const path = reference.startsWith("file:") ? fileURLToPath(reference) : reference;
  const normalized = path.replaceAll("\\", "/");
  if (compilerName(normalized) || /\/node_modules\/(?:typescript(?:\/|$)|@typescript\/|@microsoft\/api-extractor(?:\/|$))/u.test(normalized)) { return true; }
  if (!isAbsolute(path)) { return false; }
  const actual = realpathSync(path);
  if (actual !== path && compilerBoundary(actual)) { return true; }
  let directory = dirname(actual);
  for (let depth = 0; depth < 64; depth++) {
    let manifest: unknown;
    try { manifest = JSON.parse(safeFile(resolve(directory, "package.json")).toString("utf8")) as unknown; }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") { throw error; }
    }
    if (manifest !== undefined) {
      const name = record(manifest, "module package manifest")["name"];
      if (typeof name === "string") { return compilerName(name); }
    }
    const parent = dirname(directory);
    if (parent === directory) { return false; }
    directory = parent;
  }
  return fail("module package ancestry exceeds its bound");
}

/** Denies compiler loading before evaluation; never substitutes or transforms modules. */
export async function withPublishedCompilerFloor<T>(action: () => Promise<T>): Promise<T> {
  if (floorActive) { fail("a historical operation already owns the compiler floor guard"); }
  floorActive = true;
  let violation: string | undefined;
  const assertAllowed = (reference: string): void => {
    try {
      if (isBuiltin(reference)) { return; }
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(reference) && !reference.startsWith("file:") && !isAbsolute(reference)) {
        fail(`unqualified module URL ${reference}`);
      }
      if (compilerBoundary(reference)) { fail(`compiler/extractor loading is forbidden: ${reference}`); }
    } catch (error) {
      violation = reference;
      throw error;
    }
  };
  let hooks: ReturnType<typeof registerHooks> | undefined;
  try {
    hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      assertAllowed(specifier);
      const result = nextResolve(specifier, context);
      assertAllowed(result.url);
      return result;
    },
    load(url, context, nextLoad) { assertAllowed(url); return nextLoad(url, context); },
    });
    return await action();
  }
  finally {
    hooks?.deregister();
    floorActive = false;
    // A historical operation catching the denial cannot turn it into evidence.
    if (violation !== undefined) { fail(`compiler floor guard refused ${violation}`); }
  }
}

function safeFile(path: string): Buffer {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumFileBytes) { fail(`not a bounded regular source file: ${path}`); }
  return readFileSync(path);
}

function installedIdentity(packageRoot: string, version: PublishedFoundationVersion, subpath: PublishedSubpath): { root: string; entry: string } {
  const root = realpathSync(packageRoot);
  const manifest = record(JSON.parse(safeFile(resolve(root, "package.json")).toString("utf8")) as unknown, "installed manifest");
  if (manifest["name"] !== packageName || manifest["version"] !== version || manifest["type"] !== "module") { fail("installed package identity differs from the selected original artifact"); }
  const exported = record(record(manifest["exports"], "installed exports")[`./${subpath}`], "public export");
  const target = `./dist/${subpath}/index.js`;
  if (exported["import"] !== target) { fail(`public ./${subpath} export changed`); }
  const installRoot = resolve(root, "../../..");
  if (relative(installRoot, root).split(sep).join("/") !== `node_modules/${packageName}`) { fail("historical package must be a real npm installation"); }
  const lock = record(JSON.parse(safeFile(resolve(installRoot, "package-lock.json")).toString("utf8")) as unknown, "installed lock");
  const locked = record(record(lock["packages"], "locked packages")[`node_modules/${packageName}`], "locked Foundation");
  if (locked["version"] !== version || locked["integrity"] !== publishedFoundationIntegrity(version) ||
    typeof locked["resolved"] !== "string" || !locked["resolved"].startsWith("https://registry.npmjs.org/")) {
    fail("installed registry provenance differs from the exact pinned artifact");
  }
  return { root, entry: resolve(root, target) };
}

function sourceReferences(path: string, text: string, allowDormantImport: boolean): string[] {
  const parsed = parseSync(path, text, { lang: "js", sourceType: "unambiguous" });
  if (parsed.errors.length > 0) { fail(`cannot parse JavaScript import closure: ${path}`); }
  const references = parsed.module.staticImports.map(entry => entry.moduleRequest.value);
  for (const entry of parsed.module.staticExports.flatMap(statement => statement.entries)) {
    if (entry.moduleRequest !== null) { references.push(entry.moduleRequest.value); }
  }
  new Visitor({
    ImportExpression: node => {
      if (node.source.type === "Literal" && typeof node.source.value === "string") { references.push(node.source.value); }
      else if (!allowDormantImport) { fail(`unqualified computed import in ${path}`); }
    },
    CallExpression: node => {
      if (node.callee.type !== "Identifier" || node.callee.name !== "require") { return; }
      const argument = node.arguments[0];
      if (argument?.type !== "Literal" || typeof argument.value !== "string") { fail(`unqualified computed require in ${path}`); }
      references.push(argument.value);
    },
  }).visit(parsed.program);
  return references;
}

export interface PublishedFoundationImportEvidence {
  readonly entry: string;
  readonly sourceFiles: number;
  readonly digest: string;
}

/** Reads the installed closure as data before importing any historical code. */
export function inspectPublishedFoundationImports(packageRoot: string, version: PublishedFoundationVersion, subpath: PublishedSubpath): PublishedFoundationImportEvidence {
  const identity = installedIdentity(packageRoot, version, subpath);
  const installRoot = resolve(identity.root, "../../..");
  const pending = [identity.entry];
  const seen = new Set<string>();
  const identities: string[] = [];
  let bytes = 0;
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (candidate === undefined) { fail("import closure lost its next source"); }
    const path = realpathSync(candidate);
    if (compilerBoundary(path)) { fail(`compiler/extractor import is forbidden: ${path}`); }
    const within = relative(installRoot, path);
    if (within.startsWith(`..${sep}`) || isAbsolute(within)) { fail("import closure escaped its historical installation"); }
    if (seen.has(path)) { continue; }
    seen.add(path);
    const content = safeFile(path);
    bytes += content.length;
    if (seen.size > maximumFiles || bytes > maximumTotalBytes) { fail("historical import closure exceeds its bound"); }
    const hash = createHash("sha256").update(content).digest("hex");
    identities.push(`${within.split(sep).join("/")}:${hash}`);
    if (path.endsWith(".json")) { JSON.parse(content.toString("utf8")); continue; }
    if (!/\.[cm]?js$/u.test(path)) { fail(`unsupported historical module ${path}`); }
    const dormant = path === resolve(identity.root, "dist/package-self-check.js") && hash === publishedArtifacts[version].dormantImportHash;
    for (const reference of sourceReferences(path, new TextDecoder("utf-8", { fatal: true }).decode(content), dormant)) {
      if (isBuiltin(reference)) { continue; }
      if (compilerBoundary(reference)) { fail(`compiler/extractor import is forbidden: ${reference}`); }
      pending.push(createRequire(path).resolve(reference));
    }
  }
  return { entry: identity.entry, sourceFiles: seen.size, digest: createHash("sha256").update(identities.toSorted().join("\n")).digest("hex") };
}
