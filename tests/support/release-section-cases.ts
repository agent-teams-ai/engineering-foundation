import assert from "node:assert/strict";
import test from "node:test";
import { releaseSections } from "../../scripts/release-pr-sections.mjs";

export function registerReleaseSectionCases(packageName: string, docsPackageName: string): void {
  test("parses an unscoped-only generated package release", () => {
    const section = "## stack-toolchain@0.1.0\n\n- Add tooling.";
    assert.deepEqual(
      [...releaseSections("# Releases\n" + section)],
      [["stack-toolchain", section]],
    );
  });

  test("keeps mixed unscoped and scoped release sections separate", () => {
    const sections = [
      [packageName, "## " + packageName + "@1.1.0\n\n- Foundation change."],
      ["stack-toolchain", "## stack-toolchain@0.1.0\n\n- Stack change."],
      [docsPackageName, "## " + docsPackageName + "@1.1.0\n\n- Docs change."],
    ];
    assert.deepEqual(
      [...releaseSections("# Releases\n" + sections.map((row) => row[1]).join("\n\n"))],
      sections,
    );
  });

  test("rejects duplicate unscoped package releases even at different versions", () => {
    const body = "# Releases\n## stack-toolchain@0.1.0\n## stack-toolchain@0.2.0";
    assert.throws(() => releaseSections(body), /duplicate package release/u);
  });

  test("does not parse malformed package release headings", () => {
    const headings = ["## @a/@1", "## @a/b/c@1", "## a/b@1", "## a b@1", "## a@", "### a@1"];
    for (const heading of headings) {
      assert.throws(
        () => releaseSections("# Releases\n" + heading),
        /does not contain package releases/u,
        heading,
      );
    }
  });
}
