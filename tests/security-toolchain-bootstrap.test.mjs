import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AQUA_VERSION,
  AquaChecksumMismatchError,
  AquaExecutableChecksumMismatchError,
  UnsupportedAquaPlatformError
} from "../scripts/security-toolchain-artifact.mjs";
import { ensurePinnedAqua } from "../scripts/security-toolchain.mjs";

const FIXTURE_AQUA = Buffer.from("fixture aqua " + AQUA_VERSION + "\n");

function fixtureArtifact(contents = FIXTURE_AQUA, executableContents = contents) {
  return {
    executableSha256: createHash("sha256").update(executableContents).digest("hex"),
    fileName: "fixture-aqua.tar.gz",
    sha256: createHash("sha256").update(contents).digest("hex"),
    url: "https://fixtures.invalid/aqua"
  };
}

async function fixtureExtract(archive, destination) {
  await writeFile(destination, archive, { mode: 0o700 });
}

async function fixtureValidate(executable) {
  return (await readFile(executable)).equals(FIXTURE_AQUA);
}

async function withCache(callback) {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "foundation-security-toolchain-"));
  try {
    return await callback(cacheDirectory);
  } finally {
    await rm(cacheDirectory, { force: true, recursive: true });
  }
}

function bootstrapOptions(cacheDirectory, overrides = {}) {
  return {
    architecture: "x64",
    artifact: fixtureArtifact(),
    cacheDirectory,
    extract: fixtureExtract,
    lock: {
      retryMs: 5,
      staleAfterMs: 1_000,
      timeoutMs: 2_000
    },
    platform: "linux",
    validateAqua: fixtureValidate,
    ...overrides
  };
}

test("fails closed before extraction when the pinned Aqua checksum differs", async () => {
  await withCache(async (cacheDirectory) => {
    let extractionAttempted = false;
    await assert.rejects(
      ensurePinnedAqua(
        bootstrapOptions(cacheDirectory, {
          download: async () => Buffer.from("unexpected Aqua archive"),
          extract: async () => {
            extractionAttempted = true;
          }
        })
      ),
      (error) =>
        error instanceof AquaChecksumMismatchError &&
        error.code === "SECURITY_TOOLCHAIN_CHECKSUM_MISMATCH"
    );
    assert.equal(extractionAttempted, false);
    assert.deepEqual(
      (await readdir(cacheDirectory)).filter((entry) => entry.startsWith(".aqua-stage-")),
      []
    );
  });
});

test("fails closed before executing a downloaded binary with the wrong executable digest", async () => {
  await withCache(async (cacheDirectory) => {
    let validationAttempted = false;
    await assert.rejects(
      ensurePinnedAqua(
        bootstrapOptions(cacheDirectory, {
          artifact: fixtureArtifact(
            FIXTURE_AQUA,
            Buffer.from("different expected executable")
          ),
          download: async () => FIXTURE_AQUA,
          validateAqua: async () => {
            validationAttempted = true;
            return true;
          }
        })
      ),
      (error) =>
        error instanceof AquaExecutableChecksumMismatchError &&
        error.code === "SECURITY_TOOLCHAIN_EXECUTABLE_CHECKSUM_MISMATCH"
    );
    assert.equal(validationAttempted, false);
  });
});

test("reports an explicit precondition for unsupported platforms", async () => {
  let downloadAttempted = false;
  await assert.rejects(
    ensurePinnedAqua({
      architecture: "x64",
      download: async () => {
        downloadAttempted = true;
        return FIXTURE_AQUA;
      },
      platform: "win32"
    }),
    (error) =>
      error instanceof UnsupportedAquaPlatformError &&
      error.code === "SECURITY_TOOLCHAIN_UNSUPPORTED_PLATFORM" &&
      error.message.includes("Windows CI")
  );
  assert.equal(downloadAttempted, false);
});

test("does not trust an ambient Aqua command or a tampered cache binary", async () => {
  await withCache(async (cacheDirectory) => {
    let downloadCount = 0;
    const options = bootstrapOptions(cacheDirectory, {
      download: async () => {
        downloadCount += 1;
        return FIXTURE_AQUA;
      }
    });
    const first = await ensurePinnedAqua(options);
    assert.notEqual(first.executable, "aqua");
    assert.equal(downloadCount, 1);

    await writeFile(first.executable, "tampered cache binary", "utf8");
    const second = await ensurePinnedAqua(options);

    assert.equal(downloadCount, 2);
    assert.equal(second.executable, first.executable);
    assert.deepEqual(await readFile(second.executable), FIXTURE_AQUA);
  });
});

test("concurrent bootstrap downloads and installs the pinned archive once", async () => {
  await withCache(async (cacheDirectory) => {
    let downloadCount = 0;
    let releaseDownload;
    const downloadReleased = new Promise((resolve) => {
      releaseDownload = resolve;
    });
    let notifyDownloadStarted;
    const downloadStarted = new Promise((resolve) => {
      notifyDownloadStarted = resolve;
    });
    const download = async () => {
      downloadCount += 1;
      notifyDownloadStarted();
      await downloadReleased;
      return FIXTURE_AQUA;
    };
    const options = bootstrapOptions(cacheDirectory, { download });
    const first = ensurePinnedAqua(options);
    await downloadStarted;
    const second = ensurePinnedAqua(options);
    releaseDownload();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(downloadCount, 1);
    assert.equal(firstResult.executable, secondResult.executable);
    assert.deepEqual(await readFile(firstResult.executable), FIXTURE_AQUA);
    assert.deepEqual(await readdir(join(cacheDirectory, "locks")), []);
  });
});
