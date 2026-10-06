import { parseStrictJson } from "@agent-teams/repository-mutation/serialization";

interface TarEntry {
  readonly normalized: string;
  readonly regular: boolean;
  readonly size: number;
  readonly start: number;
  readonly end: number;
  readonly next: number;
}

/** Bounded gzip decoding for the explicitly supported disposable leaf-package profile. */
async function expandedTarball(bytes: Buffer, maximum: number): Promise<Buffer> {
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller): void {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    }
  });
  const reader = source.pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      total += chunk.value.byteLength;
      if (total > maximum) {
        throw new Error("local-tarball-expansion-limit");
      }
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await reader.cancel().catch(() => null);
    reader.releaseLock();
  }
}

function tarText(header: Buffer, start: number, length: number): string {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  if (end !== -1 && field.subarray(end).some(byte => byte !== 0)) {
    throw new Error("unsupported-local-tarball-text");
  }
  const text = end === -1 ? field : field.subarray(0, end);
  if (text.some(byte => byte < 32 || byte > 126)) {
    throw new Error("unsupported-local-tarball-name");
  }
  return text.toString("ascii");
}

function tarOctal(header: Buffer, start: number, length: number): number {
  const field = header.subarray(start, start + length);
  if (field.some(byte => byte !== 0 && byte !== 32 && (byte < 48 || byte > 55))) {
    throw new Error("unsupported-local-tarball-number");
  }
  const text = field.toString("ascii").replaceAll("\0", " ").trim();
  if (!/^[0-7]+$/.test(text)) {
    throw new Error("invalid-local-tarball-number");
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) {
    throw new Error("local-tarball-number-limit");
  }
  return value;
}

function tarEntryName(header: Buffer): string {
  const ustar = header.subarray(257, 265).equals(Buffer.from([117, 115, 116, 97, 114, 0, 48, 48]));
  const gnu = header.subarray(257, 265).equals(Buffer.from([117, 115, 116, 97, 114, 32, 32, 0]));
  const checksum = header.reduce((sum, byte, index) =>
    sum + (index >= 148 && index < 156 ? 32 : byte), 0);
  if ((!ustar && !gnu) || checksum !== tarOctal(header, 148, 8)) {
    throw new Error("unsupported-local-tarball-header");
  }
  const prefix = ustar ? tarText(header, 345, 155) : "";
  const leaf = tarText(header, 0, 100);
  return prefix ? `${prefix}/${leaf}` : leaf;
}

function admitTarPath(name: string, names: Set<string>): string {
  const normalized = name.endsWith("/") ? name.slice(0, -1) : name;
  if (!/^package(?:\/[A-Za-z0-9._@-]+)*$/.test(normalized) ||
      normalized.split("/").some(part => part === "." || part === "..") ||
      names.has(normalized) || names.size >= 4096) {
    throw new Error("unsupported-local-tarball-path");
  }
  names.add(normalized);
  return normalized;
}

function readTarEntry(header: Buffer, bytes: Buffer, offset: number, names: Set<string>): TarEntry {
  const name = tarEntryName(header);
  const normalized = admitTarPath(name, names);
  const size = tarOctal(header, 124, 12);
  const type = header[156];
  const regular = type === 0 || type === 48;
  if ((!regular && type !== 53) || (!regular && size !== 0) ||
      regular && (name.endsWith("/") || !normalized.startsWith("package/"))) {
    throw new Error("unsupported-local-tarball-entry");
  }
  const start = offset + 512;
  const end = start + size;
  const next = start + Math.ceil(size / 512) * 512;
  if (next > bytes.length || bytes.subarray(end, next).some(byte => byte !== 0)) {
    throw new Error("invalid-local-tarball-size");
  }
  return { normalized, regular, size, start, end, next };
}

/** USTAR or short-name GNU headers only: ordinary files/directories, no links or extensions. */
function packageManifest(bytes: Buffer): Buffer {
  if (bytes.length < 1024 || bytes.length % 512 !== 0) {
    throw new Error("invalid-local-tarball-framing");
  }
  const names = new Set<string>();
  let manifest: Buffer | null = null;
  let terminated = false;
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (bytes.length - offset < 1024 || bytes.subarray(offset).some(byte => byte !== 0)) {
        throw new Error("invalid-local-tarball-termination");
      }
      terminated = true;
      break;
    }
    const entry = readTarEntry(header, bytes, offset, names);
    if (entry.regular && entry.normalized === "package/package.json") {
      if (entry.size > 1024 * 1024) {
        throw new Error("local-package-manifest-limit");
      }
      manifest = bytes.subarray(entry.start, entry.end);
    }
    offset = entry.next;
  }
  if (!terminated || manifest === null) {
    throw new Error("local-package-manifest-missing");
  }
  return manifest;
}

function verifyLeafManifest(manifest: Buffer, expectedName: string): void {
  const parsed: unknown = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(manifest));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid-local-package-manifest");
  }
  const project = parsed as Record<string, unknown>;
  if (project.name !== expectedName || typeof project.version !== "string" ||
      !/^\d+\.\d+\.\d+$/.test(project.version) ||
      ["dependencies", "optionalDependencies", "devDependencies", "bundledDependencies",
        "bundleDependencies", "workspaces", "pnpm"].some(key => Object.hasOwn(project, key))) {
    throw new Error("unsupported-local-package-closure");
  }
  if (Object.hasOwn(project, "peerDependencies")) {
    const peers = project.peerDependencies;
    if (peers === null || typeof peers !== "object" || Array.isArray(peers) ||
        Object.values(peers).some(value => typeof value !== "string")) {
      throw new Error("invalid-local-package-peers");
    }
  }
}

/** Feature-private archive mechanism; descriptor custody and aggregate budgets stay in installation. */
export async function verifyLeafArchive(bytes: Buffer, maximum: number, expectedName: string): Promise<number> {
  const archive = await expandedTarball(bytes, maximum);
  verifyLeafManifest(packageManifest(archive), expectedName);
  return archive.length;
}
