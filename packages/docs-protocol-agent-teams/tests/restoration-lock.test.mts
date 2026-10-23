import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isMap, isScalar, parseDocument } from "yaml";
import {
  checkManagedRestorationLockV1,
  type ManagedRestorationLockV1Request,
  type ManagedRestorationLockV1Result,
} from "../dist/qualification/index.js";
import {
  record,
  digest,
  canonical,
  retained,
  editActual,
  withSource,
  accepted,
  contextOracle,
  core,
  mutations,
} from "./restoration-lock-fixture.ts";
test("retained external A proves whole managed-restoration lock conformance", async () => {
  const request = await retained(),
    result = accepted(checkManagedRestorationLockV1(request));
  const oracle: unknown = parseDocument(
    Buffer.from(request.actualLockBytes).toString("utf8"),
  ).toJSON();
  assert.equal(
    result.expectedLockDigest,
    "sha256:" +
      createHash("sha256")
        .update("managed-restoration-lock/v1\n")
        .update(canonical(oracle))
        .digest("hex"),
  );
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.provenance.contextLocators, contextOracle);
  assert.deepEqual(result.provenance.borrowedCoordinates, [
    "@types/node@24.13.3",
    "undici-types@7.18.2",
  ]);
  assert.deepEqual(
    result.provenance.removedSourceCoordinates,
    [
      "@agent-teams/docs-protocol-agent-teams@0.2.13",
      "@agent-teams/docs-protocol@0.6.2",
      "@agent-teams/document-authoring@0.3.2",
      "@agent-teams/engineering-foundation@1.7.0",
      "@agent-teams/repository-mutation@0.2.2",
    ].toSorted(),
  );
  assert.deepEqual(
    [
      result.provenance.originalSnapshotCount,
      result.provenance.managedSnapshotCount,
      result.provenance.foreignOnlySnapshotCount,
      result.provenance.wholeSnapshotCount,
    ],
    [83, 85, 42, 127],
  );
  assert.equal(result.provenance.originalPackageManager, "pnpm@11.20.0");
  assert.equal(result.provenance.originalClosureSha256, request.selection.originalClosureSha256);
  assert.ok(!Object.hasOwn(result, "cohortAdmissible") && !Object.hasOwn(result, "restoreAllowed"));
});

for (const [name, mutate] of mutations) {
  test("whole typed A rejects " + name, async () => {
    const request = await retained(),
      baseline = accepted(checkManagedRestorationLockV1(request));
    const result = checkManagedRestorationLockV1(editActual(request, mutate));
    assert.equal(result.conformance, "nonconformant");
    assert.ok(result.diagnostics.length > 0);
    assert.equal(
      result.expectedLockDigest,
      baseline.expectedLockDigest,
      "A must not select or derive E",
    );
  });
}

test("all mismatch paths are retained and object order is immaterial", async () => {
  const request = await retained();
  accepted(
    checkManagedRestorationLockV1(
      editActual(request, (d) => {
        const packages = d.get("packages", true);
        assert.ok(isMap(packages));
        packages.items.reverse();
      }),
    ),
  );
  const result = checkManagedRestorationLockV1(
    editActual(request, (d) => {
      d.setIn(["settings", "autoInstallPeers"], true);
      d.setIn(["catalogs", "default", "@types/node", "version"], "24.19.1");
      d.setIn(["snapshots", core, "optionalDependencies", "@types/node"], "24.19.1");
    }),
  );
  assert.equal(result.conformance, "nonconformant");
  for (const path of [
    ["settings", "autoInstallPeers"],
    ["catalogs", "default", "@types/node", "version"],
    ["snapshots", core, "optionalDependencies", "@types/node"],
  ]) {
    assert.ok(result.diagnostics.some((row) => JSON.stringify(row.path) === JSON.stringify(path)));
  }
});

