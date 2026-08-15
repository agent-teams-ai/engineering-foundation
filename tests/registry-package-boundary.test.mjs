import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  isCanonicalPathInside,
  isSameCanonicalPath
} from "../scripts/registry-document-authoring-e2e.mjs";

test("canonical package boundaries use platform path semantics", () => {
  const root = join("registry-root", "node_modules", "@agent-teams", "engineering-foundation");
  const qualification = join(root, "dist", "document-authoring", "qualification", "index.js");

  assert.equal(isSameCanonicalPath(root, root), true);
  assert.equal(isCanonicalPathInside(root, qualification), true);
  assert.equal(isCanonicalPathInside(root, root), false);
  assert.equal(isCanonicalPathInside(root, `${root}-alternate`), false);
  assert.equal(isCanonicalPathInside(root, join(root, "..", "docs-protocol")), false);
});

test("canonical package identity follows Windows drive and casing semantics", {
  skip: process.platform !== "win32"
}, () => {
  assert.equal(
    isSameCanonicalPath("C:\\Registry\\Foundation", "c:\\registry\\foundation"),
    true
  );
  assert.equal(
    isCanonicalPathInside("C:\\Registry\\Foundation", "c:\\registry\\foundation\\dist\\index.js"),
    true
  );
});

test("physical package containment rejects a link that resolves outside", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "registry-package-boundary-"));
  context.after(() => rm(temporaryRoot, { force: true, recursive: true }));
  const packageRoot = join(temporaryRoot, "package");
  const outsideRoot = join(temporaryRoot, "outside");
  await Promise.all([mkdir(packageRoot), mkdir(outsideRoot)]);
  const linkedQualification = join(packageRoot, "qualification");
  await symlink(outsideRoot, linkedQualification, process.platform === "win32" ? "junction" : "dir");

  assert.equal(isCanonicalPathInside(
    await realpath(packageRoot), await realpath(linkedQualification)
  ), false);
});
