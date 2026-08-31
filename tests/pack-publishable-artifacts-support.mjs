import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

export function catalogEntry(name) {
  const leaf = name.slice(name.lastIndexOf("/") + 1);
  return {
    changelogPath: `packages/${leaf}/CHANGELOG.md`,
    manifestPath: `packages/${leaf}/package.json`,
    name,
    root: `packages/${leaf}`,
  };
}

export function tarHeader(name, size, type = "0") {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(32, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

export function tarArchive(entries) {
  const chunks = [];
  for (const { data = Buffer.alloc(0), name, type = "0" } of entries) {
    chunks.push(tarHeader(name, data.length, type), data);
    chunks.push(Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

export function compressedTar(name, declaredSize, payload = Buffer.alloc(0)) {
  const padding = Buffer.alloc((512 - payload.length % 512) % 512);
  return gzipSync(Buffer.concat([tarHeader(name, declaredSize), payload, padding, Buffer.alloc(1024)]));
}
export function qualifiedArchive(manifest, extraEntries = []) {
  return tarArchive([
    { name: "package/", type: "5" },
    { data: Buffer.from(JSON.stringify(manifest)), name: "package/package.json" },
    { data: Buffer.from("fixture license\n"), name: "package/LICENSE" },
    { data: Buffer.from("# Fixture\n"), name: "package/README.md" },
    { name: "package/dist/", type: "5" },
    { data: Buffer.from("export {};\n"), name: "package/dist/index.js" },
    ...extraEntries,
  ]);
}

export async function createPackFixture(t, prefix) {
  const repositoryRoot = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(repositoryRoot, { force: true, recursive: true }));
  const packageRoot = join(repositoryRoot, "packages", "qualified");
  const temporaryRoot = join(repositoryRoot, "temporary");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(temporaryRoot, { recursive: true });
  await writeFile(join(repositoryRoot, "LICENSE"), "fixture license\n");
  await writeFile(join(repositoryRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await writeFile(join(packageRoot, "package.json"),
    JSON.stringify({ name: "@fixture/qualified", version: "1.2.3" }));
  await writeFile(join(packageRoot, "README.md"), "# Fixture\n");
  return { packageRoot, repositoryRoot, temporaryRoot };
}
