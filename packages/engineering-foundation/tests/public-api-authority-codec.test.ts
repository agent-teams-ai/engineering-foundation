import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeRequest,
  encodeGrant,
} from "../dist/capabilities/public-api-compatibility/adapters/inbound/authority/growth-authority-tooling-codec.js";

// The public codec boundary must reject executable carriers before invoking
// any producer-controlled getter, Proxy trap or typed-array property override.
test("authority codec rejects executable object carriers without invoking them", () => {
  let calls = 0;
  const accessor = Object.defineProperty({}, "schemaVersion", {
    enumerable: true,
    get() {
      calls++;
      throw new Error("getter ran");
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        calls++;
        throw new Error("proxy ran");
      },
    },
  );
  for (const input of [accessor, proxy]) {
    assert.throws(() => decodeRequest(input), { reason: "growth-authority-tooling-input-unsafe" });
  }
  assert.equal(calls, 0);
});

test("authority codec rejects shadowed binary metadata and unsafe options without invoking them", () => {
  let calls = 0;
  const bytes = new Uint8Array([123, 125]);
  Object.defineProperty(bytes, "byteLength", {
    get() {
      calls++;
      return 2;
    },
  });
  assert.throws(() => decodeRequest(bytes), { reason: "growth-authority-tooling-input-unsafe" });
  const options: { readonly request: unknown; readonly now: Date } = {
    request: undefined,
    now: new Date(0),
  };
  Object.defineProperty(options, "request", {
    enumerable: true,
    get() {
      calls++;
      throw new Error("getter ran");
    },
  });
  assert.throws(() => encodeGrant({}, options), {
    reason: "growth-authority-tooling-options-unsafe",
  });
  assert.equal(calls, 0);
});

test("authority codec retains duplicate-key rejection for both text and binary transports", () => {
  const text = '{"schemaVersion":1,"schemaVersion":1}';
  for (const input of [text, new TextEncoder().encode(text), Buffer.from(text)]) {
    assert.throws(() => decodeRequest(input), /invalid strict JSON: duplicate-key/u);
  }
});
