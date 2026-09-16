import assert from "node:assert/strict";
import test from "node:test";

import {
  assertArchiveSafety,
  inspectCompressedTarArchive,
} from "../scripts/pack-artifact-archive.mjs";
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
  const atFoundationLimit = archiveWithEntries(2_520);
  assert.throws(() => inspectCompressedTarArchive(atFoundationLimit), /too many entries/u);
  assert.equal(
    inspectCompressedTarArchive(atFoundationLimit, FOUNDATION_PACKAGE).entryCount,
    2_520,
  );
  assert.throws(
    () => inspectCompressedTarArchive(archiveWithEntries(2_521), FOUNDATION_PACKAGE),
    /too many entries: 2521/u,
  );
});

test("applies the same Foundation budget to archive listings", () => {
  const listing = [
    "package/package.json",
    "package/LICENSE",
    "package/README.md",
    ...Array.from({ length: 2_511 }, (_, index) => `package/dist/${index}.js`),
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
      { length: 7 },
      (_, index) => `package/dist/extra-${index}.js`,
    )].join("\n"),
  }), /too many entries: 2521/u);
});
