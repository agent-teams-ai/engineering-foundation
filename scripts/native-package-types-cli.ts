import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readRegularArchive } from "./pack-artifact-archive.mjs";
import { runNpmCommand } from "./pack-test-support.mjs";
import { qualifyNativePackageArchive, type NativePackageTypeQualification } from "./native-package-types.ts";

export async function qualifyPackedNativePackage(packageRoot: string): Promise<NativePackageTypeQualification> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "native-package-type-qualification-"));
  try {
    const manifest: unknown = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    if (manifest === null || typeof manifest !== "object" || !("name" in manifest) || typeof manifest.name !== "string" ||
      !("version" in manifest) || typeof manifest.version !== "string") {
      throw new Error("Native package type qualification requires an identified package manifest.");
    }
    const output: unknown = await runNpmCommand(["pack", "--ignore-scripts", "--json", "--pack-destination", temporaryRoot], packageRoot);
    if (output === null || typeof output !== "object" || !("stdout" in output) || typeof output.stdout !== "string") {
      throw new Error("Native package type qualification did not receive npm pack output.");
    }
    const packed: unknown = JSON.parse(output.stdout);
    const entry: unknown = Array.isArray(packed) && packed.length === 1 ? packed[0] : undefined;
    if (entry === null || typeof entry !== "object" || !("filename" in entry) || typeof entry.filename !== "string" ||
      !/^[A-Za-z0-9._-]+\.tgz$/u.test(entry.filename)) {
      throw new Error("Native package type qualification received an invalid packed archive identity.");
    }
    const result = await qualifyNativePackageArchive(await readRegularArchive(join(temporaryRoot, entry.filename)), manifest.name);
    if (result.packageVersion !== manifest.version) { throw new Error("Packed native package version differs from its staged manifest."); }
    return result;
  } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--pack" || args[1] === undefined) {
    throw new Error("Usage: native-package-types-cli.ts --pack <staged-package-root>");
  }
  const result = await qualifyPackedNativePackage(resolve(args[1]));
  console.log(`Native package type qualification passed: ${JSON.stringify(result)}`);
}
