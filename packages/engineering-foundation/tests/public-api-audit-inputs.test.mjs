import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink, rm, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FilesystemPublicApiAuditInputs, auditDigest, auditInputPath, auditRead, AUDIT_MAX_BYTES, AUDIT_MAX_FILES } from "../dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/public-api-audit-inputs.js";
import { projectPublicApiObservation } from "../dist/capabilities/public-api-compatibility/application/policies/project-public-api-observation.js";
import { classifyPublicApiChange } from "../dist/capabilities/public-api-compatibility/application/policies/evaluate-public-api-compatibility.js";
const fingerprint = { sha256: () => "test-only-fingerprint" };

test("input containment rejects escapes, symlinks and oversized regular files", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-audit-input-test-"));
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
    const root = await mkdtemp(join(tmpdir(), "foundation-audit-b-budget-"));
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
