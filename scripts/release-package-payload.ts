import { createHash, type Hash } from "node:crypto";
import { readdir, readFile, readlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";
function portablePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}
async function updatePackagePayloadHash(hash: Hash, root: string, directory = ""): Promise<void> {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    const relativePath = join(directory, entry.name);
    const absolutePath = join(root, relativePath);
    hash.update(`${portablePath(root, absolutePath)}\0`);
    if (entry.isDirectory()) {
      hash.update("directory\0");
      await updatePackagePayloadHash(hash, root, relativePath);
    } else if (entry.isSymbolicLink()) {
      hash.update(`symlink\0${await readlink(absolutePath)}\0`);
    } else if (entry.isFile()) {
      const bytes = await readFile(absolutePath);
      hash.update(`file\0${bytes.length}\0`);
      hash.update(bytes);
    } else {
      throw new Error(`Unsupported publish payload entry ${portablePath(root, absolutePath)}.`);
    }
  }
}

export async function packagePayloadDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  await updatePackagePayloadHash(hash, root);
  return hash.digest("hex");
}

export function expectedIntegrityHex(integrity: string | undefined): string {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/u.exec(integrity ?? "");
  const encoded = match?.[1];
  const bytes = encoded === undefined ? undefined : Buffer.from(encoded, "base64");
  if (bytes === undefined || bytes.length !== 64 || bytes.toString("base64") !== encoded) {
    throw new Error("npm verified provenance received non-canonical artifact SRI.");
  }
  return bytes.toString("hex");
}
