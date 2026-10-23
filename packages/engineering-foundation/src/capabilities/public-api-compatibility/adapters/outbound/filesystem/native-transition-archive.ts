import { isAbsolute, normalize } from "node:path";
import { gunzipSync } from "node:zlib";
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_MEMBER_BYTES = 16 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
export interface ArchiveInspection {
  readonly aggregateBytes: number;
  readonly entryCount: number;
  readonly uncompressedBytes: number;
  readonly entries: readonly {
    readonly data: Buffer;
    readonly name: string;
    readonly size: number;
    readonly type: string;
  }[];
}
function portableSegmentIdentity(segment: string): string {
  return segment.normalize("NFKC").toUpperCase();
}

export function portableEntryIdentity(entry: string): string {
  if (
    entry.includes("\\") ||
    entry.startsWith("/") ||
    /^[A-Za-z]:\//u.test(entry) ||
    isAbsolute(entry)
  ) {
    throw new Error(`Package contains an unsafe archive member: ${entry}`);
  }
  const rawSegments = entry.endsWith("/") ? entry.slice(0, -1).split("/") : entry.split("/");
  if (
    rawSegments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        /[\p{Cc}<>:"|?*]/u.test(segment) ||
        /[. ]$/u.test(segment),
    )
  ) {
    throw new Error(`Package contains an unsafe archive member: ${entry}`);
  }
  const directory = entry.endsWith("/");
  const normalized = normalize(entry).replaceAll("\\", "/").replace(/^\.\//u, "");
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized === "." ||
    normalized === ""
  ) {
    throw new Error(`Package contains an unsafe archive member: ${entry}`);
  }
  const identity = directory ? normalized.replace(/\/$/u, "") : normalized;
  const segments = identity.split("/");
  for (const segment of segments) {
    const portableSegment = portableSegmentIdentity(segment);
    const deviceStem = portableSegment.split(".")[0]!.replace(/[. ]+$/u, "");
    if (portableSegment === "" || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(deviceStem)) {
      throw new Error(`Package contains a non-portable archive member: ${entry}`);
    }
  }
  return segments.map(portableSegmentIdentity).join("/");
}

function parseTarNumber(field: Buffer, label: string): number {
  if ((field[0]! & 0x80) !== 0) {
    throw new Error(`Package tar uses unsupported base-256 ${label}.`);
  }
  const text = field.toString("ascii").split("\0", 1)[0]!.trim();
  if (text === "") {
    return 0;
  }
  if (!/^[0-7]+$/u.test(text)) {
    throw new Error(`Package tar has malformed ${label}.`);
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Package tar ${label} is not safely bounded.`);
  }
  return value;
}

function verifyTarChecksum(header: Buffer): void {
  const expected = parseTarNumber(header.subarray(148, 156), "header checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index]!;
  }
  if (actual !== expected) {
    throw new Error("Package tar has an invalid header checksum.");
  }
}

function tarField(decoder: TextDecoder, bytes: Buffer): string {
  const terminator = bytes.indexOf(0);
  return decoder.decode(bytes.subarray(0, terminator < 0 ? bytes.length : terminator));
}

function assertTarTerminator(tar: Buffer, offset: number): void {
  if (
    offset + 1024 > tar.length ||
    !tar.subarray(offset, offset + 1024).every((byte) => byte === 0) ||
    !tar.subarray(offset + 1024).every((byte) => byte === 0)
  ) {
    throw new Error(
      "Package tar lacks a valid two-zero-block terminator or has hidden trailing data.",
    );
  }
}

function assertSupportedTarMetadata(type: string, data: Buffer): void {
  if (
    (type === "x" || type === "g") &&
    /(?:GNU\.sparse\.|SCHILY\.realsize)/u.test(data.toString("utf8"))
  ) {
    throw new Error("Package tar contains prohibited PAX sparse logical-file metadata.");
  }
  if (type === "x" || type === "g") {
    throw new Error("Package tar contains unsupported PAX extended metadata.");
  }
}

/**
 * @returns {Readonly<{ aggregateBytes: number, entryCount: number, uncompressedBytes: number,
 *   entries: ReadonlyArray<Readonly<{ data: Buffer, name: string, size: number, type: string }>> }>}
 */
export function inspectCompressedTarArchive(
  archiveBytes: Buffer,
  maximumEntries: number,
): ArchiveInspection {
  if (!Buffer.isBuffer(archiveBytes) || archiveBytes.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`Package archive exceeds ${MAX_ARCHIVE_BYTES} bytes.`);
  }
  let tar;
  try {
    const maximumTarBytes = MAX_UNCOMPRESSED_BYTES + (maximumEntries + 2) * 1024;
    tar = gunzipSync(archiveBytes, { maxOutputLength: maximumTarBytes });
  } catch (error) {
    throw new Error(
      `Package archive cannot be decompressed within its safety bound: ${String(error)}`,
      { cause: error },
    );
  }
  let aggregateBytes = 0;
  let entryCount = 0;
  let offset = 0;
  let terminated = false;
  const entries = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      assertTarTerminator(tar, offset);
      terminated = true;
      offset = tar.length;
      break;
    }
    verifyTarChecksum(header);
    const size = parseTarNumber(header.subarray(124, 136), "member size");
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]!);
    let name;
    try {
      const leaf = tarField(decoder, header.subarray(0, 100));
      const prefix = tarField(decoder, header.subarray(345, 500));
      name = prefix === "" ? leaf : `${prefix}/${leaf}`;
    } catch (error) {
      throw new Error(`Package tar has a malformed UTF-8 member name: ${String(error)}`, {
        cause: error,
      });
    }
    portableEntryIdentity(name);
    if (type === "S") {
      throw new Error("Package tar contains a prohibited GNU sparse logical file.");
    }
    if (size > MAX_MEMBER_BYTES) {
      throw new Error(`Package tar member exceeds ${MAX_MEMBER_BYTES} bytes.`);
    }
    aggregateBytes += size;
    if (aggregateBytes > MAX_UNCOMPRESSED_BYTES) {
      throw new Error(`Package tar members exceed ${MAX_UNCOMPRESSED_BYTES} aggregate bytes.`);
    }
    entryCount += 1;
    if (entryCount > maximumEntries) {
      throw new Error(`Package contains too many entries: ${entryCount}.`);
    }
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (next > tar.length) {
      throw new Error("Package tar member extends beyond the archive.");
    }
    const data = tar.subarray(offset + 512, offset + 512 + size);
    assertSupportedTarMetadata(type, data);
    entries.push(Object.freeze({ data, name, size, type }));
    offset = next;
  }
  if (!terminated || offset !== tar.length) {
    throw new Error("Package tar is truncated or lacks a two-zero-block terminator.");
  }
  const result = {
    aggregateBytes,
    entryCount,
    uncompressedBytes: tar.length,
    entries: Object.freeze(entries),
  };
  Object.defineProperty(result, "entries", { enumerable: false });
  return Object.freeze(result);
}
