import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseSync } from "oxc-parser";
import { validatePrimitiveSyntax } from "../scripts/feature-modules/purity.mjs";
import { compareBinaryStrings as foundationCompare, compareBinaryStringSequences } from "../packages/engineering-foundation/dist/binary-string-comparator.js";
import { compareBinaryStrings as authoringCompare } from "../packages/document-authoring/dist/binary-string-comparator.js";
import { isExactVersion, sameNumberedPrereleaseTrain, semanticVersionBumpBetween } from "../packages/engineering-foundation/dist/semantic-version.js";
import { sha256Text } from "../packages/repository-mutation/dist/serialization.js";

const primitivePaths = [
  "packages/engineering-foundation/src/binary-string-comparator.ts",
  "packages/document-authoring/src/binary-string-comparator.ts",
  "packages/engineering-foundation/src/semantic-version.ts",
  "packages/repository-mutation/src/path-identity.ts",
  "packages/repository-mutation/src/canonical-json.ts",
  "packages/repository-mutation/src/strict-json.ts"
];

test("text digests preserve exact UTF-8 bytes including malformed surrogate inputs", () => {
  for (const value of ["", "a\0b", "e\u0301", "\u00e9", "\ud800", "\udfff", "\ud800\udc00", "\ufffd", "\ud800a\udfff"]) {
    const expected = `sha256:${createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex")}`;
    assert.equal(sha256Text(value), expected);
  }
  assert.notEqual(sha256Text("e\u0301"), sha256Text("\u00e9"));
});

for (const path of primitivePaths) {
  test(`finite primitive syntax admits the real source: ${path}`, async () => {
    const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    const parsed = parseSync(path, source);
    assert.deepEqual(parsed.errors, []);
    const problems = [];
    validatePrimitiveSyntax(path, parsed.program, problems);
    assert.deepEqual(problems, []);

    // The same source with an ambient operation must lose admission.
    const polluted = parseSync(path, `${source}\nexport function clockProbe() { return Date.now(); }`);
    const violations = [];
    validatePrimitiveSyntax(path, polluted.program, violations);
    assert.ok(violations.some(({ code }) => code === "impure-primitive"));
  });
}

test("independently published comparators preserve one raw UTF-16 ordering", () => {
  const ordered = ["", "\0", "A", "a", "a\0", "aa", "e\u0301", "z", "\u00e9", "\ud800", "\ud800\udc00", "\udfff", "\ue000", "\uffff"];
  for (const compare of [foundationCompare, authoringCompare]) {
    for (let left = 0; left < ordered.length; left += 1) {
      for (let right = 0; right < ordered.length; right += 1) {
        assert.equal(Math.sign(compare(ordered[left], ordered[right])), Math.sign(left - right));
      }
    }
  }
  assert.deepEqual(["aa", "a", ""].toSorted(foundationCompare), ["", "a", "aa"]);
  assert.ok(compareBinaryStringSequences(["a", "\0b"], ["a\0", "b"]) < 0);
  assert.ok(compareBinaryStringSequences(["a"], ["a", ""]) < 0);
});

test("exact version precedence retains prerelease order and ignores build metadata", () => {
  const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
  for (let index = 1; index < ordered.length; index += 1) {
    assert.equal(semanticVersionBumpBetween(ordered[index - 1], ordered[index]), "patch");
    assert.equal(semanticVersionBumpBetween(ordered[index], ordered[index - 1]), undefined);
  }
  assert.equal(semanticVersionBumpBetween("1.0.0+a", "1.0.0+b"), undefined);
  assert.equal(semanticVersionBumpBetween("9007199254740992.0.0", "9007199254740993.0.0"), "major");
  assert.equal(semanticVersionBumpBetween("1.9007199254740992.0", "1.9007199254740993.0"), "minor");
  assert.equal(semanticVersionBumpBetween("1.0.0-rc.9007199254740992", "1.0.0-rc.9007199254740993"), "patch");
});

test("exact versions and numbered trains reject ranges and incompatible release identities", () => {
  for (const value of ["v1.2.3", "^1.2.3", "1.2", "1.02.3", "1.2.3-01", "1.2.3-a..b", "1.2.3\n"]) {
    assert.equal(isExactVersion(value), false, value);
    assert.throws(() => semanticVersionBumpBetween("1.0.0", value), TypeError);
  }
  assert.equal(sameNumberedPrereleaseTrain("1.2.3-rc.1+a", "1.2.3-rc.99+b", "rc"), true);
  assert.equal(sameNumberedPrereleaseTrain("1.2.3-rc.1", "1.2.4-rc.2", "rc"), false);
  assert.equal(sameNumberedPrereleaseTrain("1.2.3-rc.1", "1.2.3-beta.2"), false);
  assert.equal(sameNumberedPrereleaseTrain("1.2.3-rc.1", "1.2.3-rc.2", "beta"), false);
  assert.equal(sameNumberedPrereleaseTrain("1.2.3-rc.1.extra", "1.2.3-rc.2"), false);
});
