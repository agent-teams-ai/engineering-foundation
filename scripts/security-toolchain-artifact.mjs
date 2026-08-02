import { createHash, timingSafeEqual } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

const gunzipAsync = promisify(gunzip);

export const AQUA_VERSION = "2.62.3";
const AQUA_RELEASE_ROOT =
  "https://github.com/aquaproj/aqua/releases/download/v" + AQUA_VERSION;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_EXPANDED_ARCHIVE_BYTES = 128 * 1024 * 1024;
const TAR_BLOCK_SIZE = 512;

function aquaArtifact(fileName, sha256, executableSha256) {
  return Object.freeze({
    executableSha256,
    fileName,
    sha256,
    url: AQUA_RELEASE_ROOT + "/" + fileName
  });
}

const AQUA_ARTIFACTS = Object.freeze({
  "darwin:arm64": aquaArtifact(
    "aqua_darwin_arm64.tar.gz",
    "e6a5831dd12b5d571716aa8b81d799abb09278a9b83b751ed93e74c687b9c9df",
    "4bc50e729efa11581194735f08f72d8bf8f454acef26e793a16e144aec13497d"
  ),
  "darwin:x64": aquaArtifact(
    "aqua_darwin_amd64.tar.gz",
    "b9144f0387538e8a08cf7c2325ec3b5263b73fbba1c50da933cd36ffc534d280",
    "28772e39b2341d64c1fcccedebff3ef020530a48de39a62fc0c78da2b11cf28b"
  ),
  "linux:arm64": aquaArtifact(
    "aqua_linux_arm64.tar.gz",
    "a6b485fc465cd9317a2d8421bd145d4364606690fa49840347eca9ec84223fa9",
    "6cd59989a085c365cc4fa59858de001cbdbface925f601195190a17db211fe78"
  ),
  "linux:x64": aquaArtifact(
    "aqua_linux_amd64.tar.gz",
    "89cb081adb19e425b1dca6b16d912c349a43535ce88d8713050738c9263618d0",
    "e3e28482e8a0ef5258cf273e87b3f0cb72e50cb2c9f52d6a10fc8270f5571e5f"
  )
});

export class SecurityToolchainError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.code = code;
    this.name = "SecurityToolchainError";
  }
}

export class UnsupportedAquaPlatformError extends SecurityToolchainError {
  constructor(platform, architecture) {
    super(
      "SECURITY_TOOLCHAIN_UNSUPPORTED_PLATFORM",
      "Pinned Aqua " +
        AQUA_VERSION +
        " bootstrap does not support " +
        platform +
        "/" +
        architecture +
        ". Supported targets: " +
        Object.keys(AQUA_ARTIFACTS).join(", ") +
        ". The workflow security gate is not run on Windows CI."
    );
    this.architecture = architecture;
    this.name = "UnsupportedAquaPlatformError";
    this.platform = platform;
  }
}

export class AquaChecksumMismatchError extends SecurityToolchainError {
  constructor(artifact, actualChecksum) {
    super(
      "SECURITY_TOOLCHAIN_CHECKSUM_MISMATCH",
      "Pinned Aqua archive checksum mismatch for " +
        artifact.fileName +
        ": expected " +
        artifact.sha256 +
        ", received " +
        actualChecksum +
        "."
    );
    this.actualChecksum = actualChecksum;
    this.artifact = artifact;
    this.name = "AquaChecksumMismatchError";
  }
}

export class AquaExecutableChecksumMismatchError extends SecurityToolchainError {
  constructor(artifact, actualChecksum) {
    super(
      "SECURITY_TOOLCHAIN_EXECUTABLE_CHECKSUM_MISMATCH",
      "Pinned Aqua executable checksum mismatch for " +
        artifact.fileName +
        ": expected " +
        artifact.executableSha256 +
        ", received " +
        actualChecksum +
        "."
    );
    this.actualChecksum = actualChecksum;
    this.artifact = artifact;
    this.name = "AquaExecutableChecksumMismatchError";
  }
}

export function selectAquaArtifact({
  architecture = process.arch,
  platform = process.platform
} = {}) {
  const artifact = AQUA_ARTIFACTS[platform + ":" + architecture];
  if (artifact === undefined) {
    throw new UnsupportedAquaPlatformError(platform, architecture);
  }
  return artifact;
}

function checksum(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function verifyAquaArchiveChecksum(archive, artifact) {
  const expected = artifact.sha256.toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(expected)) {
    throw new SecurityToolchainError(
      "SECURITY_TOOLCHAIN_INVALID_CHECKSUM",
      "Pinned Aqua checksum is invalid for " + artifact.fileName + "."
    );
  }
  const actual = checksum(archive);
  const matches = timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  if (!matches) {
    throw new AquaChecksumMismatchError(artifact, actual);
  }
}

export function verifyAquaExecutableChecksum(executable, artifact) {
  const expected = artifact.executableSha256?.toLowerCase();
  if (expected === undefined || !/^[a-f0-9]{64}$/u.test(expected)) {
    throw new SecurityToolchainError(
      "SECURITY_TOOLCHAIN_INVALID_EXECUTABLE_CHECKSUM",
      "Pinned Aqua executable checksum is invalid for " + artifact.fileName + "."
    );
  }
  const actual = checksum(executable);
  const matches = timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  if (!matches) {
    throw new AquaExecutableChecksumMismatchError(artifact, actual);
  }
}

