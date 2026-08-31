import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { gunzipSync } from "node:zlib";

const forbiddenEntries = [
  "/.git/", "/node_modules/", "/src/", "/tests/", ".env", "auth.json",
  "foundation-link.json", "/secret-fixtures/",
];
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2_500;
const MAX_MEMBER_BYTES = 16 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_TAR_BYTES = MAX_UNCOMPRESSED_BYTES + (MAX_ARCHIVE_ENTRIES + 2) * 1024;

function portableSegmentIdentity(segment) {
  return segment.normalize("NFKC").toUpperCase();
}

export function portableEntryIdentity(entry) {
  if (entry.includes("\\") || entry.startsWith("/") || /^[A-Za-z]:\//u.test(entry) || isAbsolute(entry)) {
    throw new Error(`Package contains an unsafe archive member: ${entry}`);
  }
  const rawSegments = entry.endsWith("/") ? entry.slice(0, -1).split("/") : entry.split("/");
  if (rawSegments.some((segment) => segment === "" || segment === "." || segment === ".." ||
      /[\p{Cc}<>:"|?*]/u.test(segment) || /[. ]$/u.test(segment))) {
    throw new Error(`Package contains an unsafe archive member: ${entry}`);
  }
  const directory = entry.endsWith("/");
  const normalized = normalize(entry).replaceAll("\\", "/").replace(/^\.\//u, "");
  if (normalized === ".." || normalized.startsWith("../") || normalized === "." || normalized === "") {
    throw new Error(`Package contains an unsafe archive member: ${entry}`);
  }
  const identity = directory ? normalized.replace(/\/$/u, "") : normalized;
  const segments = identity.split("/");
  for (const segment of segments) {
    const portableSegment = portableSegmentIdentity(segment);
    const deviceStem = portableSegment.split(".")[0].replace(/[. ]+$/u, "");
    if (portableSegment === "" || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(deviceStem)) {
      throw new Error(`Package contains a non-portable archive member: ${entry}`);
    }
  }
  return segments.map(portableSegmentIdentity).join("/");
}

function archiveEntries(listing) {
  const entries = listing.split(/\r?\n/u).filter(Boolean);
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(`Package contains too many entries: ${entries.length}.`);
  }
  const identities = new Map();
  for (const entry of entries) {
    const identity = portableEntryIdentity(entry);
    const previous = identities.get(identity);
    if (previous !== undefined) {
      throw new Error(`Package contains duplicate or normalized-colliding archive members: ${previous}, ${entry}`);
    }
    identities.set(identity, entry);
  }
  return entries;
}

export function assertArchiveListing(listing, requiredArtifactPaths, allowedArtifactPaths = requiredArtifactPaths) {
  for (const forbidden of forbiddenEntries) {
    if (listing.includes(forbidden)) {
      throw new Error(`Forbidden package entry detected: ${forbidden}`);
    }
  }
  const entries = archiveEntries(listing);
  const entrySet = new Set(entries);
  const requiredEntries = [
    "package/package.json", "package/LICENSE", "package/README.md",
    ...requiredArtifactPaths.map((path) => `package/${path}`),
  ];
  for (const required of requiredEntries) {
    if (!entrySet.has(required)) {
      throw new Error(`Required package entry missing: ${required}`);
    }
  }
  const requiredDirectories = new Set(["package/"]);
  for (const required of requiredEntries) {
    let boundary = required.lastIndexOf("/");
    while (boundary >= "package".length) {
      requiredDirectories.add(`${required.slice(0, boundary)}/`);
      boundary = required.lastIndexOf("/", boundary - 1);
    }
  }
  for (const entry of entries) {
    const packagePath = entry.startsWith("package/") ? entry.slice("package/".length).replace(/\/$/u, "") : "";
    const manifestAllows = allowedArtifactPaths.some((allowed) =>
      packagePath === allowed || packagePath.startsWith(`${allowed.replace(/\/$/u, "")}/`));
    if (!requiredDirectories.has(entry) && !entry.startsWith("package/dist/") &&
        !requiredEntries.includes(entry) && !manifestAllows) {
      throw new Error(`Package entry is outside the release allowlist: ${entry}`);
    }
  }
}

function parseTarNumber(field, label) {
  if ((field[0] & 0x80) !== 0) {
    throw new Error(`Package tar uses unsupported base-256 ${label}.`);
  }
  const text = field.toString("ascii").split("\0", 1)[0].trim();
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

function verifyTarChecksum(header) {
  const expected = parseTarNumber(header.subarray(148, 156), "header checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (actual !== expected) {
    throw new Error("Package tar has an invalid header checksum.");
  }
}

function tarField(decoder, bytes) {
  const terminator = bytes.indexOf(0);
  return decoder.decode(bytes.subarray(0, terminator < 0 ? bytes.length : terminator));
}

function assertTarTerminator(tar, offset) {
  if (offset + 1024 > tar.length || !tar.subarray(offset, offset + 1024).every((byte) => byte === 0) ||
      !tar.subarray(offset + 1024).every((byte) => byte === 0)) {
    throw new Error("Package tar lacks a valid two-zero-block terminator or has hidden trailing data.");
  }
}

function assertSupportedTarMetadata(type, data) {
  if ((type === "x" || type === "g") && /(?:GNU\.sparse\.|SCHILY\.realsize)/u.test(data.toString("utf8"))) {
    throw new Error("Package tar contains prohibited PAX sparse logical-file metadata.");
  }
  if (type === "x" || type === "g") {
    throw new Error("Package tar contains unsupported PAX extended metadata.");
  }
}

export function inspectCompressedTarArchive(archiveBytes) {
  if (!Buffer.isBuffer(archiveBytes) || archiveBytes.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`Package archive exceeds ${MAX_ARCHIVE_BYTES} bytes.`);
  }
  let tar;
  try {
    tar = gunzipSync(archiveBytes, { maxOutputLength: MAX_TAR_BYTES });
  } catch (error) {
    throw new Error(`Package archive cannot be decompressed within its safety bound: ${error.message}`, { cause: error });
  }
  let aggregateBytes = 0;
  let entryCount = 0;
  let offset = 0;
  const entries = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      assertTarTerminator(tar, offset);
      offset = tar.length;
      break;
    }
    verifyTarChecksum(header);
    const size = parseTarNumber(header.subarray(124, 136), "member size");
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    let name;
    try {
      const leaf = tarField(decoder, header.subarray(0, 100));
      const prefix = tarField(decoder, header.subarray(345, 500));
      name = prefix === "" ? leaf : `${prefix}/${leaf}`;
    } catch (error) {
      throw new Error(`Package tar has a malformed UTF-8 member name: ${error.message}`, { cause: error });
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
    if (entryCount > MAX_ARCHIVE_ENTRIES) {
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
  if (offset !== tar.length) {
    throw new Error("Package tar is truncated or lacks a two-zero-block terminator.");
  }
  const result = { aggregateBytes, entryCount, uncompressedBytes: tar.length };
  Object.defineProperty(result, "entries", { value: Object.freeze(entries) });
  return Object.freeze(result);
}

function sameFileState(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export async function readRegularArchive(path) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_ARCHIVE_BYTES) {
    throw new Error(`Package archive is not a bounded regular file: ${path}.`);
  }
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error(`Package archive changed before verification: ${path}.`);
    }
    const bytes = Buffer.alloc(opened.size);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const overflow = Buffer.alloc(1);
    const { bytesRead: overflowBytes } = await handle.read(overflow, 0, 1, bytes.length);
    const after = await handle.stat();
    if (bytesRead !== bytes.length || overflowBytes !== 0 || !sameFileState(opened, after)) {
      throw new Error(`Package archive changed during verification: ${path}.`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

export async function readVerifiedArchive(path, expectedSha256) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Verified package archive was replaced by a symlink: ${path}.`);
  }
  const bytes = await readRegularArchive(path);
  if (sha256(bytes) !== expectedSha256) {
    throw new Error(`Verified package archive digest changed: ${path}.`);
  }
  return bytes;
}

export function assertNoSpecialTarEntries(verboseListing) {
  for (const line of verboseListing.split(/\r?\n/u).filter(Boolean)) {
    const type = line[0];
    if (type !== "-" && type !== "d") {
      throw new Error(`Package contains a prohibited special tar entry: ${line}`);
    }
  }
}

export function assertArchiveSafety({ allowedArtifactPaths, archiveBytes, listing, requiredArtifactPaths, verboseListing }) {
  if (!Buffer.isBuffer(archiveBytes) || archiveBytes.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`Package archive exceeds ${MAX_ARCHIVE_BYTES} bytes.`);
  }
  assertArchiveListing(listing, requiredArtifactPaths, allowedArtifactPaths);
  assertNoSpecialTarEntries(verboseListing);
}
