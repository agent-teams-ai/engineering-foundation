import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { getNodeValue, parseTree, type Node, type ParseError } from "jsonc-parser";
import {
  EffectCheckFailure,
  effectObject,
  requireEffect,
  type EffectToolVersions,
} from "../application/effect-policy.js";

export type EffectLiveCheck = () => void;
export interface EffectNativeManifest {
  readonly package: "@effect/tsgo-linux-x64";
  readonly version: "0.73.4";
  readonly typescript: "7.0.2";
  readonly reportedVersion: string;
  readonly binary: "lib/tsc";
  readonly binarySha256: string;
  readonly libraries: Readonly<Record<string, string>>;
}
export interface EffectNativeTool {
  readonly executable: string;
  readonly installation: string;
  readonly libraries: ReadonlySet<string>;
  readonly reportedVersion: string;
  readonly versions: EffectToolVersions;
}
export const effectHash = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
export function effectInside(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export async function readEffectFile(
  filename: string | URL,
  maximum: number,
  live: EffectLiveCheck,
): Promise<Buffer> {
  live();
  const handle = await fs.open(
    filename,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW),
  );
  try {
    const before = await handle.stat();
    requireEffect(before.isFile() && before.size <= maximum, "EFFECT_FILE_BOUND");
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      live();
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    requireEffect(
      length === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs,
      "EFFECT_FILE_CHANGED",
    );
    live();
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}
export function parseEffectJson(bytes: Uint8Array): unknown {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new EffectCheckFailure("invalid-input", "EFFECT_CONFIG_UTF8");
  }
  const errors: ParseError[] = [];
  const tree = parseTree(source, errors, { allowTrailingComma: true });
  requireEffect(tree !== undefined && errors.length === 0, "EFFECT_CONFIG_JSON");
  const inspect = (node: Node, depth: number): void => {
    requireEffect(depth <= 64, "EFFECT_CONFIG_DEPTH");
    const keys = new Set<unknown>();
    for (const child of node.children ?? []) {
      if (node.type === "object") {
        const key: unknown = child.children?.[0]?.value;
        requireEffect(typeof key === "string" && !keys.has(key), "EFFECT_CONFIG_DUPLICATE_KEY");
        keys.add(key);
      }
      inspect(child, depth + 1);
    }
  };
  inspect(tree, 0);
  return getNodeValue(tree) as unknown;
}

async function effectManifest(live: EffectLiveCheck): Promise<EffectNativeManifest> {
  const value = effectObject(
    parseEffectJson(
      await readEffectFile(
        new URL("../../../../effect-toolchain-manifest.json", import.meta.url),
        64 * 1024,
        live,
      ),
    ),
  );
  const libraries = effectObject(value["libraries"]);
  requireEffect(
    value["schemaVersion"] === 1 &&
      value["package"] === "@effect/tsgo-linux-x64" &&
      value["version"] === "0.73.4" &&
      value["typescript"] === "7.0.2" &&
      value["binary"] === "lib/tsc" &&
      value["reportedVersion"] === "Version 7.0.2+effect-tsgo.0.73.4" &&
      typeof value["binarySha256"] === "string" &&
      /^[a-f0-9]{64}$/u.test(value["binarySha256"]),
    "EFFECT_NATIVE_MANIFEST",
  );
  requireEffect(
    Object.keys(libraries).length === 108 &&
      Object.entries(libraries).every(
        ([name, digest]) =>
          /^lib(?:\.[a-z0-9]+)*\.d\.ts$/u.test(name) &&
          typeof digest === "string" &&
          /^[a-f0-9]{64}$/u.test(digest),
      ),
    "EFFECT_NATIVE_LIBRARIES",
  );
  return value as unknown as EffectNativeManifest;
}