export async function downloadAquaArtifact(
  artifact,
  { timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}
) {
  let response;
  try {
    response = await fetch(artifact.url, {
      headers: { "user-agent": "agent-teams-engineering-foundation-security-toolchain" },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new SecurityToolchainError(
      "SECURITY_TOOLCHAIN_DOWNLOAD_FAILED",
      "Unable to download pinned Aqua " + AQUA_VERSION + ".",
      { cause: error }
    );
  }
  if (!response.ok) {
    throw new SecurityToolchainError(
      "SECURITY_TOOLCHAIN_DOWNLOAD_FAILED",
      "Pinned Aqua download returned HTTP " + response.status + "."
    );
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number.isSafeInteger(Number(declaredLength)) &&
    Number(declaredLength) > MAX_ARCHIVE_BYTES
  ) {
    throw new SecurityToolchainError(
      "SECURITY_TOOLCHAIN_DOWNLOAD_TOO_LARGE",
      "Pinned Aqua archive exceeds the maximum permitted size."
    );
  }
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new SecurityToolchainError(
      "SECURITY_TOOLCHAIN_DOWNLOAD_TOO_LARGE",
      "Pinned Aqua archive exceeds the maximum permitted size."
    );
  }
  return archive;
}

function tarText(archive, offset, length) {
  const field = archive.subarray(offset, offset + length);
  const terminator = field.indexOf(0);
  return field.subarray(0, terminator === -1 ? field.length : terminator).toString("utf8");
}

function tarSize(archive, offset) {
  const source = tarText(archive, offset, 12).trim();
  if (!/^[0-7]*$/u.test(source)) {
    throw new SecurityToolchainError(
      "SECURITY_TOOLCHAIN_INVALID_ARCHIVE",
      "Pinned Aqua archive contains an invalid tar entry size."
    );
  }
  const size = source.length === 0 ? 0 : Number.parseInt(source, 8);
  if (!Number.isSafeInteger(size)) {
    throw new SecurityToolchainError(
      "SECURITY_TOOLCHAIN_INVALID_ARCHIVE",
      "Pinned Aqua archive contains an oversized tar entry."
    );
  }
  return size;
}

function tarEntryName(archive, offset) {
  const name = tarText(archive, offset, 100);
  const prefix = tarText(archive, offset + 345, 155);
  const entryName = prefix.length === 0 ? name : prefix + "/" + name;
  if (
    entryName.length === 0 ||
    entryName.startsWith("/") ||
    entryName.includes("\u0000") ||
    entryName.split("/").some((segment) => segment === "..")
  ) {
    throw new SecurityToolchainError(
      "SECURITY_TOOLCHAIN_INVALID_ARCHIVE",
      "Pinned Aqua archive contains an unsafe tar entry path."
    );
  }
  return entryName;
}

function isEmptyTarBlock(archive, offset) {
  for (let index = offset; index < offset + TAR_BLOCK_SIZE; index += 1) {
    if (archive[index] !== 0) {
      return false;
    }
  }
  return true;
}

export async function extractAquaExecutable(archive, destination) {
  let tar;
  try {
    tar = await gunzipAsync(archive, { maxOutputLength: MAX_EXPANDED_ARCHIVE_BYTES });
  } catch (error) {
    throw new SecurityToolchainError(
      "SECURITY_TOOLCHAIN_INVALID_ARCHIVE",
      "Pinned Aqua archive is not a valid gzip-compressed tarball.",
      { cause: error }
    );
  }
  let executableFound = false;
  for (let offset = 0; offset + TAR_BLOCK_SIZE <= tar.byteLength; ) {
    if (isEmptyTarBlock(tar, offset)) {
      break;
    }
    const entryName = tarEntryName(tar, offset);
    const size = tarSize(tar, offset + 124);
    const type = tar[offset + 156];
    const dataStart = offset + TAR_BLOCK_SIZE;
    const dataEnd = dataStart + size;
    const nextOffset = dataStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    if (dataEnd > tar.byteLength || nextOffset > tar.byteLength) {
      throw new SecurityToolchainError(
        "SECURITY_TOOLCHAIN_INVALID_ARCHIVE",
        "Pinned Aqua archive contains a truncated tar entry."
      );
    }
    if (entryName === "aqua") {
      if (executableFound || (type !== 0 && type !== "0".charCodeAt(0))) {
        throw new SecurityToolchainError(
          "SECURITY_TOOLCHAIN_INVALID_ARCHIVE",
          "Pinned Aqua archive does not contain one regular aqua executable."
        );
      }
      await writeFile(destination, tar.subarray(dataStart, dataEnd), {
        flag: "wx",
        mode: 0o700
      });
      executableFound = true;
    }
    offset = nextOffset;
  }
  if (!executableFound) {
    throw new SecurityToolchainError(
      "SECURITY_TOOLCHAIN_INVALID_ARCHIVE",
      "Pinned Aqua archive does not contain an aqua executable."
    );
  }
}
