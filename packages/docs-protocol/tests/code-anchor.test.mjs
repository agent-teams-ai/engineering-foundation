import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NodeCodeAnchorMatcher } from "../dist/features/portable-documentation/adapters/outbound/node-code-anchor-matcher.js";
import { normalizeCodeAnchors } from "../dist/features/portable-documentation/domain/document-semantics.js";

test("code anchors use the closed common shape and safe source patterns", () => {
  assert.deepEqual(normalizeCodeAnchors([{ pattern: "src/**/*.ts", enforcement: "required" }]), [{ pattern: "src/**/*.ts", enforcement: "required" }]);
  for (const pattern of ["../secret", "/absolute", "docs/**/*.md", ".agents/**", "src\\file.ts"]) {
    assert.throws(() => normalizeCodeAnchors([{ pattern, enforcement: "required" }]));
  }
  assert.throws(() => normalizeCodeAnchors([
    { pattern: "src/**/*.ts", enforcement: "required" },
    { pattern: "src/**/*.ts", enforcement: "required" }
  ]), /unique/u);
  assert.throws(() => normalizeCodeAnchors(Array.from({ length: 257 }, (_value, index) => ({ pattern: `src/file-${index}.ts`, enforcement: "required" }))));
  assert.throws(() => normalizeCodeAnchors([{ pattern: "src/control\u0001.ts", enforcement: "required" }]));
});

test("matcher accepts real regular files and never traverses symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "docs-anchor-"));
  const outside = await mkdtemp(join(tmpdir(), "docs-anchor-outside-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "real.ts"), "export {};\n");
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "node_modules", "dependency.ts"), "export {};\n");
    await writeFile(join(outside, "escaped.ts"), "export {};\n");
    await symlink(outside, join(root, "linked"));
    const matcher = new NodeCodeAnchorMatcher();
    assert.deepEqual(await matcher.matchedPatterns({ consumerRoot: root, patterns: ["src/*.ts", "linked/*.ts", "node_modules/*.ts"] }), ["src/*.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("matcher rejects an unbounded global pattern corpus before filesystem traversal", async () => {
  const matcher = new NodeCodeAnchorMatcher();
  await assert.rejects(
    matcher.matchedPatterns({ consumerRoot: "/path/that/must/not/be-read", patterns: Array.from({ length: 1_025 }, (_value, index) => `src/${index}.ts`) }),
    /1024-pattern budget/u
  );
});
