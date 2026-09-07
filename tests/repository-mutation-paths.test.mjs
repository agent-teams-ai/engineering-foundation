import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertNoPortableNameCollision,
  assertSafeExistingRepositoryAncestors,
  ExistingRepositoryAncestorError
} from "../packages/repository-mutation/dist/repository-mutation/adapters/node/node-existing-repository-ancestors.js";
import {
  StrictDirectoryDurabilityError,
  syncDirectoryDurably,
  syncDirectoryStrictlyWith,
} from "../packages/repository-mutation/dist/repository-mutation/adapters/node/node-directory-durability.js";
import { isLexicallyContainedPath } from "../packages/repository-mutation/dist/repository-mutation/adapters/node/node-repository-path.js";
import {
  findPortableRepositoryPathCollision,
  portableRepositoryPathIdentity,
  portableRepositoryPathProblem
} from "../packages/repository-mutation/dist/repository-mutation/application/model/repository-path.js";
import { legacyScaffoldingRepositoryPathProblem } from "../packages/engineering-foundation/dist/scaffolding/application/policies/legacy-scaffolding-repository-path.js";
import { portableRepositoryPathProblem as sdPortableRepositoryPathProblem } from "../packages/engineering-foundation/dist/capabilities/source-dependencies/application/model/repository-path.js";
import { isDocumentRepositoryPath } from "../packages/document-authoring/dist/application/policies/document-repository-path.js";

