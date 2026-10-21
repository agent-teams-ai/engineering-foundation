import { open, realpath, lstat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { getNodeValue, parseTree, type Node, type ParseError } from "jsonc-parser";
import { inspectBunLockfile } from "../../application/bun-registry-policy.js";
import { FOUNDATION_PACKAGE_NAME, type RegistryProvenanceInspection } from "../../application/model.js";

const MAX_LOCK_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;

async function readRegularFile(path: string, maximumBytes: number): Promise<string> {
  if (!(await lstat(path)).isFile()) {
    throw new Error("Expected a regular file.");
  }
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximumBytes) {
      throw new Error("File exceeds its byte bound.");
    }
    const observed = await lstat(path);
    if (!observed.isFile() || observed.dev !== stat.dev || observed.ino !== stat.ino) {
      throw new Error("File identity changed.");
    }
    const buffer = new Uint8Array(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    if (offset > maximumBytes) {
      throw new Error("File exceeds its byte bound.");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
  } finally {
    await file.close();
  }
}

function readUniqueObject(source: string, allowJsonc = true): Record<string, unknown> {
  const errors: ParseError[] = [];
  const tree = parseTree(source, errors, { allowTrailingComma: allowJsonc, disallowComments: !allowJsonc });
  if (tree?.type !== "object" || errors.length !== 0) {
    throw new Error("Expected an unambiguous JSONC object.");
  }
  const pending: Node[] = [tree];
  while (pending.length !== 0) {
    const node = pending.pop();
    if (node === undefined) {
      break;
    }
    if (node.type === "object") {
      const keys = new Set<unknown>();
      for (const property of node.children ?? []) {
        const key: unknown = property.children?.[0]?.value;
        if (keys.has(key)) {
          throw new Error("Duplicate JSONC key.");
        }
        keys.add(key);
      }
    }
    pending.push(...(node.children ?? []));
  }
  return getNodeValue(tree) as Record<string, unknown>;
}

async function inspectInstalledSelection(consumerRoot: string, version: string): Promise<void> {
  const modules = await realpath(join(consumerRoot, "node_modules"));
  if (modules !== join(await realpath(consumerRoot), "node_modules")) {
    throw new Error("External node_modules is unsupported.");
  }
  const root = await realpath(join(modules, FOUNDATION_PACKAGE_NAME));
  const coordinate = relative(modules, root).split(sep);
  const expected = `@agent-teams+engineering-foundation@${version}`;
  if (coordinate.length !== 5 || coordinate[0] !== ".bun" ||
    !(coordinate[1] === expected || coordinate[1]?.match(/^(.+)\+([a-f0-9]{16})$/u)?.[1] === expected) ||
    coordinate[2] !== "node_modules" || coordinate[3] !== "@agent-teams" || coordinate[4] !== "engineering-foundation") {
    throw new Error("Only the contained Bun isolated registry layout is supported.");
  }
  const manifestPath = join(root, "package.json");
  if (await realpath(manifestPath) !== manifestPath) {
    throw new Error("Installed manifest must be canonical.");
  }
  const manifest = readUniqueObject(await readRegularFile(manifestPath, MAX_MANIFEST_BYTES), false);
  if (manifest.name !== FOUNDATION_PACKAGE_NAME || manifest.version !== version) {
    throw new Error("Installed Foundation identity must equal the Bun lock selection.");
  }
}

export async function inspectBunRegistryProvenance(
  consumerRoot: string,
  dependencySpec: string | undefined
): Promise<RegistryProvenanceInspection> {
  const lockfilePath = join(consumerRoot, "bun.lock");
  try {
    const selected = inspectBunLockfile(readUniqueObject(await readRegularFile(lockfilePath, MAX_LOCK_BYTES)), dependencySpec);
    if (selected.issues.length !== 0 || selected.packageKey === undefined || selected.integrity === undefined || dependencySpec === undefined) {
      return { issues: selected.issues };
    }
    await inspectInstalledSelection(consumerRoot, dependencySpec);
    return { provenance: { lockfilePath, packageKey: selected.packageKey, integrity: selected.integrity }, issues: [] };
  } catch (error) {
    return { issues: [`Consumer Bun registry selection cannot be inspected safely: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

export async function readBoundedConsumerManifest(consumerRoot: string): Promise<Record<string, unknown>> {
  return readUniqueObject(await readRegularFile(join(consumerRoot, "package.json"), MAX_MANIFEST_BYTES), false);
}
