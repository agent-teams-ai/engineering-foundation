import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distRoot = process.env.FOUNDATION_DIST_ROOT ?? join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "dist",
);
const { parseStrictJson, StrictJsonError } = await import(
  pathToFileURL(join(distRoot, "strict-json.js")).href
);

test("strict JSON rejects comments, trailing commas, and duplicate keys at any depth", () => {
  for (const source of [
    '{"value":1,// comment\n"next":2}',
    '{"value":1,}',
    '{"value":1,"value":2}',
    '{"nested":{"value":1,"value":2}}',
  ]) {
    assert.throws(() => parseStrictJson(source), StrictJsonError);
  }
  assert.deepEqual(parseStrictJson('{"nested":{"value":1}}'), { nested: { value: 1 } });
});