async function withTemporaryRoot(callback) {
  const root = await mkdtemp(join(tmpdir(), "repository-mutation-paths-"));
  try {
    await callback(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function collisionEntries() {
  return ["a.txt", "A.txt", "A.TXT"];
}

const pathVectors = JSON.parse(readFileSync(
  new URL("./fixtures/repository-path-conformance-v1.json", import.meta.url),
  "utf8"
)).vectors;

function vectorPath(vector) {
  return vector.path ?? vector.segments
    .map(({ count, repeat }) => repeat.repeat(count))
    .join("/");
}

test("implements the shared repository path conformance vectors", () => {
  for (const vector of pathVectors) {
    assert.equal(
      portableRepositoryPathProblem(vectorPath(vector)),
      vector.mutationProblem ?? undefined,
      vector.name
    );
  }
});

test("validates portable repository paths independently of the host", () => {
  assert.equal(portableRepositoryPathProblem("docs/guide.md"), undefined);
  assert.equal(portableRepositoryPathProblem("C:/escape.md"), "absolute");
  assert.equal(portableRepositoryPathProblem("\\\\host\\share"), "absolute");
  assert.equal(portableRepositoryPathProblem("docs\\guide.md"), "backslash");
  assert.equal(portableRepositoryPathProblem("docs/../guide.md"), "invalid-segment");
  assert.equal(portableRepositoryPathProblem("docs/CON.md"), "reserved-name");
  assert.equal(portableRepositoryPathProblem("docs/bad\u0001.md"), "control-character");
  assert.equal(portableRepositoryPathProblem("docs/bad\u007f.md"), "control-character");
  assert.equal(portableRepositoryPathProblem("docs/café.md"), "invalid-character");
  assert.equal(portableRepositoryPathProblem("docs/trailing "), "trailing-space");
  assert.equal(portableRepositoryPathProblem("docs/stream:secret"), "invalid-character");
  for (const character of ['*', '?', '"', '<', '>', '|']) {
    assert.equal(
      portableRepositoryPathProblem(`docs/bad${character}.md`),
      "invalid-character"
    );
  }
  assert.equal(
    portableRepositoryPathProblem(`docs/${"a".repeat(256)}`),
    "segment-too-long"
  );
  assert.equal(
    portableRepositoryPathProblem(
      `${"a".repeat(255)}/${"b".repeat(255)}/c`
    ),
    "path-too-long"
  );
  assert.equal(
    portableRepositoryPathProblem(`docs/${"é".repeat(128)}`),
    "segment-too-long"
  );
  assert.equal(
    portableRepositoryPathProblem(
      `${"é".repeat(127)}/${"é".repeat(127)}/aaa`
    ),
    "path-too-long"
  );
});

test("keeps the published scaffolding path contract frozen", () => {
  for (const repositoryPath of [
    "packages/generated/café.ts",
    "packages/generated/trailing ",
    "packages/generated/stream:secret",
    "packages/generated/bad?.ts",
    "packages/generated/bad\u007f.ts"
  ]) {
    assert.equal(legacyScaffoldingRepositoryPathProblem(repositoryPath), undefined);
    assert.notEqual(portableRepositoryPathProblem(repositoryPath), undefined);
  }
});

test("assigns NFC and case folded portable identities", () => {
  const decomposed = "docs/Cafe\u0301.md";
  const composed = "DOCS/CAFÉ.md";
  assert.equal(
    portableRepositoryPathIdentity(decomposed),
    portableRepositoryPathIdentity(composed)
  );
  assert.deepEqual(findPortableRepositoryPathCollision([decomposed, composed]), {
    first: decomposed,
    second: composed
  });
});

test("selects portable name collisions in binary order", async () => {
  await assert.rejects(
    assertNoPortableNameCollision(
      "unused",
      "requested.txt",
      () => "collision",
      "binary",
      collisionEntries
    ),
    (error) => error?.existingName === "A.TXT"
  );
  await assert.rejects(
    assertNoPortableNameCollision(
      "unused",
      "requested.txt",
      () => "collision",
      "filesystem",
      collisionEntries
    ),
    (error) => error?.existingName === "a.txt"
  );
});

test("checks lexical containment without touching the filesystem", () => {
  assert.equal(isLexicallyContainedPath("/repo", "/repo/docs/a.md"), true);
  assert.equal(isLexicallyContainedPath("/repo", "/repo-other/a.md"), false);
});

test("accepts missing existing parents without creating them", async () => {
  await withTemporaryRoot(async (root) => {
    await assertSafeExistingRepositoryAncestors(root, "missing/child/file.md");
    await assert.rejects(
      async () => (await import("node:fs/promises")).stat(join(root, "missing")),
      { code: "ENOENT" }
    );
  });
});

test("rejects symbolic-link and non-directory ancestors", async () => {
  await withTemporaryRoot(async (root) => {
    const outside = await mkdtemp(join(tmpdir(), "repository-mutation-outside-"));
    try {
      await symlink(outside, join(root, "linked"));
      await assert.rejects(
        assertSafeExistingRepositoryAncestors(root, "linked/file.md"),
        (error) =>
          error instanceof ExistingRepositoryAncestorError &&
          error.problem === "not-directory"
      );
      await writeFile(join(root, "plain"), "not a directory\n");
      await assert.rejects(
        assertSafeExistingRepositoryAncestors(root, "plain/file.md"),
        (error) =>
          error instanceof ExistingRepositoryAncestorError &&
          error.problem === "not-directory"
      );
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

test("reports directory durability capability honestly", async () => {
  let closed = false;
  assert.equal(
    await syncDirectoryDurably("unused", {
      platform: "linux",
      open: async () => ({
        close: async () => {
          closed = true;
        },
        sync: async () => {}
      })
    }),
    "durable"
  );
  assert.equal(closed, true);

  const unsupported = Object.assign(new Error("unsupported"), { code: "EINVAL" });
  assert.equal(
    await syncDirectoryDurably("unused", {
      platform: "win32",
      open: async () => {
        throw unsupported;
      }
    }),
    "unsupported"
  );
  await assert.rejects(
    syncDirectoryDurably("unused", {
      platform: "linux",
      open: async () => {
        throw unsupported;
      }
    }),
    unsupported
  );
});

test("strict directory durability rejects an unsupported Windows result", async () => {
  await assert.rejects(
    syncDirectoryStrictlyWith("journal-directory", async () => "unsupported"),
    (error) =>
      error instanceof StrictDirectoryDurabilityError &&
      error.message.includes("journal-directory"),
  );
});

// Exhaustive cross-check: all four Windows-reserved-name check implementations must
// agree on every fixture case. Implementations compared:
//   Impl 1 – portableRepositoryPathProblem          (repository-mutation)
//   Impl 2 – legacyScaffoldingRepositoryPathProblem (engineering-foundation, frozen v1)
//   Impl 3 – sdPortableRepositoryPathProblem        (engineering-foundation/source-dependencies)
//   Impl 4 – isDocumentRepositoryPath               (document-authoring)
const windowsReservedCrossCheckFixtures = [
  // --- segments that ARE Windows reserved names ---
  { segment: "CON",          reserved: true },
  { segment: "PRN",          reserved: true },
  { segment: "AUX",          reserved: true },
  { segment: "NUL",          reserved: true },
  { segment: "COM1",         reserved: true },
  { segment: "COM5",         reserved: true },
  { segment: "COM9",         reserved: true },
  { segment: "LPT1",         reserved: true },
  { segment: "LPT5",         reserved: true },
  { segment: "LPT9",         reserved: true },
  { segment: "con",          reserved: true },   // lowercase
  { segment: "Con",          reserved: true },   // mixed case
  { segment: "CON.txt",      reserved: true },   // with extension
  { segment: "lpt9.md",      reserved: true },   // from shared fixture
  { segment: "NUL.log",      reserved: true },
  { segment: "COM1.ts",      reserved: true },
  { segment: "prn.backup",   reserved: true },
  { segment: "AUX.extra.bak", reserved: true },  // multiple dots
  // --- segments that are NOT Windows reserved names ---
  { segment: "console",      reserved: false },
  { segment: "console.md",   reserved: false },  // from shared fixture
  { segment: "CONMAN",       reserved: false },  // reserved prefix, different name
  { segment: "prnt",         reserved: false },
  { segment: "auxiliary",    reserved: false },
  { segment: "nullify",      reserved: false },
  { segment: "common",       reserved: false },
  { segment: "COM0",         reserved: false },  // COM0 is not reserved
  { segment: "LPT0",         reserved: false },  // LPT0 is not reserved
  { segment: "COM10",        reserved: false },  // COM10 is not reserved
  { segment: "COM1A",        reserved: false },  // COM1 prefix but extra char
];

test("all four Windows-reserved-name implementations classify identically", () => {
  for (const { segment, reserved } of windowsReservedCrossCheckFixtures) {
    const path = `docs/${segment}`;

    // Impl 1: portableRepositoryPathProblem (repository-mutation)
    assert.equal(
      portableRepositoryPathProblem(path) === "reserved-name",
      reserved,
      `Impl1 (repository-mutation): ${segment}`
    );

    // Impl 2: legacyScaffoldingRepositoryPathProblem (engineering-foundation)
    assert.equal(
      legacyScaffoldingRepositoryPathProblem(path) === "reserved-name",
      reserved,
      `Impl2 (legacy-scaffolding): ${segment}`
    );

    // Impl 3: portableRepositoryPathProblem (source-dependencies) — returns
    // a generic message string; any non-undefined return means "rejected".
    // For these fixtures the reserved name is the only reason to reject.
    assert.equal(
      sdPortableRepositoryPathProblem(path) !== undefined,
      reserved,
      `Impl3 (source-dependencies): ${segment}`
    );

    // Impl 4: isDocumentRepositoryPath (document-authoring) — returns boolean.
    assert.equal(
      !isDocumentRepositoryPath(path),
      reserved,
      `Impl4 (document-authoring): ${segment}`
    );
  }
});
