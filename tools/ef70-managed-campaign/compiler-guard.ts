import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

// Diagnostic process/module observer only. It does not replace the controller,
// runtime selection, authority, package manager, installed verifier, or compiler.
const logPath = process.env["EF70_COMPILER_GUARD_LOG"];
if (logPath === undefined || !logPath.startsWith("/")) {
  throw new Error("EF70_COMPILER_GUARD_LOG must select an external absolute log.");
}
function record(event: Readonly<Record<string, unknown>>): void {
  appendFileSync(
    logPath!,
    JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...event }) + "\n",
  );
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function admittedVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) {
    return false;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major > 7 || (major === 7 && (minor > 0 || (minor === 0 && patch >= 2)));
}
const inspected = new Set<string>();
function inspectCompiler(url: string): void {
  if (!url.startsWith("file:") || !url.includes("typescript")) {
    return;
  }
  let directory = dirname(fileURLToPath(url));
  const root = parse(directory).root;
  while (directory !== root) {
    const manifestPath = join(directory, "package.json");
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
      directory = dirname(directory);
      continue;
    }
    if (!object(manifest)) {
      throw new Error(`Invalid package metadata: ${manifestPath}`);
    }
    const name = manifest["name"];
    if (name === "typescript" || name === "@typescript/native-preview") {
      const version = manifest["version"];
      const accepted = typeof version === "string" && admittedVersion(version);
      if (!inspected.has(manifestPath) || !accepted) {
        record({ kind: "compiler-load", name, version, accepted, manifestPath, url });
        inspected.add(manifestPath);
      }
      if (!accepted) {
        throw new Error(`REFUSED_COMPILER_BELOW_7_0_2: ${String(name)}@${String(version)}`);
      }
      return;
    }
    // A nested package with another name is not the compiler package itself.
    return;
  }
}
record({
  kind: "process",
  ppid: process.ppid,
  execPath: process.execPath,
  node: process.versions.node,
  entry: process.argv[1] ?? null,
});
registerHooks({
  load(url, context, nextLoad) {
    inspectCompiler(url);
    return nextLoad(url, context);
  },
});
