import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import fsPromises, { mkdtemp, writeFile, mkdir, symlink, rm, open, rename, appendFile, truncate, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FilesystemPublicApiAuditInputs, auditDigest, auditInputPath, auditRead, AUDIT_MAX_BYTES, AUDIT_MAX_FILES } from "../dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/public-api-audit-inputs.js";
import { projectPublicApiObservation } from "../dist/capabilities/public-api-compatibility/application/policies/project-public-api-observation.js";
import { classifyPublicApiChange } from "../dist/capabilities/public-api-compatibility/application/policies/evaluate-public-api-compatibility.js";
const fingerprint = { sha256: () => "test-only-fingerprint" };

test("frozen-namespace path checks reject escapes, symlinks and oversized regular files", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foundation-audit-input-test-")));
  try {
    await mkdir(join(root, "inputs"));
    await writeFile(join(root, "inputs", "index.d.ts"), "export {};\n");
    assert.equal((await auditRead(root, "inputs/index.d.ts")).toString(), "export {};\n");
    for (const path of ["../escape", "/etc/passwd", "inputs/../inputs/index.d.ts", "inputs\\index.d.ts", "inputs//index.d.ts"]) {await assert.rejects(auditInputPath(root, path), /Invalid audit path/u);}
    await symlink(join(root, "inputs"), join(root, "alias"), "dir");
    await assert.rejects(auditInputPath(root, "alias/index.d.ts"), /symlink/u);
    const file = await open(join(root, "oversized.d.ts"), "w");
    try { await file.truncate(AUDIT_MAX_BYTES + 1); } finally { await file.close(); }
    await assert.rejects(auditRead(root, "oversized.d.ts"), /budget/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("empty surfaces retain added/removed export paths and scoped identities cannot cross subjects", () => {
  const observation = { subject: "A", packageName: "audit-fixture", packageVersion: "1.0.0", exportPath: ".", toolchain: "test", items: [] };
  const left = projectPublicApiObservation([observation], "audit-fixture");
  const right = projectPublicApiObservation([{ ...observation, subject: "C" }, { ...observation, subject: "C", exportPath: "./extra" }], "audit-fixture");
  const added = classifyPublicApiChange(left.snapshot, right.snapshot, fingerprint);
  assert.equal(added.classification, "additive");
  assert.deepEqual(added.addedEntrypoints, ["./extra"]);
  const removed = classifyPublicApiChange(right.snapshot, left.snapshot, fingerprint);
  assert.equal(removed.classification, "breaking");
  assert.deepEqual(removed.removedEntrypoints, ["./extra"]);
  assert.throws(() => projectPublicApiObservation([observation, { ...observation, subject: "C" }], "audit-fixture"), /Mixed audit subjects/u);
  const identity = { subject: "A", packageName: "audit-fixture", exportPath: ".", canonicalReference: "audit-fixture!f:function(1)" };
  const item = { displayName: "f", identity, kind: "Function", parentKind: "EntryPoint", parentReference: "audit-fixture!", public: true, isExported: true, excerpt: "export declare function f(): void;", references: [] };
  assert.throws(() => projectPublicApiObservation([{ ...observation, items: [item, item] }], "audit-fixture"), /Duplicate audit identity/u);
  const separatePaths = projectPublicApiObservation([{ ...observation, items: [item] }, { ...observation, exportPath: "./extra", items: [{ ...item, identity: { ...identity, exportPath: "./extra" } }] }], "audit-fixture");
  assert.equal(separatePaths.graphs.length, 2);
  const crossSubject = { ...item, references: [{ text: "f", canonicalReference: identity.canonicalReference, resolution: "local", target: { ...identity, subject: "C" } }] };
  assert.throws(() => projectPublicApiObservation([{ ...observation, items: [crossSubject] }], "audit-fixture"), /Missing scoped reference target/u);
});

for (const kind of ["files", "bytes"]) {
  test(`filesystem historical cumulative ${kind} budget is audit-local and retains exhaustion`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "foundation-audit-b-budget-")));
    try {
      const inputs = new FilesystemPublicApiAuditInputs(async () => {}, async () => {});
      const json = JSON.stringify({ schemaVersion: 1, packageName: "budget", packageVersion: "1.0.0", extractorVersion: "test", items: [] });
      // One small fixture, repeatedly declared: no large file or lowered production limit.
      const bytes = kind === "bytes" ? json.padEnd(16 * 1024, " ") : json;
      await writeFile(join(root, "b.json"), bytes);
      const entry = { packageName: "budget", path: "b.json", digest: auditDigest(bytes) };
      const budget = { bytes: 0, files: 0 };
      const count = kind === "files" ? AUDIT_MAX_FILES : AUDIT_MAX_BYTES / Buffer.byteLength(bytes);
      for (let i = 0; i < count; i++) { await inputs.baseline(root, entry, budget); }
      assert.equal(budget[kind], kind === "files" ? AUDIT_MAX_FILES : AUDIT_MAX_BYTES);
      await assert.rejects(inputs.baseline(root, entry, budget), new RegExp(`${kind === "files" ? "file" : "byte"} budget exhausted`, "u"));
      await assert.rejects(inputs.baseline(root, entry, budget), /budget exhausted/u);
      // Concurrent audits using the same adapter have independent counters.
      await Promise.all([inputs.baseline(root, entry, { bytes: 0, files: 0 }), inputs.baseline(root, entry, { bytes: 0, files: 0 })]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

const races = ["parent symlink", "replacement", "growth", "shrink"].flatMap((race) =>
  [false, true].map((budgeted) => ({ race, budgeted })));
for (const { race, budgeted } of races) {
  test(`audit read rejects ${race} during file access and closes its handle (budgeted=${budgeted})`, async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "foundation-audit-race-")));
    const outside = await realpath(await mkdtemp(join(tmpdir(), "foundation-audit-outside-")));
    const realOpen = fsPromises.open;
    let captured;
    try {
      await mkdir(join(root, "inputs"));
      const target = join(root, "inputs", "index.d.ts");
      await writeFile(target, "export {};\n");
      await writeFile(join(outside, "index.d.ts"), "outside bytes");
      t.mock.method(fsPromises, "open", async (...args) => {
        if (race === "parent symlink") {
          await rename(join(root, "inputs"), join(root, "saved"));
          await symlink(outside, join(root, "inputs"), "dir");
        }
        captured = await realOpen(...args);
        if (race !== "parent symlink") {
          const read = captured.read.bind(captured);
          let changed = false;
          t.mock.method(captured, "read", async (...readArgs) => {
            if (!changed) {
              changed = true;
              if (race === "growth") {await appendFile(target, "more bytes");}
              else if (race === "shrink") {await truncate(target, 0);}
              else {
                await rename(target, join(root, "saved.d.ts"));
                await writeFile(target, "replacement bytes");
              }
            }
            return read(...readArgs);
          });
        }
        return captured;
      });
      syncBuiltinESMExports();
      const size = Buffer.byteLength("export {};\n");
      const budget = { files: 0, bytes: AUDIT_MAX_BYTES - size };
      await assert.rejects(auditRead(root, "inputs/index.d.ts", budgeted ? budget : undefined), budgeted ? /symlink|changed|budget/u : /symlink|changed/u);
      assert.equal(captured.fd, -1);
      if (budgeted) {
        assert.equal(budget.files, 1);
        assert.ok(budget.bytes >= AUDIT_MAX_BYTES, "failed races must not refund reservations");
        if (race === "growth") {assert.equal(budget.bytes, AUDIT_MAX_BYTES + 1);}
        // Even after the failed read shrank to zero, a later B entry cannot use
        // its reserved bytes. Restore the path before testing the next attempt.
        if (race === "shrink") {
          t.mock.restoreAll();
          syncBuiltinESMExports();
          await writeFile(target, "x");
          await assert.rejects(auditRead(root, "inputs/index.d.ts", budget), /budget/u);
        }
      }
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
}

// Deliberately violate the external freeze. Every path snapshot can be made
// consistent with an outside handle: they are not an atomic containment proof.
for (const matching of [false, true]) {
  test(`toggled parents establish only content integrity (matching=${matching})`, async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "foundation-audit-toggle-")));
    const outside = await realpath(await mkdtemp(join(tmpdir(), "foundation-audit-toggle-outside-")));
    const realOpen = fsPromises.open;
    const realLstat = fsPromises.lstat;
    const realRealpath = fsPromises.realpath;
    let linked = false;
    let captured;
    let parsed = 0;
    const parent = join(root, "inputs");
    const saved = join(root, "saved");
    const target = join(parent, "b.json");
    async function selectOutside(value) {
      if (value === linked) {return;}
      if (value) {
        await rename(parent, saved);
        await symlink(outside, parent, "dir");
      } else {
        await rm(parent);
        await rename(saved, parent);
      }
      linked = value;
    }
    try {
      await mkdir(parent);
      const json = JSON.stringify({ schemaVersion: 1, packageName: "budget", packageVersion: "1.0.0", extractorVersion: "test", items: [] });
      await writeFile(target, json);
      await writeFile(join(outside, "b.json"), matching ? json : json.replace("1.0.0", "2.0.0"));
      t.mock.method(fsPromises, "realpath", async (...args) => {
        await selectOutside(false);
        return realRealpath(...args);
      });
      t.mock.method(fsPromises, "lstat", async (...args) => {
        await selectOutside(args[0] === target);
        return realLstat(...args);
      });
      t.mock.method(fsPromises, "open", async (...args) => {
        await selectOutside(true);
        captured = await realOpen(...args);
        return captured;
      });
      syncBuiltinESMExports();
      const inputs = new FilesystemPublicApiAuditInputs(async () => {}, async () => {parsed++;});
      const entry = { packageName: "budget", path: "inputs/b.json", digest: auditDigest(json) };
      const budget = { bytes: 0, files: 0 };
      if (matching) {
        assert.equal((await inputs.baseline(root, entry, budget)).packageVersion, "1.0.0");
        assert.equal(parsed, 1);
      } else {
        await assert.rejects(inputs.baseline(root, entry, budget), /Baseline digest mismatch/u);
        assert.equal(parsed, 0, "outside replacement must fail before baseline admission");
      }
      assert.equal(captured.fd, -1);
      assert.equal(budget.bytes, Buffer.byteLength(json));
      assert.equal(budget.files, 1);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await selectOutside(false);
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
}

test("stage creator exclusively seals a namespace before exposing readers", async () => {
  const { stagePublicApiAudit } = await import("../dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/stage-public-api-audit.js");
  const root = await realpath(await mkdtemp(join(tmpdir(), "foundation-audit-seal-")));
  let stage;
  try {
    const path = join(root, "index.d.ts");
    await writeFile(path, "export {};\n");
    const allowed = new Map([[path, auditDigest("export {};\n")]]);
    const destination = join(root, "stage");
    // mkdir is the namespace admission barrier, not POSIX write permission.
    // Two producers cannot both enter, even if both start before publication.
    const attempts = await Promise.allSettled([
      stagePublicApiAudit(root, allowed, destination),
      stagePublicApiAudit(root, allowed, destination)
    ]);
    assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(attempts.find(result => result.status === "rejected").reason.code, "EEXIST");
    stage = attempts.find(result => result.status === "fulfilled").value;
    allowed.clear();
    assert.equal(stage.files.size, 1, "published inventory must not alias producer input");
    await stage.revalidate();
    await assert.rejects(stagePublicApiAudit(root, allowed, destination), { code: "EEXIST" });
    await stage.release();
    await assert.rejects(stage.revalidate(), /released/u);
  } finally {
    await stage?.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("package validation binds its second manifest read to the declared digest", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foundation-audit-manifest-")));
  const realOpen = fsPromises.open;
  let reads = 0;
  try {
    const files = {
      "package.json": JSON.stringify({ name: "audit", version: "1.0.0", exports: { ".": { types: "./index.d.ts" } } }),
      "tsconfig.json": "{}",
      "index.d.ts": "export {};\n"
    };
    await mkdir(join(root, "A"));
    for (const [path, bytes] of Object.entries(files)) {await writeFile(join(root, "A", path), bytes);}
    const inventory = Object.entries(files).map(([path, bytes]) => ({ path: `A/${path}`, digest: auditDigest(bytes) }));
    const subject = {
      packages: [{ packageName: "audit", packageVersion: "1.0.0", manifestPath: "A/package.json", tsconfigPath: "A/tsconfig.json",
        entrypoints: [{ exportPath: ".", declarationEntryPoint: "A/index.d.ts" }], nonTypeExports: [] }],
      files: inventory, resolutionUniverse: [{ packageName: "audit", exportPath: ".", declarationPath: "A/index.d.ts" }],
      archive: { digest: auditDigest("archive"), extractedMembers: inventory }
    };
    await mkdir(join(root, "C"));
    for (const [path, bytes] of Object.entries(files)) {await writeFile(join(root, "C", path), bytes);}
    const candidateFiles = inventory.map(file => ({ ...file, path: file.path.replace(/^A\//u, "C/") }));
    const candidate = {
      packages: subject.packages.map(pkg => ({ ...pkg, manifestPath: "C/package.json", tsconfigPath: "C/tsconfig.json",
        entrypoints: [{ exportPath: ".", declarationEntryPoint: "C/index.d.ts" }] })),
      files: candidateFiles,
      resolutionUniverse: [{ packageName: "audit", exportPath: ".", declarationPath: "C/index.d.ts" }],
      build: { sourceIdentity: "test", buildIdentity: "test", declarations: candidateFiles.filter(file => file.path.endsWith(".d.ts")) }
    };
    const request = { subjects: { A: subject, B: { baselines: [] }, C: candidate } };
    const inputs = new FilesystemPublicApiAuditInputs(async () => {}, async () => {});
    await inputs.revalidate(root, request);
    t.mock.method(fsPromises, "open", async (...args) => {
      if (args[0] === join(root, "A", "package.json") && ++reads === 2) {
        // Same identity and exports, different bytes: semantic checks alone
        // would accept this reread and only a later pass might notice it.
        await writeFile(args[0], `${files["package.json"]}\n`);
      }
      return realOpen(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(inputs.revalidate(root, request), /Audit digest mismatch: A\/package.json/u);
    assert.equal(reads, 2);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});
