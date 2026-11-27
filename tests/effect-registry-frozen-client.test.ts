import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  assertFrozenClientBootstrap,
  assertFrozenClientInput,
  assertFrozenClientSignature,
  assertFrozenMismatchRejection,
} from "../scripts/effect-registry-frozen-client.ts";

const sri =
  "sha512-PakPh1DVnNuaxWehZ9dDQcvBAmpJq7knHiDWKGSxT58V11cDVCZzLh2N+pjMUaT2aKbjzfpbgtc8MXMegN7IjA==";
const signature = { keyid: "SHA256:fixture", sig: "Zml4dHVyZQ==" };

function witness() {
  return {
    name: "npm",
    version: "10.9.11",
    _id: "npm@10.9.11",
    _resolved: "https://registry.npmjs.org/npm/-/npm-10.9.11.tgz",
    _integrity: sri,
    dist: {
      tarball: "https://registry.npmjs.org/npm/-/npm-10.9.11.tgz",
      integrity: sri,
      signatures: [signature],
    },
    _signatures: [signature],
  };
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function input() {
  const root = new URL("./fixtures/effect-diagnostics/registry-frozen-client/", import.meta.url);
  const manifest: unknown = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const bytes = await readFile(new URL("package-lock.json", root));
  const lock = record(JSON.parse(bytes.toString("utf8")));
  return { manifest, lock, bytes };
}

await test("private verifier retains the observed release and ordinary npm bootstrap versions", () => {
  assert.equal(
    assertFrozenClientBootstrap({ bootstrapVersion: "11.19.0", verifierVersion: "21.5.1" }),
    "11.19.0",
  );
  assert.equal(
    assertFrozenClientBootstrap({ bootstrapVersion: "11.20.0", verifierVersion: "21.5.1" }),
    "11.20.0",
  );
});

await test("private verifier rejects absent, unqualified and mismatched bootstrap observations", () => {
  for (const value of [
    undefined,
    null,
    [],
    {},
    { bootstrapVersion: "11.19.0" },
    { verifierVersion: "21.5.1" },
    { bootstrapVersion: "11.18.0", verifierVersion: "21.5.1" },
    { bootstrapVersion: "11.19.1", verifierVersion: "21.5.1" },
    { bootstrapVersion: "11.21.0", verifierVersion: "21.5.1" },
    { bootstrapVersion: "11.19.0", verifierVersion: "21.5.0" },
    { bootstrapVersion: "11.20.0", verifierVersion: "21.5.2" },
    { bootstrapVersion: 11.19, verifierVersion: "21.5.1" },
    { bootstrapVersion: "11.20.0", verifierVersion: ["21.5.1"] },
  ]) {
    assert.throws(() => assertFrozenClientBootstrap(value));
  }
});

await test("private client input retains the genuine exact npm-generated lock", async () => {
  const { manifest, lock, bytes } = await input();
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "feadaffb2aba001d8fcfb78b631429f5ef4674e2651787a6abf6359c224f384a",
  );
  assertFrozenClientInput(manifest, lock);
});

await test("private client input rejects extra dependencies and changed artifact identity", async () => {
  for (const kind of ["unbundled", "outside", "integrity", "manifest-script"]) {
    const { manifest, lock } = await input();
    const packages = record(lock["packages"]);
    if (kind === "unbundled") {
      record(packages["node_modules/npm/node_modules/abbrev"])["inBundle"] = false;
    } else if (kind === "outside") {
      packages["node_modules/unverified"] = packages["node_modules/npm/node_modules/abbrev"];
      delete packages["node_modules/npm/node_modules/abbrev"];
    } else if (kind === "integrity") {
      record(packages["node_modules/npm"])["integrity"] = "sha512-unverified";
    } else {
      record(manifest)["scripts"] = { postinstall: "unexpected" };
    }
    assert.throws(() => {
      assertFrozenClientInput(manifest, lock);
    });
  }
});

await test("signature witness rejects absent, empty or inconsistent cryptographic-loop inputs", () => {
  const original = witness();
  assert.deepEqual(assertFrozenClientSignature(original), ["SHA256:fixture"]);
  for (const value of [
    { ...original, dist: { ...original.dist, signatures: undefined } },
    { ...original, dist: { ...original.dist, signatures: [] } },
    { ...original, _signatures: [] },
    { ...original, _signatures: [{ ...signature, sig: "b3RoZXI=" }] },
    { ...original, _signatures: [{ ...signature, keyid: "SHA256:other" }] },
  ]) {
    assert.throws(() => assertFrozenClientSignature(value));
  }
});

await test("signature witness binds the exact package, archive and signed integrity", () => {
  const original = witness();
  for (const value of [
    { ...original, name: "another-package" },
    { ...original, version: "10.9.10" },
    { ...original, _id: "npm@10.9.10" },
    { ...original, _resolved: "https://example.invalid/npm-10.9.11.tgz" },
    { ...original, _integrity: "sha512-other" },
    { ...original, dist: { ...original.dist, tarball: "https://example.invalid/npm.tgz" } },
    { ...original, dist: { ...original.dist, integrity: "sha512-other" } },
  ]) {
    assert.throws(() => assertFrozenClientSignature(value));
  }
});

await test("frozen mismatch evidence requires the actual required Effect lock refusal", () => {
  const expected = {
    code: 1,
    signal: null,
    timedOut: false,
    terminationConfirmed: true,
    stderr:
      "npm error code EUSAGE\n" +
      "npm error Invalid: lock file's effect@0.0.0-effect-fixture-mismatch does not satisfy effect@4.1.4\n",
  };
  assertFrozenMismatchRejection(expected);
  for (const failure of [
    undefined,
    { ...expected, code: 0 },
    { ...expected, signal: "SIGKILL" },
    { ...expected, timedOut: true },
    { ...expected, terminationConfirmed: false },
    { ...expected, stderr: "npm error code ECONNRESET\n" },
    {
      ...expected,
      stderr: "npm error code EUSAGE\nnpm error Missing: @oven/bun-win32-x64@ from lock file\n",
    },
  ]) {
    assert.throws(() => {
      assertFrozenMismatchRejection(failure);
    });
  }
});