test("Source extensions and comments retain type, order and semantic placement", async () => {
  const request = await retained(),
    source = parseDocument(Buffer.from(request.sourceLockBytes).toString("utf8"));
  const actual = parseDocument(Buffer.from(request.actualLockBytes).toString("utf8"));
  for (const document of [source, actual]) {
    document.set("retainedExtension", { nested: [null, {}, [], true, 1, "1"] });
    const settings = document.get("settings", true);
    assert.ok(isMap(settings));
    settings.commentBefore = " placement witness";
  }
  const augmented = {
    ...withSource(request, Buffer.from(source.toString())),
    actualLockBytes: Buffer.from(actual.toString()),
  };
  accepted(checkManagedRestorationLockV1(augmented));
  for (const value of [null, {}, [], false, "1", [null, {}, [], true, "1", 1]]) {
    const result = checkManagedRestorationLockV1(
      editActual(augmented, (d) => d.setIn(["retainedExtension", "nested"], value)),
    );
    assert.equal(result.conformance, "nonconformant");
  }
  for (const moved of [false, true]) {
    const result = checkManagedRestorationLockV1(
      editActual(augmented, (d) => {
        const settings = d.get("settings", true);
        assert.ok(isMap(settings));
        settings.commentBefore = null;
        const catalogs = d.get("catalogs", true);
        assert.ok(isMap(catalogs));
        catalogs.commentBefore = moved ? " placement witness" : " changed witness";
      }),
    );
    assert.ok(result.diagnostics.some((row) => row.code === "preservation"));
  }
  assert.equal(
    checkManagedRestorationLockV1(
      editActual(augmented, (d) => {
        d.delete("retainedExtension");
      }),
    ).conformance,
    "nonconformant",
  );
});

test("public byte boundary rejects invented facts, wrong selections and archive sets", async () => {
  const request = await retained();
  for (const invented of [
    { ...request, SRIverified: true },
    { ...request, admittedFacts: {} },
    { ...request, evaluator: () => true },
  ]) {
    assert.equal(checkManagedRestorationLockV1(invented).conformance, "nonconformant");
  }
  for (const selection of [
    { ...request.selection, originalClosureSha256: "0".repeat(64) },
    { ...request.selection, sourceLockSha256: "0".repeat(64) },
    { ...request.selection, sourceLockBlob: "0".repeat(40) },
  ]) {
    assert.equal(
      checkManagedRestorationLockV1({ ...request, selection }).conformance,
      "nonconformant",
    );
  }
  const entries = Object.entries(request.archiveBytes),
    first = entries[0];
  assert.ok(first);
  for (const archiveBytes of [
    Object.fromEntries(entries.slice(1)),
    { ...request.archiveBytes, "extra@1.0.0": first[1] },
  ]) {
    assert.equal(
      checkManagedRestorationLockV1({ ...request, archiveBytes }).conformance,
      "nonconformant",
    );
  }
  const corrupted = Buffer.from(first[1]);
  corrupted[0] = (corrupted[0] ?? 0) ^ 1;
  assert.equal(
    checkManagedRestorationLockV1({
      ...request,
      archiveBytes: { ...request.archiveBytes, [first[0]]: corrupted },
    }).conformance,
    "nonconformant",
  );
  for (const extra of ["\nsettings: {}\n", "\nx: &a {}\ny: *a\n"]) {
    assert.equal(
      checkManagedRestorationLockV1({
        ...request,
        actualLockBytes: Buffer.concat([Buffer.from(request.actualLockBytes), Buffer.from(extra)]),
      }).conformance,
      "nonconformant",
    );
  }
});

function publicTypes(
  request: ManagedRestorationLockV1Request,
  result: ManagedRestorationLockV1Result,
): void {
  // @ts-expect-error Public requests contain bytes, never caller-verified declarations.
  const facts: ManagedRestorationLockV1Request = { ...request, admittedFacts: {} };
  // @ts-expect-error The public request has no executable evaluator seam.
  const callback: ManagedRestorationLockV1Request = { ...request, evaluator: () => true };
  // @ts-expect-error Conformance results cannot be used as Cohort admission receipts.
  const authority: { readonly cohortAdmissible: true } = result;
  if (result.conformance === "conformant") {
    const lockDigest: `sha256:${string}` = result.expectedLockDigest;
    void lockDigest;
  }
  void facts;
  void callback;
  void authority;
}
void publicTypes;

