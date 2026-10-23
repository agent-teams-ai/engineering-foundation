import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { version } from "typescript";

// Fixed private SDK identities; callers cannot select a module or a resolution root.
const require = createRequire(import.meta.url);
const compilerManifestPath = require.resolve("typescript/package.json");
const nativeManifestPath = createRequire(compilerManifestPath).resolve(
  `@typescript/typescript-${process.platform}-${process.arch}/package.json`,
);
const nativeManifest = JSON.parse(readFileSync(nativeManifestPath, "utf8")) as {
  readonly name?: unknown;
  readonly version?: unknown;
};
const modelPath = require.resolve("@microsoft/api-extractor-model");
const modelManifestPath = join(dirname(dirname(modelPath)), "package.json");
const modelManifest = JSON.parse(readFileSync(modelManifestPath, "utf8")) as {
  readonly version?: unknown;
};
export const NATIVE_EXTRACTOR_VERSION = "typescript-native/7.0.2";
export const nativeLibraryDirectory = join(dirname(nativeManifestPath), "lib");
export const nativeCompilerPath = join(
  nativeLibraryDirectory,
  process.platform === "win32" ? "tsc.exe" : "tsc",
);
export const compilerLibraryRoot = realpathSync(nativeLibraryDirectory);
if (
  version !== "7.0.2" ||
  nativeManifest.version !== version ||
  nativeManifest.name !== `@typescript/typescript-${process.platform}-${process.arch}`
) {
  throw new Error("Public API extraction requires the exact TypeScript 7.0.2 native toolchain.");
}

export function assertPinnedAuditSdk(): void {
  if (version !== "7.0.2" || modelManifest.version !== "7.33.10") {
    throw new Error(
      "Unsupported audit toolchain: require native TypeScript 7.0.2 and API Extractor Model 7.33.10.",
    );
  }
}

export function auditToolchainIdentity(): string {
  assertPinnedAuditSdk();
  const modules = [
    modelPath,
    modelManifestPath,
    compilerManifestPath,
    nativeManifestPath,
    require.resolve("typescript/unstable/async"),
    require.resolve("typescript/unstable/ast"),
    require.resolve("@microsoft/tsdoc"),
    nativeCompilerPath,
    fileURLToPath(new URL("./native-public-api-engine.js", import.meta.url)),
    fileURLToPath(new URL("./native-public-api-model.js", import.meta.url)),
    fileURLToPath(new URL("./native-public-api-descriptors.js", import.meta.url)),
    fileURLToPath(new URL("./native-audit-configuration.js", import.meta.url)),
    fileURLToPath(new URL("./native-audit-context.js", import.meta.url)),
    fileURLToPath(new URL("./native-audit-evidence.js", import.meta.url)),
    fileURLToPath(new URL("./native-audit-model.js", import.meta.url)),
    fileURLToPath(new URL("./native-audit-session.js", import.meta.url)),
    fileURLToPath(new URL("./native-type-parenthesis-equivalence.js", import.meta.url)),
    fileURLToPath(new URL("./native-public-api-reference.js", import.meta.url)),
    fileURLToPath(new URL("./native-public-api-excerpt.js", import.meta.url)),
    fileURLToPath(new URL("./native-public-api-item.js", import.meta.url)),
  ];
  return JSON.stringify({
    extractor: NATIVE_EXTRACTOR_VERSION,
    model: modelManifest.version,
    compiler: version,
    modules: modules.map((path) => ({
      digest: `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
    })),
  });
}
