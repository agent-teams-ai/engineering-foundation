import assert from "node:assert/strict";
import test, { mock } from "node:test";

import {
  parseJsonRecord,
  recordField,
} from "../packages/docs-protocol-agent-teams/dist/consumer-integration/adapters/strict-json-record.js";
import { loadUnselectedManagedProfileV4 } from "../packages/docs-protocol-agent-teams/dist/consumer-integration/adapters/unselected-managed-profile-v4-loader.js";

test("SDK JSON records reject literal, decoded and nested duplicate keys with their subject", () => {
  for (const source of [
    '{"key":1,"key":2}',
    '{"key":1,"\\u006bey":2}',
    '{"nested":{"key":1,"key":2}}',
    '{"nested":[{"key":1,"\\u006bey":2}]}',
    '{"key":1,"key":2,}',
  ]) {
    for (const subject of [undefined, "Qualified cohort v3 schema"]) {
      assert.throws(() => parseJsonRecord(source, subject), {
        name: "ConsumerJsonInputError",
        message: `${subject ?? "Package manifest"} must not contain duplicate keys.`,
      });
    }
  }
});

test("SDK JSON record syntax failures are distinct from duplicate keys and object roots", () => {
  for (const source of [
    "",
    "{",
    '{"key":}',
    '{"key":1,}',
    '{"nested":[1,]}',
    '{"key":/*comment*/1}',
    '{"key":1} trailing',
    "name: value",
    '"unterminated',
  ]) {
    for (const subject of [undefined, "Managed profile v4"]) {
      assert.throws(() => parseJsonRecord(source, subject), {
        name: "ConsumerJsonInputError",
        message: `${subject ?? "Package manifest"} must contain valid JSON.`,
      });
    }
  }
  for (const source of ["null", "[]", "[{}]", '"manifest"', "0", "true", "false"]) {
    assert.throws(() => parseJsonRecord(source), {
      name: "ConsumerJsonInputError",
      message: "Package manifest must be one JSON object.",
    });
  }
});

test("SDK JSON records preserve ordinary inert objects and independent nested keys", () => {
  const record = parseJsonRecord(
    '{"objects":[{"key":1},{"key":2}],"__proto__":{"safe":true},"field":{"ok":true}}',
  );
  assert.equal(Object.getPrototypeOf(record), Object.prototype);
  assert.equal(Object.hasOwn(record, "__proto__"), true);
  assert.deepEqual(record["objects"], [{ key: 1 }, { key: 2 }]);
  assert.deepEqual(recordField(record, "field"), { ok: true });
  for (const field of ["missing", "objects"]) {
    assert.deepEqual(recordField(record, field), {});
  }
});

test("SDK JSON records rethrow unexpected and impostor parser failures by identity", () => {
  const source = '{"probe":true}';
  for (const failure of [
    new Error("unexpected parser failure"),
    Object.assign(new Error("impostor"), { name: "StrictJsonError", failure: "duplicate-key" }),
  ]) {
    const original = String.prototype.startsWith;
    const patched = mock.method(
      String.prototype,
      "startsWith",
      function (this: string, ...args: Parameters<typeof original>) {
        if (String(this) === source) {
          throw failure;
        }
        return Reflect.apply(original, this, args) as boolean;
      },
    );
    try {
      assert.throws(
        () => parseJsonRecord(source),
        (error: unknown) => error === failure,
      );
    } finally {
      patched.mock.restore();
    }
  }
});

test("the real managed-profile loader reports strict JSON diagnostics before schema interpretation", async () => {
  for (const [source, detail] of [
    ['{"schemaVersion":4,"schemaVersion":4}', "must not contain duplicate keys."],
    ['{"schemaVersion":}', "must contain valid JSON."],
    ["[]", "must be one JSON object."],
  ]) {
    await assert.rejects(() => loadUnselectedManagedProfileV4(source), {
      name: "ConsumerJsonInputError",
      message: `Managed profile v4 ${detail}`,
    });
  }
});
