import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { qualifiedArchive } from "../pack-publishable-artifacts-support.mjs";
import { PUBLISHABLE_PACKAGE_DEPENDENCIES } from "../../scripts/publishable-packages.mjs";

export function makeProbeArchive(
  info: { readonly name: string; readonly version: string },
  destination: string,
  versions: ReadonlyMap<string, string>,
  archiveByName: Map<string, unknown>,
) {
  mkdirSync(destination, { recursive: true });
  const manifest = {
    name: info.name,
    version: info.version,
    dependencies: Object.fromEntries(
      (PUBLISHABLE_PACKAGE_DEPENDENCIES as Readonly<Record<string, readonly string[]>>)[
        info.name
      ]!.map((name) => [name, versions.get(name)]),
    ),
  };
  const bytes = qualifiedArchive(manifest);
  const archivePath = join(
    destination,
    `${info.name.replace(/^@/u, "").replace("/", "-")}-${info.version}.tgz`,
  );
  writeFileSync(archivePath, bytes, { mode: 0o444 });
  const archive = {
    archivePath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    packageName: info.name,
    packageVersion: info.version,
    manifest,
    bytes,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
  archiveByName.set(info.name, archive);
  return archive;
}
