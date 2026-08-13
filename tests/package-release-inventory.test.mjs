import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FOUNDATION_PACKAGE_FILE_ALLOWLIST,
  FOUNDATION_REQUIRED_ARTIFACT_PATHS,
  inspectFoundationPackage,
} from "../packages/engineering-foundation/dist/package-self-check.js";
import { FOUNDATION_SCHEMA_IDS } from "../packages/engineering-foundation/dist/schema-ids.js";
import { assertArchiveListing } from "../scripts/pack-artifact-e2e.mjs";

const repositoryPackageRoot = new URL(
  "../packages/engineering-foundation/",
  import.meta.url,
);

test("release manifest exactly follows the package self-check allowlist", async () => {
  const manifest = JSON.parse(await readFile(
    new URL("package.json", repositoryPackageRoot),
    "utf8",
  ));
  assert.deepEqual(manifest.files, FOUNDATION_PACKAGE_FILE_ALLOWLIST);
  for (const schemaId of FOUNDATION_SCHEMA_IDS) {
    assert.ok(manifest.files.includes(`schemas/${schemaId}.schema.json`));
  }
  assert.ok(manifest.exports["./document-authoring"]);
});

test("tarball inventory rejects any source or unallowlisted release file", () => {
  const required = FOUNDATION_REQUIRED_ARTIFACT_PATHS.map(
    (path) => `package/${path}`,
  );
  const base = [
    "package/",
    "package/package.json",
    "package/LICENSE",
    "package/README.md",
    ...required,
  ].join("\n");
  assertArchiveListing(base, FOUNDATION_REQUIRED_ARTIFACT_PATHS);
  assert.throws(
    () => assertArchiveListing(`${base}\npackage/private-token.txt\n`, FOUNDATION_REQUIRED_ARTIFACT_PATHS),
    /outside the release allowlist/u,
  );
  assert.throws(
    () => assertArchiveListing(`${base}\npackage/src/private.ts\n`, FOUNDATION_REQUIRED_ARTIFACT_PATHS),
    /Forbidden package entry/u,
  );
});

test("package self-check rejects a symlinked required artifact", async () => {
  if (process.platform === "win32") {
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "foundation-package-inventory-"));
  try {
    const packageRoot = join(root, "package");
    await cp(repositoryPackageRoot, packageRoot, {
      filter(source) {
        return !source.includes("node_modules") && !source.includes("tsconfig.tsbuildinfo");
      },
      recursive: true,
    });
    const target = join(packageRoot, "presets", "oxlint", "base.json");
    const source = `${target}.original`;
    await cp(target, source);
    await rm(target);
    await symlink(source, target, "file");
    await assert.rejects(
      inspectFoundationPackage(packageRoot),
      (error) =>
        error?.code === "PACKAGE_INVALID" &&
        /presets\/oxlint\/base\.json/u.test(error.message),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("package self-check rejects manifest expansion beyond the allowlist", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-package-manifest-"));
  try {
    const packageRoot = join(root, "package");
    await cp(repositoryPackageRoot, packageRoot, {
      filter(source) {
        return !source.includes("node_modules") && !source.includes("tsconfig.tsbuildinfo");
      },
      recursive: true,
    });
    const manifestPath = join(packageRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files.push("src");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      inspectFoundationPackage(packageRoot),
      (error) =>
        error?.code === "PACKAGE_INVALID" &&
        /exact release allowlist/u.test(error.message),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