test("adversarial foreign annotation paths reject before expansion", async (context) => {
  const name = "adversarial foreign annotation paths reject before expansion";
  const completion = "restoration-lock annotation budget probe completed";
  if (process.env.RESTORATION_LOCK_ANNOTATION_PROBE !== "1") {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      RESTORATION_LOCK_ANNOTATION_PROBE: "1",
    };
    delete childEnv.NODE_TEST_CONTEXT;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--max-old-space-size=192",
        "--test",
        "--test-reporter=tap",
        "--test-name-pattern=^" + name + "$",
        fileURLToPath(import.meta.url),
      ],
      {
        env: childEnv,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      },
    ).catch(() => {
      assert.fail("annotation subprocess failed, timed out, or exceeded its output limit");
    });
    assert.ok(typeof stdout === "string");
    const lines = stdout.split(/\r?\n/u);
    assert.equal(
      lines.filter((line) => line === "ok 1 - " + name).length,
      1,
      "the child must report success for the selected test",
    );
    assert.equal(
      lines.filter((line) => /^ok \d+ -/u.test(line)).length,
      1,
      "the child must report exactly one successful test",
    );
    assert.equal(
      lines.filter((line) => /^not ok \d+ -/u.test(line)).length,
      0,
      "the child must report no failed tests",
    );
    for (const footer of [
      "1..1",
      "# tests 1",
      "# suites 0",
      "# pass 1",
      "# fail 0",
      "# cancelled 0",
      "# skipped 0",
      "# todo 0",
    ]) {
      assert.equal(
        lines.filter((line) => line === footer).length,
        1,
        "the child must report exactly one completed test with no failures or skips",
      );
    }
    assert.equal(
      lines.filter((line) => line.trim() === "# " + completion).length,
      1,
      "the child must reach the assertion completion marker",
    );
    return;
  }
  const request = await retained();
  const extension = Buffer.from(
    "\n? " + "x".repeat(256 * 1024) + "\n: [" + "null,".repeat(19_999) + "null]\n",
  );
  const source = Buffer.concat([Buffer.from(request.sourceLockBytes), extension]);
  const actual = Buffer.concat([Buffer.from(request.actualLockBytes), extension]);
  const sourceSha256 = digest(source),
    actualSha256 = digest(actual);
  const augmented = { ...withSource(request, source), actualLockBytes: actual };
  const selection = canonical(augmented.selection);
  const result = checkManagedRestorationLockV1(augmented);
  assert.equal(result.conformance, "nonconformant");
  assert.deepEqual(result.diagnostics, [
    {
      code: "derivation",
      path: [],
      message: "annotation path expansion budget exceeded",
    },
  ]);
  assert.equal(digest(augmented.sourceLockBytes), sourceSha256);
  assert.equal(augmented.selection.sourceLockSha256, sourceSha256);
  assert.equal(digest(augmented.actualLockBytes), actualSha256);
  assert.equal(canonical(augmented.selection), selection);
  assert.equal(digest(request.originalClosureBytes), request.selection.originalClosureSha256);
  assert.equal(
    digest(request.sourceLockBytes),
    "83a30e0d504b90ded54cfbf1b1c7a7bcdd4d78950876cf0d7dd352983c628916",
  );
  assert.equal(
    digest(request.actualLockBytes),
    "d35092ff74098bfdf9a95cb9a5534ff7ee0aa828e9a5eba9e4114baf167c3332",
  );
  context.diagnostic(completion);
});

