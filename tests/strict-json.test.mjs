import assert from "node:assert/strict";
import test from "node:test";
import { parseStrictJson as mutationParse, StrictJsonError as MutationStrictJsonError } from "../packages/repository-mutation/dist/serialization.js";
import { parseStrictJson, StrictJsonError } from "../packages/repository-mutation/dist/index.js";

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

test("strict JSON preserves public error identity and precise failure classification", () => {
  assert.equal(StrictJsonError, MutationStrictJsonError);
  assert.equal(parseStrictJson, mutationParse);
  for (const [source, failure] of [
    ['{"a":1,"\\u0061":2}', "duplicate-key"],
    ['{"nested":[{"a":1,"a":2}]}', "duplicate-key"],
    ['{"a":1,"a":2,}', "duplicate-key"],
    ['{"a":1} trailing', "syntax"],
    ['"unterminated', "syntax"],
    ["[1,]", "syntax"],
    ["\u00a0{}", "syntax"]
  ]) {
    assert.throws(() => parseStrictJson(source), (error) => {
      assert.ok(error instanceof StrictJsonError);
      assert.equal(error.failure, failure);
      assert.equal(error.name, "StrictJsonError");
      assert.equal(error.message, `Strict JSON parsing failed: ${failure}.`);
      return true;
    });
  }
});

test("strict JSON keeps cursor and key sets local to each object and invocation", () => {
  for (let index = 0; index < 3; index += 1) {
    assert.throws(() => parseStrictJson('{"a":1,"a":2}'), StrictJsonError);
    const value = '[{"a":1},{"a":2,"nested":{"a":3}}]';
    assert.deepEqual(parseStrictJson(value), JSON.parse(value));
    assert.deepEqual(parseStrictJson(' {"__proto__":null,"constructor":true} '), JSON.parse('{"__proto__":null,"constructor":true}'));
    assert.equal(parseStrictJson('"\\uD800"'), "\ud800");
  }
});
