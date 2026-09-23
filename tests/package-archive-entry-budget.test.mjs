import assert from "node:assert/strict";
import test from "node:test";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  assertArchiveSafety,
  inspectCompressedTarArchive,
} from "../scripts/pack-artifact-archive.mjs";
import { preparePackages } from "../scripts/prepare-package.mjs";
import { tarArchive } from "./pack-publishable-artifacts-support.mjs";

const FOUNDATION_PACKAGE = "@agent-teams/engineering-foundation";

function archiveWithEntries(count) {
  return tarArchive(Array.from(
    { length: count },
    (_, index) => ({ name: `package/dist/${index}.js` }),
  ));
}

test("keeps the Foundation archive exception package-specific and bounded", () => {
  assert.throws(
    () => inspectCompressedTarArchive(archiveWithEntries(2_501)),
    /too many entries: 2501/u,
  );
  const atFoundationLimit = archiveWithEntries(2_559);
  assert.throws(() => inspectCompressedTarArchive(atFoundationLimit), /too many entries/u);
  assert.equal(
    inspectCompressedTarArchive(atFoundationLimit, FOUNDATION_PACKAGE).entryCount,
    2_559,
  );
  assert.throws(
    () => inspectCompressedTarArchive(archiveWithEntries(2_560), FOUNDATION_PACKAGE),
    /too many entries: 2560/u,
  );
});

test("applies the same Foundation budget to archive listings", () => {
  const listing = [
    "package/package.json",
    "package/LICENSE",
    "package/README.md",
    ...Array.from({ length: 2_556 }, (_, index) => `package/dist/${index}.js`),
  ];
  const input = {
    archiveBytes: Buffer.from("fixture"),
    packageName: FOUNDATION_PACKAGE,
    requiredArtifactPaths: ["dist/0.js"],
    verboseListing: "",
  };
  assert.doesNotThrow(() => assertArchiveSafety({ ...input, listing: listing.join("\n") }));
  assert.throws(() => assertArchiveSafety({
    ...input,
    listing: [...listing, ...Array.from(
      { length: 1 },
      (_, index) => `package/dist/extra-${index}.js`,
    )].join("\n"),
  }), /too many entries: 2560/u);
});

test("admits the complete built Foundation package inventory and rejects one additional member", async () => {
  await preparePackages();
  const root = "packages/engineering-foundation";
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const paths = new Set(["package.json", "LICENSE", "README.md"]);
  async function visit(path) {
    const metadata = await lstat(join(root, path));
    assert.equal(metadata.isSymbolicLink(), false, path);
    if (metadata.isDirectory()) {
      for (const entry of await readdir(join(root, path))) { await visit(`${path}/${entry}`); }
    } else {
      assert.ok(metadata.isFile(), path);
      paths.add(path);
    }
  }
  for (const path of manifest.files) { await visit(path); }
  assert.equal(paths.size, 2_559, "Requalify the complete package inventory when its membership changes");
  const listing = [...paths].toSorted().map(path => `package/${path}`);
  const input = { archiveBytes: Buffer.from("inventory"), packageName: FOUNDATION_PACKAGE,
    requiredArtifactPaths: [...paths], allowedArtifactPaths: manifest.files, verboseListing: "" };
  assert.doesNotThrow(() => assertArchiveSafety({ ...input, listing: listing.join("\n") }));
  assert.throws(() => assertArchiveSafety({ ...input,
    listing: [...listing, "package/dist/over-limit.js"].join("\n") }), /too many entries: 2560/u);
});
