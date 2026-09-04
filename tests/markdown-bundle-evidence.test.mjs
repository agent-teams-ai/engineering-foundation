import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { verifyBundledComponent } from "../scripts/markdown-bundle-evidence.mjs";
import { sha256 } from "../scripts/pack-artifact-archive.mjs";
import { tarArchive } from "./pack-publishable-artifacts-support.mjs";

const source = Buffer.from("export const value = 1;\n");
const license = Buffer.from("Fixture permission notice.\n");
const manifest = { name: "@fixture/parser", version: "1.2.3", license: "MIT" };
const integrityFor = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

function component(extraEntries = [], { omitLicense = false } = {}) {
  const archive = tarArchive([
    { name: "package/package.json", data: Buffer.from(JSON.stringify(manifest)) },
    { name: "package/index.js", data: source },
    ...omitLicense ? [] : [{ name: "package/LICENSE", data: license }],
    ...extraEntries,
  ]);
  return { ...manifest, archive, integrity: integrityFor(archive), inputs: [{ path: "index.js", bytes: source }] };
}

test("bundled component binds input bytes, original archive identity and complete notices", () => {
  const input = component([{ name: "package/NOTICE.txt", data: Buffer.from("Fixture attribution.\n") }]);
  const proof = verifyBundledComponent(input);
  assert.equal(proof.name, manifest.name);
  assert.equal(proof.version, manifest.version);
  assert.equal(proof.integrity, input.integrity);
  assert.equal(proof.archiveSha256, sha256(input.archive));
  assert.deepEqual(proof.files, [{ path: "index.js", sha256: sha256(source) }]);
  assert.deepEqual(proof.licenses.map(({ path }) => path), ["LICENSE", "NOTICE.txt"]);
  assert.equal(proof.licenses[0].text, license.toString());
  assert.ok(Object.isFrozen(proof));
  assert.ok(Object.isFrozen(proof.files));
  assert.ok(Object.isFrozen(proof.licenses));
  assert.deepEqual(verifyBundledComponent(input), proof);
});

test("matching metadata cannot disguise modified archive or bundled input bytes", () => {
  const input = component();
  assert.throws(() => verifyBundledComponent({ ...input, archive: Buffer.from("different archive") }), /integrity mismatch/u);
  assert.throws(() => verifyBundledComponent({ ...input, version: "9.9.9" }), /manifest identity mismatch/u);
  assert.throws(() => verifyBundledComponent({ ...input, inputs: [{ path: "index.js", bytes: Buffer.from("modified") }] }), /upstream bytes differ/u);
  assert.throws(() => verifyBundledComponent({ ...input, inputs: [{ path: "missing.js", bytes: source }] }), /upstream bytes differ/u);
});

for (const [label, entry] of [
  ["duplicate", { name: "package/index.js", data: source }],
  ["case alias", { name: "package/INDEX.js", data: source }],
  ["path traversal", { name: "package/../escape.js", data: source }],
  ["outside root", { name: "elsewhere/file.js", data: source }],
  ["symlink", { name: "package/link", type: "2" }],
  ["hardlink", { name: "package/link", type: "1" }],
]) {
  test(`upstream archive rejects ${label} without extracting files`, () => {
    assert.throws(() => verifyBundledComponent(component([entry])));
  });
}

test("bundle input inventory rejects duplicates, aliases, missing bytes and empty input", () => {
  const input = component();
  for (const inputs of [
    [],
    [input.inputs[0], input.inputs[0]],
    [input.inputs[0], { path: "INDEX.js", bytes: source }],
    [{ path: "../escape.js", bytes: source }],
    [{ path: "index.js", bytes: source.toString() }],
    [{ path: "cafe\u0301.js", bytes: source }],
  ]) {assert.throws(() => verifyBundledComponent({ ...input, inputs }));}
});

test("SPDX metadata or NOTICE alone cannot replace missing license text", () => {
  assert.throws(() => verifyBundledComponent(component([], { omitLicense: true })), /no complete retained license/u);
  assert.throws(() => verifyBundledComponent(component([
    { name: "package/NOTICE", data: Buffer.from("Not a license") },
  ], { omitLicense: true })), /no complete retained license/u);
  assert.throws(() => verifyBundledComponent(component([
    { name: "package/License.txt", data: Buffer.from(" \n") },
  ], { omitLicense: true })), /empty upstream notice/u);
});

test("reviewed supplemental license binds immutable origin, text and actually bundled source", () => {
  const input = component([], { omitLicense: true });
  const supplement = {
    bytes: license, sha256: sha256(license),
    source: `https://github.com/fixture/parser/blob/${"a".repeat(40)}/LICENSE`,
    sourceInput: { path: "index.js", sha256: sha256(source) },
  };
  const proof = verifyBundledComponent({ ...input, supplement });
  assert.equal(proof.licenses[0].text, license.toString());
  assert.equal(proof.licenses[0].source, supplement.source);
  for (const invalid of [
    { ...supplement, source: "https://example.test/LICENSE" },
    { ...supplement, source: "https://github.com/fixture/parser/blob/main/LICENSE" },
    { ...supplement, source: `https://github.com/fixture/parser/blob/${"a".repeat(40)}/../LICENSE` },
    { ...supplement, bytes: Buffer.from("substitution") },
    { ...supplement, sourceInput: { path: "index.js", sha256: "0".repeat(64) } },
    { ...supplement, sourceInput: { path: "missing.js", sha256: sha256(source) } },
  ]) {assert.throws(() => verifyBundledComponent({ ...input, supplement: invalid }));}
  const extra = component([{ name: "package/unused.js", data: source }], { omitLicense: true });
  assert.throws(() => verifyBundledComponent({ ...extra, supplement: {
    ...supplement, sourceInput: { path: "unused.js", sha256: sha256(source) },
  } }), /does not bind exact bundled source/u);
});

test("component identity and archive/input bounds fail closed", () => {
  const input = component();
  for (const override of [
    { name: "../parser" }, { version: "latest" }, { integrity: "sha256-deadbeef" },
    { archive: Buffer.alloc(8 * 1024 * 1024 + 1) }, { inputs: Array(2501).fill(input.inputs[0]) },
  ]) {assert.throws(() => verifyBundledComponent({ ...input, ...override }));}
});
