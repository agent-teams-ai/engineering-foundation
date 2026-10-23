import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDocsProtocolQualification } from "../../dist/qualification/index.js";
import { snapshot } from "../../dist/features/qualification/adapters/filesystem-evidence.js";
const fixtureRoot = new URL("../fixtures/portable-qualification", import.meta.url).pathname;

export function registerInstalledQualificationCase(): void {
  void test("shared qualification runner qualifies a preattached consumer without changing its source", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "atd-installed-"));
    const installedRoot = join(temporary, "consumer");
    try {
      await cp(fixtureRoot, installedRoot, { recursive: true });
      const scope = join(installedRoot, "node_modules", "@agent-teams");
      await mkdir(scope, { recursive: true });
      const installedLink = join(scope, "docs-protocol");
      const installedPackage = new URL("../..", import.meta.url).pathname;
      await symlink(
        installedPackage,
        installedLink,
        process.platform === "win32" ? "junction" : "dir",
      );
      const before = await snapshot(installedRoot);
      const linkBefore = await readlink(installedLink);
      const receipt = await runDocsProtocolQualification({
        fixtureRoot: installedRoot,
        scenario: {
          find: { query: { type: "adr" }, expectedIds: [] },
          newDocument: {
            intent: {
              type: "adr",
              id: "ADR-0001",
              title: "Qualification decision",
              owner: "architecture/tooling",
              summary: "Proves the shared disposable qualification workflow.",
            },
          },
        },
      });
      assert.equal(receipt.projectId, "docs-protocol-qualification");
      assert.equal(
        receipt.appliedDocumentPath,
        "docs/decisions/generated/0001-qualification-decision.md",
      );
      assert.deepEqual(receipt.checks, [
        "info",
        "find",
        "preview",
        "crash",
        "doctor",
        "recover",
        "receipt",
        "parent",
        "apply",
        "index",
        "check",
        "source-unchanged",
      ]);
      assert.equal(await snapshot(installedRoot), before);
      assert.equal(await readlink(installedLink), linkBefore);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
}