test("foreign dollar-key fields cannot mask parent key spelling or comments", async () => {
  const request = await retained();
  const extension = Buffer.from(
    "\n# parent key witness\nretainedExtension:\n" +
      "  ? $key # child value witness\n  : witness\n" +
      "  $document: {comment: document, commentBefore: before}\n" +
      "  comment: slot\n  commentBefore: before\n" +
      "$document: {comment: root, commentBefore: before}\n",
  );
  const source = Buffer.concat([Buffer.from(request.sourceLockBytes), extension]);
  const actual = Buffer.concat([Buffer.from(request.actualLockBytes), extension]);
  for (const bytes of [source, actual]) {
    const document = parseDocument(bytes.toString("utf8"));
    assert.deepEqual(document.errors, []);
    assert.ok(isMap(document.contents));
    const pair = document.contents.items.find(
      (row) => isScalar(row.key) && row.key.value === "retainedExtension",
    );
    assert.ok(pair && isScalar(pair.key));
    assert.equal(pair.key.type, "PLAIN");
    assert.equal(pair.key.commentBefore, " parent key witness");
    const witness = document.getIn(["retainedExtension", "$key"], true);
    assert.ok(isScalar(witness));
    assert.equal(witness.value, "witness");
    assert.equal(witness.commentBefore, " child value witness");
  }
  const retainedGraph: unknown = parseDocument(
    Buffer.from(request.actualLockBytes).toString("utf8"),
  ).toJSON();
  assert.ok(record(retainedGraph));
  assert.ok(!Object.hasOwn(retainedGraph, "retainedExtension"));
  assert.ok(!Object.hasOwn(retainedGraph, "$document"));
  const graph: unknown = parseDocument(actual.toString("utf8")).toJSON();
  assert.equal(
    canonical(graph),
    canonical({
      ...retainedGraph,
      retainedExtension: {
        $key: "witness",
        $document: { comment: "document", commentBefore: "before" },
        comment: "slot",
        commentBefore: "before",
      },
      $document: { comment: "root", commentBefore: "before" },
    }),
  );
  const augmented = { ...withSource(request, source), actualLockBytes: actual };
  const sourceSha256 = digest(source),
    actualSha256 = digest(actual);
  const selection = canonical(augmented.selection);
  const baseline = accepted(checkManagedRestorationLockV1(augmented));
  assert.deepEqual(baseline.diagnostics, []);
  assert.equal(
    baseline.expectedLockDigest,
    "sha256:" +
      createHash("sha256")
        .update("managed-restoration-lock/v1\n")
        .update(canonical(graph))
        .digest("hex"),
  );
  const edits: readonly {
    readonly before: string;
    readonly after: string;
    readonly keyType: "PLAIN" | "QUOTE_DOUBLE";
    readonly commentBefore: string;
    readonly address: string;
  }[] = [
    {
      before: "\nretainedExtension:",
      after: '\n"retainedExtension":',
      keyType: "QUOTE_DOUBLE",
      commentBefore: " parent key witness",
      address: JSON.stringify(["spelling", "key", ["retainedExtension"]]),
    },
    {
      before: "# parent key witness\n",
      after: "# changed parent key witness\n",
      keyType: "PLAIN",
      commentBefore: " changed parent key witness",
      address: JSON.stringify(["comment", "key", ["retainedExtension"], "commentBefore"]),
    },
  ];
  for (const edit of edits) {
    const text = actual.toString("utf8");
    assert.equal(
      text.split(edit.before).length,
      2,
      "the annotation edit must have exactly one target",
    );
    const changed = Buffer.from(text.replace(edit.before, edit.after));
    assert.notEqual(digest(changed), actualSha256);
    const document = parseDocument(changed.toString("utf8"));
    assert.deepEqual(document.errors, []);
    assert.equal(
      canonical(document.toJSON()),
      canonical(graph),
      "the entire actual graph must remain unchanged",
    );
    assert.ok(isMap(document.contents));
    const pair = document.contents.items.find(
      (row) => isScalar(row.key) && row.key.value === "retainedExtension",
    );
    assert.ok(pair && isScalar(pair.key));
    assert.equal(pair.key.type, edit.keyType);
    assert.equal(pair.key.commentBefore, edit.commentBefore);
    const witness = document.getIn(["retainedExtension", "$key"], true);
    assert.ok(isScalar(witness));
    assert.equal(witness.value, "witness");
    assert.equal(witness.commentBefore, " child value witness");
    const result = checkManagedRestorationLockV1({ ...augmented, actualLockBytes: changed });
    assert.equal(result.conformance, "nonconformant");
    assert.ok(result.diagnostics.length > 0);
    assert.ok(result.diagnostics.every((row) => row.code === "preservation"));
    assert.ok(result.diagnostics.some((row) => row.path[2] === edit.address));
    assert.equal(
      result.expectedLockDigest,
      baseline.expectedLockDigest,
      "annotation edits to A must not change E",
    );
    assert.equal(digest(augmented.sourceLockBytes), sourceSha256);
    assert.equal(augmented.selection.sourceLockSha256, sourceSha256);
    assert.equal(digest(augmented.actualLockBytes), actualSha256);
    assert.equal(canonical(augmented.selection), selection);
    assert.equal(digest(request.originalClosureBytes), request.selection.originalClosureSha256);
    assert.equal(
      digest(request.sourceLockBytes),
      "83a30e0d504b90ded54cfbf1b1c7a7bcdd4d78950876cf0d7dd352983c628916",
    );
    assert.equal(
      digest(request.actualLockBytes),
      "d35092ff74098bfdf9a95cb9a5534ff7ee0aa828e9a5eba9e4114baf167c3332",
    );
  }
});
