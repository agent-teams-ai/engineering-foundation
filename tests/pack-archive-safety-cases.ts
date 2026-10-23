import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  assertArchiveSafety,
  assertNoSpecialTarEntries,
  inspectCompressedTarArchive,
  packAndInspectArtifact,
  sameAuthoritativeFileIdentity,
} from "../scripts/pack-artifact-e2e.mjs";
import {
  compressedTar,
  createPackFixture,
  qualifiedArchive,
  tarArchive,
  tarHeader,
} from "./pack-publishable-artifacts-support.mjs";

export function registerArchiveSafetyTests(): void {
  void test("archive safety retains allowlist, bounds, and special-entry rejection", () => {
    const listing = [
      "package/",
      "package/package.json",
      "package/LICENSE",
      "package/README.md",
      "package/dist/",
      "package/dist/index.js",
    ].join("\n");
    assert.doesNotThrow(() => {
      assertArchiveSafety({
        allowedArtifactPaths: undefined,
        packageName: undefined,
        archiveBytes: Buffer.from("fixture"),
        listing,
        requiredArtifactPaths: ["dist/index.js"],
        verboseListing: "drwxr-xr-x package/\n-rw-r--r-- package/dist/index.js\n",
      });
    });
    assert.throws(() => {
      assertArchiveSafety({
        allowedArtifactPaths: undefined,
        packageName: undefined,
        archiveBytes: Buffer.from("fixture"),
        listing: `${listing}\npackage/src/secret.js`,
        requiredArtifactPaths: ["dist/index.js"],
        verboseListing: "-rw-r--r-- package/src/secret.js\n",
      });
    }, /Forbidden package entry|outside the release allowlist/u);
    assert.throws(() => {
      assertArchiveSafety({
        allowedArtifactPaths: undefined,
        packageName: undefined,
        archiveBytes: Buffer.from("fixture"),
        listing: listing.replace("package/dist/index.js", ""),
        requiredArtifactPaths: ["dist/index.js"],
        verboseListing: "drwxr-xr-x package/dist/\n",
      });
    }, /Required package entry missing/u);
    assert.throws(() => {
      assertArchiveSafety({
        allowedArtifactPaths: undefined,
        packageName: undefined,
        archiveBytes: Buffer.alloc(8 * 1024 * 1024 + 1),
        listing,
        requiredArtifactPaths: ["dist/index.js"],
        verboseListing: "-rw-r--r-- package/dist/index.js\n",
      });
    }, /archive exceeds/u);
    assert.throws(() => {
      assertNoSpecialTarEntries("lrwxrwxrwx package/link -> target\n");
    }, /prohibited special tar entry/u);
    assert.throws(() => {
      assertArchiveSafety({
        allowedArtifactPaths: undefined,
        packageName: undefined,
        archiveBytes: Buffer.from("fixture"),
        listing: Array.from({ length: 2_501 }, (_, index) => `package/dist/${index}.js`).join("\n"),
        requiredArtifactPaths: ["dist/index.js"],
        verboseListing: "",
      });
    }, /too many entries/u);
    assert.throws(() => {
      assertArchiveSafety({
        allowedArtifactPaths: undefined,
        packageName: undefined,
        archiveBytes: Buffer.from("fixture"),
        listing: `${listing}\npackage/dist/../dist/index.js`,
        requiredArtifactPaths: ["dist/index.js"],
        verboseListing: "-rw-r--r-- package/dist/index.js\n",
      });
    }, /unsafe archive member|duplicate or normalized-colliding/u);
    assert.throws(() => {
      assertArchiveSafety({
        allowedArtifactPaths: undefined,
        packageName: undefined,
        archiveBytes: Buffer.from("fixture"),
        listing: `${listing}\npackage/dist/index.js`,
        requiredArtifactPaths: ["dist/index.js"],
        verboseListing: "-rw-r--r-- package/dist/index.js\n",
      });
    }, /duplicate or normalized-colliding/u);
    for (const hostile of [
      "package/dist/INDEX.js",
      "package/dist/index.js. ",
      "package/dist/\u0065\u0301.js",
      "package/dist/CON.txt",
      "package/dist/COM¹.txt",
      "package/dist/AUX",
      "package/dist/CON .txt",
      "package/dist/name:stream.js",
      "package/dist/bad?.js",
    ]) {
      const baseline = hostile.includes("\u0301") ? `${listing}\npackage/dist/\u00e9.js` : listing;
      assert.throws(() => {
        assertArchiveSafety({
          allowedArtifactPaths: undefined,
          packageName: undefined,
          archiveBytes: Buffer.from("fixture"),
          listing: `${baseline}\n${hostile}`,
          requiredArtifactPaths: ["dist/index.js"],
          verboseListing: "-rw-r--r-- package/dist/index.js\n",
        });
      }, /colliding|non-portable|unsafe/u);
    }
    assert.throws(() => {
      assertArchiveSafety({
        allowedArtifactPaths: undefined,
        packageName: undefined,
        archiveBytes: Buffer.from("fixture"),
        listing: `${listing}\npackage/dist/Σ.js\npackage/dist/ς.js`,
        requiredArtifactPaths: ["dist/index.js"],
        verboseListing: "-rw-r--r-- package/dist/index.js\n",
      });
    }, /colliding/u);
    assert.throws(() => {
      assertArchiveSafety({
        allowedArtifactPaths: undefined,
        packageName: undefined,
        archiveBytes: Buffer.from("fixture"),
        listing: `${listing}\npackage/dist/file.js\npackage/dist/fıle.js`,
        requiredArtifactPaths: ["dist/index.js"],
        verboseListing: "-rw-r--r-- package/dist/index.js\n",
      });
    }, /colliding/u);
  });

  registerAdditionalArchiveSafetyTests();
}
function registerAdditionalArchiveSafetyTests(): void {
  void test("compressed tar inspection bounds members before extraction", () => {
    assert.deepEqual(
      inspectCompressedTarArchive(compressedTar("package/small", 5, Buffer.from("small"))),
      {
        aggregateBytes: 5,
        entryCount: 1,
        uncompressedBytes: 2_048,
      },
    );
    assert.throws(
      () => inspectCompressedTarArchive(compressedTar("package/oversized", 16 * 1024 * 1024 + 1)),
      /member exceeds/u,
    );
    const compressedBomb = gzipSync(Buffer.alloc(70 * 1024 * 1024));
    assert.throws(() => inspectCompressedTarArchive(compressedBomb), /safety bound/u);
    assert.throws(
      () => inspectCompressedTarArchive(tarArchive([{ name: "package/sparse", type: "S" }])),
      /GNU sparse/u,
    );
    assert.throws(
      () =>
        inspectCompressedTarArchive(
          tarArchive([
            {
              data: Buffer.from("20 GNU.sparse.size=999999999\n"),
              name: "PaxHeader/package",
              type: "x",
            },
          ]),
        ),
      /PAX sparse/u,
    );
    const oneZeroBlock = Buffer.concat([tarHeader("package/file", 0), Buffer.alloc(512)]);
    assert.throws(
      () => inspectCompressedTarArchive(gzipSync(oneZeroBlock)),
      /two-zero-block terminator/u,
    );
    const hiddenAfterTerminator = Buffer.concat([
      tarHeader("package/file", 0),
      Buffer.alloc(1024),
      tarHeader("package/hidden", 0),
      Buffer.alloc(1024),
    ]);
    assert.throws(
      () => inspectCompressedTarArchive(gzipSync(hiddenAfterTerminator)),
      /hidden trailing data/u,
    );
  });

  void test("attacker-controlled packed manifest cannot forge qualification identity", async (t) => {
    const fixture = await createPackFixture(t, "pack-forged-manifest-");
    const bytes = qualifiedArchive({ name: "@fixture/attacker", version: "1.2.3" });
    await assert.rejects(
      packAndInspectArtifact({
        ...fixture,
        buildPackageNames: ["@fixture/qualified"],
        dependencyDeclarations: { "@fixture/qualified": [] },
        expectedManifest: { name: "@fixture/qualified", version: "1.2.3" },
        packageName: "@fixture/qualified",
        requiredArtifactPaths: ["dist/index.js"],
        runBuild: async () => {},
        runPnpm: async (args: readonly string[]) => {
          const destination = args.at(args.indexOf("--pack-destination") + 1);
          assert.ok(typeof destination === "string" && destination.length > 0);
          await mkdir(destination, { recursive: true });
          await writeFile(join(destination, "fixture-qualified-1.2.3.tgz"), bytes);
        },
        stagePackages: [
          {
            name: "@fixture/qualified",
            root: "packages/qualified",
            sourceRoot: fixture.packageRoot,
            version: "1.2.3",
          },
        ],
      }),
      /manifest identity does not match/u,
    );
  });

  void test("archive identity comparison ignores unavailable filesystem identity", () => {
    assert.deepEqual(
      [
        sameAuthoritativeFileIdentity({ dev: 0, ino: 0 }, { dev: 0, ino: 0 }),
        sameAuthoritativeFileIdentity({ dev: 0, ino: 11 }, { dev: 0, ino: 11 }),
        sameAuthoritativeFileIdentity({ dev: 7, ino: 0 }, { dev: 7, ino: 0 }),
        sameAuthoritativeFileIdentity({}, {}),
        sameAuthoritativeFileIdentity({ dev: 7, ino: 11 }, { dev: 7, ino: 11 }),
        sameAuthoritativeFileIdentity({ dev: 7n, ino: 11n }, { dev: 7n, ino: 12n }),
      ],
      [false, false, false, false, true, false],
    );
  });
}
