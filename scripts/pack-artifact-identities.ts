type FileIdentity = { dev?: number | bigint; ino?: number | bigint };
function hasAuthoritativeFileIdentity(metadata: FileIdentity): boolean {
  return (
    (typeof metadata.dev === "bigint"
      ? metadata.dev > 0n
      : typeof metadata.dev === "number" &&
        Number.isSafeInteger(metadata.dev) &&
        metadata.dev > 0) &&
    (typeof metadata.ino === "bigint"
      ? metadata.ino > 0n
      : typeof metadata.ino === "number" && Number.isSafeInteger(metadata.ino) && metadata.ino > 0)
  );
}

export function sameAuthoritativeFileIdentity(first: FileIdentity, second: FileIdentity): boolean {
  return (
    hasAuthoritativeFileIdentity(first) &&
    hasAuthoritativeFileIdentity(second) &&
    first.dev === second.dev &&
    first.ino === second.ino
  );
}

export function workspaceCatalogVersions(bytes: Buffer): Map<string, string> {
  const versions = new Map<string, string>();
  let inCatalog = false;
  for (const line of bytes.toString("utf8").split(/\r?\n/u)) {
    if (/^catalog:\s*$/u.test(line)) {
      inCatalog = true;
      continue;
    }
    if (inCatalog && /^\S/u.test(line)) {
      break;
    }
    if (!inCatalog) {
      continue;
    }
    const match = /^  (["']?)([^"':]+|@[^"']+)\1:\s*([0-9][0-9A-Za-z.-]*)\s*$/u.exec(line);
    if (match !== null) {
      const name = match.at(2);
      const version = match.at(3);
      if (name === undefined || version === undefined) {
        throw new Error("Workspace catalog entry has no captured package name or version.");
      }
      versions.set(name, version);
    }
  }
  return versions;
}

export function releaseManifestIdentity(manifest: Record<string, unknown>): string {
  const identity: Record<string, unknown> = {};
  for (const key of ["name", "version", "type", "bin", "exports", "files", "scripts"]) {
    if (Object.hasOwn(manifest, key)) {
      identity[key] = manifest[key];
    }
  }
  return JSON.stringify(identity);
}

export function expectedArchiveName({ name, version }: { name: string; version: string }): string {
  return `${name.replace(/^@/u, "").replace("/", "-")}-${version}.tgz`;
}

export function parsedArchiveListings(inspection: {
  entries: readonly { name: string; type: string }[];
}) {
  const listing = inspection.entries
    .filter(({ type }) => type !== "x" && type !== "g")
    .map(({ name, type }) => (type === "5" && !name.endsWith("/") ? `${name}/` : name))
    .join("\n");
  const verboseListing = inspection.entries
    .filter(({ type }) => type !== "x" && type !== "g")
    .map(({ name, type }) => `${type === "5" ? "d" : type === "0" ? "-" : type}--------- ${name}`)
    .join("\n");
  return { listing, verboseListing };
}
