import assert from "node:assert/strict";

export function createScriptedSequence(expectedValues, label = "scripted sequence") {
  const expected = Object.freeze([...expectedValues]);
  let cursor = 0;

  return Object.freeze({
    consume(actual) {
      assert.ok(
        cursor < expected.length,
        `${label} received an unexpected extra value: ${JSON.stringify(actual)}`,
      );
      const expectedValue = expected[cursor];
      assert.deepEqual(
        actual,
        expectedValue,
        `${label} diverged at step ${cursor + 1}`,
      );
      cursor += 1;
    },

    assertConsumed() {
      assert.equal(
        cursor,
        expected.length,
        `${label} did not consume ${expected.length - cursor} planned step(s): ${JSON.stringify(expected.slice(cursor))}`,
      );
    },
  });
}
