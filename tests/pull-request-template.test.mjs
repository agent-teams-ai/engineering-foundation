import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("local pull request template retains executable specification evidence fields", async () => {
  const template = await readFile(
    join(repositoryRoot, ".github", "pull_request_template.md"),
    "utf8",
  );
  for (const marker of [
    "Schema/version:",
    "Positive fixture:",
    "Negative fixture:",
    "Exact consumer gate:",
    "N/A rationale",
  ]) {
    assert.ok(template.includes(marker), `missing executable specification PR marker: ${marker}`);
  }
});