export async function admitEffectCompiler(
  root: string,
  live: EffectLiveCheck,
  suppliedManifest?: EffectNativeManifest,
): Promise<EffectNativeTool> {
  let installation: string;
  let manifestPath: string;
  try {
    installation = await fs.realpath(path.join(root, "node_modules"));
    manifestPath = await fs.realpath(
      createRequire(path.join(root, "package.json")).resolve("@effect/tsgo-linux-x64/package.json"),
    );
  } catch {
    throw new EffectCheckFailure("tool-unavailable", "EFFECT_NATIVE_MISSING");
  }
  try {
    const expected = suppliedManifest ?? (await effectManifest(live));
    requireEffect(effectInside(installation, manifestPath), "EFFECT_NATIVE_OUTSIDE_INSTALLATION");
    const installed = effectObject(
      parseEffectJson(await readEffectFile(manifestPath, 64 * 1024, live)),
    );
    requireEffect(
      installed["name"] === expected.package && installed["version"] === expected.version,
      "EFFECT_NATIVE_VERSION",
    );
    const directory = path.dirname(manifestPath);
    const executable = await fs.realpath(path.join(directory, expected.binary));
    requireEffect(effectInside(directory, executable), "EFFECT_NATIVE_OUTSIDE_PACKAGE");
    requireEffect(
      effectHash(await readEffectFile(executable, 32 * 1024 * 1024, live)) ===
        expected.binarySha256,
      "EFFECT_NATIVE_HASH",
    );
    const libraries = new Set<string>();
    for (const [name, digest] of Object.entries(expected.libraries)) {
      const library = await fs.realpath(path.join(directory, "lib", name));
      requireEffect(
        effectInside(directory, library) &&
          effectHash(await readEffectFile(library, 8 * 1024 * 1024, live)) === digest,
        "EFFECT_NATIVE_LIBRARY_HASH",
      );
      libraries.add(library);
    }
    return {
      executable,
      installation,
      libraries,
      reportedVersion: expected.reportedVersion,
      versions: {
        package: expected.package,
        version: expected.version,
        typescript: expected.typescript,
        binarySha256: expected.binarySha256,
        libraryCount: 108,
      },
    };
  } catch (error) {
    if (
      error instanceof EffectCheckFailure &&
      ["cancelled", "execution-failed"].includes(error.outcome)
    )
      throw error;
    throw new EffectCheckFailure(
      "tool-incompatible",
      error instanceof Error ? error.message : "EFFECT_NATIVE_INVALID",
    );
  }
}

export async function effectLocalPath(root: string, filename: string): Promise<string> {
  let absolute: string;
  try {
    absolute = await fs.realpath(filename);
  } catch {
    throw new EffectCheckFailure("invalid-input", "EFFECT_SOURCE_PATH");
  }
  requireEffect(
    effectInside(root, absolute) &&
      !path.relative(root, absolute).split(path.sep).includes("node_modules"),
    "EFFECT_SOURCE_OUTSIDE_ROOT",
  );
  return absolute;
}
export interface EffectSourceInventory {
  readonly sourceFiles: readonly string[];
  readonly hashes: ReadonlyMap<string, string>;
}
export async function effectSourceInventory(
  output: string,
  root: string,
  roots: readonly string[],
  tool: EffectNativeTool,
  live: EffectLiveCheck,
): Promise<EffectSourceInventory> {
  const lines = output.split(/\r?\n/u).filter((line) => line !== "");
  if (
    lines.length === 0 ||
    lines.length > 50_000 ||
    lines.some(
      (line) => line.length > 4096 || !path.isAbsolute(line) || /[\u0000-\u001f]/u.test(line),
    )
  )
    throw new EffectCheckFailure("execution-failed", "EFFECT_SOURCE_INVENTORY");
  const hashes = new Map<string, string>();
  const seen = new Set<string>();
  let bytesRead = 0;
  for (const line of lines) {
    live();
    const filename = await fs.realpath(line);
    requireEffect(!seen.has(filename), "EFFECT_SOURCE_DUPLICATE");
    seen.add(filename);
    if (tool.libraries.has(filename)) continue;
    if (effectInside(tool.installation, filename)) {
      requireEffect(/\.d\.(?:ts|mts|cts)$/u.test(filename), "EFFECT_DEPENDENCY_SOURCE");
      continue;
    }
    await effectLocalPath(root, filename);
    requireEffect(!/\.d\.(?:ts|mts|cts)$/u.test(filename), "EFFECT_DECLARATION_SOURCE_UNSUPPORTED");
    requireEffect(/\.(?:ts|tsx|mts|cts)$/u.test(filename), "EFFECT_SOURCE_EXTENSION");
    const bytes = await readEffectFile(filename, 4 * 1024 * 1024, live);
    bytesRead += bytes.length;
    requireEffect(bytesRead <= 256 * 1024 * 1024, "EFFECT_SOURCE_LIMIT");
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new EffectCheckFailure("invalid-input", "EFFECT_SOURCE_UTF8");
    }
    requireEffect(!source.includes("@effect-diagnostics"), "EFFECT_SOURCE_DIRECTIVE");
    hashes.set(filename, effectHash(bytes));
  }
  requireEffect(
    hashes.size > 0 && roots.every((filename) => hashes.has(filename)),
    "EFFECT_SOURCE_ROOTS_MISSING",
  );
  return {
    hashes,
    sourceFiles: [...hashes.keys()]
      .map((filename) => path.relative(root, filename).split(path.sep).join("/"))
      .sort(),
  };
}
