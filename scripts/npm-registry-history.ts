import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { inspectCompressedTarArchive } from "./pack-artifact-archive.mjs";
import { readRegistryBytes } from "./npm-registry-read.ts";

type PlaceholderAuthority = { version: string; archiveIntegrity: string };
type HistoryProfile = { name: string; providerPlaceholder?: PlaceholderAuthority };
const description = "Temporary package placeholder for staged publishing";
const readme =
  "# Temporary Holding Version\n\nThis version is a temporary placeholder for this package. An operational version to replace this has been submitted for review and is awaiting a staged release.\n";
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function refuse(): never {
  throw new Error("npm package bootstrap refused: unqualified npm provider placeholder.");
}

function placeholderFiles(bytes: Buffer, profile: HistoryProfile): Map<string, Buffer> {
  // npm's pinned holding tar ends exactly after the final padded member, without
  // end blocks. Add terminators only to the inspection view, never to authority bytes.
  const original = gunzipSync(bytes, { maxOutputLength: 16_384 });
  if (original.length % 512 !== 0) {
    refuse();
  }
  const inspection = inspectCompressedTarArchive(
    gzipSync(Buffer.concat([original, Buffer.alloc(1024)])),
    profile.name,
  );
  const consumed = inspection.entries.reduce(
    (size, entry) => size + 512 + Math.ceil(entry.size / 512) * 512,
    0,
  );
  if (consumed !== original.length) {
    refuse();
  }
  const files = new Map<string, Buffer>();
  let directory = false;
  for (const entry of inspection.entries) {
    if (
      entry.type === "5" &&
      ["package", "package/"].includes(entry.name) &&
      !directory &&
      entry.size === 0
    ) {
      directory = true;
    } else if (
      entry.type === "0" &&
      ["package/package.json", "package/README.md"].includes(entry.name) &&
      !files.has(entry.name)
    ) {
      files.set(entry.name, entry.data);
    } else {
      refuse();
    }
  }
  return files;
}

export function assertProviderPlaceholderArchive(bytes: Buffer, profile: HistoryProfile): void {
  const authority = profile.providerPlaceholder;
  if (
    authority === undefined ||
    bytes.length > 16_384 ||
    `sha512-${createHash("sha512").update(bytes).digest("base64")}` !== authority.archiveIntegrity
  ) {
    refuse();
  }
  const files = placeholderFiles(bytes, profile);
  const manifest: unknown = JSON.parse(
    files.get("package/package.json")?.toString("utf8") ?? "null",
  );
  if (
    files.size !== 2 ||
    !record(manifest) ||
    Object.keys(manifest).toSorted().join("\0") !== "description\0name\0stub\0version" ||
    manifest.name !== profile.name ||
    manifest.version !== authority.version ||
    manifest.stub !== true ||
    manifest.description !== description ||
    files.get("package/README.md")?.toString("utf8") !== readme
  ) {
    refuse();
  }
}

function placeholderRecord(
  entry: unknown,
  profile: HistoryProfile,
  authority: PlaceholderAuthority,
  tags: Record<string, unknown> | undefined,
  expectedUrl: string,
) {
  if (
    !record(entry) ||
    !record(entry.dist) ||
    entry.name !== profile.name ||
    entry["_id"] !== `${profile.name}@${authority.version}` ||
    entry.version !== authority.version ||
    Object.keys(entry).toSorted().join("\0") !==
      "_id\0_npmUser\0description\0directories\0dist\0maintainers\0name\0stub\0version" ||
    !record(entry.directories) ||
    Object.keys(entry.directories).length !== 0 ||
    entry.stub !== true ||
    entry.description !== description ||
    entry.dist.integrity !== authority.archiveIntegrity ||
    entry.dist.tarball !== expectedUrl ||
    entry.dist.fileCount !== 2 ||
    Object.values(tags ?? {}).includes(authority.version)
  ) {
    refuse();
  }
  return { entry, dist: entry.dist };
}

export async function qualifyRegistryHistory(
  packument: { versions: Record<string, unknown>; "dist-tags"?: Record<string, unknown> },
  profile: HistoryProfile,
  fetchImplementation: typeof fetch = fetch,
) {
  const rawVersions = Object.keys(packument.versions).toSorted();
  const authority = profile.providerPlaceholder;
  if (authority === undefined || !Object.hasOwn(packument.versions, authority.version)) {
    return { versions: rawVersions, rawVersions, providerPlaceholders: [] };
  }
  const expectedUrl = `https://registry.npmjs.org/${profile.name}/-/${profile.name.split("/").at(-1)}-${authority.version}.tgz`;
  const { entry, dist } = placeholderRecord(
    packument.versions[authority.version],
    profile,
    authority,
    packument["dist-tags"],
    expectedUrl,
  );
  const response = await readRegistryBytes(expectedUrl, fetchImplementation, 10_000, 16_384);
  if (response.status !== 200) {
    refuse();
  }
  assertProviderPlaceholderArchive(response.bytes, profile);
  if (dist.shasum !== createHash("sha1").update(response.bytes).digest("hex")) {
    refuse();
  }
  return {
    versions: rawVersions.filter((version) => version !== authority.version),
    rawVersions,
    providerPlaceholders: [
      {
        version: authority.version,
        archiveIntegrity: authority.archiveIntegrity,
        archiveSha256: createHash("sha256").update(response.bytes).digest("hex"),
        record: entry,
      },
    ],
  };
}
