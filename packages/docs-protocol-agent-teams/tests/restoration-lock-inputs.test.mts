import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  type JsonObject,
  key,
  manifest,
  lock,
  type Entry,
  checksum,
  tar,
  digest,
  makePacket,
  run,
  actualTarHeaders,
  retainedInputPacket,
  registerMalformedArchiveCases,
} from "./restoration-lock-input-fixture.ts";
function admitOriginalClosure(original: JsonObject) {
  const packet = makePacket({ original: JSON.stringify(original) });
  return run({
    bytes: { ...packet.bytes, archives: {} },
    bindings: { ...packet.bindings, archives: {} },
  });
}

test("retained three pinned documents and twelve actual SRI archives", async (t) => {
  const { fixture, bindings, original, source, actual, archiveEntries, packet } =
    await retainedInputPacket();
  const result = run(packet);
  const o = result.original.tree,
    closure = o.pnpmLock as JsonObject;
  assert.equal(o.packageCount, 83);
  assert.ok(Array.isArray(o.coordinates));
  assert.equal(o.coordinates.length, 5);
  assert.equal(Object.keys(closure.packages as JsonObject).length, 83);
  assert.equal(Object.keys(closure.snapshots as JsonObject).length, 83);
  for (const value of o.coordinates) {
    const row = value as JsonObject,
      entry = (closure.packages as JsonObject)[`${row.name}@${row.version}`] as JsonObject;
    assert.equal((entry.resolution as JsonObject).integrity, row.integrity);
  }
  assert.equal(Object.keys(result.archives).length, 12);
  for (const row of fixture.archives) {
    const archive = result.archives[row.coordinate];
    assert.ok(archive);
    assert.equal(archive.integrity, row.integrity);
    assert.equal(`${archive.manifest.name}@${archive.manifest.version}`, row.coordinate);
  }
  assert.deepEqual(Buffer.from(result.original.bytes), original);
  assert.deepEqual(Buffer.from(result.source.bytes), source);
  assert.deepEqual(Buffer.from(result.actual.bytes), actual);

  const nodeCoordinate = "@types/node@24.13.3";
  const nodeRow = fixture.archives.find((row) => row.coordinate === nodeCoordinate);
  const nodeEntry = archiveEntries.find(([coordinate]) => coordinate === nodeCoordinate);
  const nodePin = bindings.archives[nodeCoordinate];
  assert.ok(nodeRow && nodeEntry && nodePin);
  const nodeCompressed = nodeEntry[1];
  const nodeTar = gunzipSync(nodeCompressed, { maxOutputLength: 32 * 1024 * 1024 });

  await t.test("authenticated actual node archive has the observed star-layout time fields", () => {
    assert.equal(digest(nodeCompressed), nodePin.sha256);
    assert.equal(
      "sha512-" + createHash("sha512").update(nodeCompressed).digest("base64"),
      nodeRow.integrity,
    );
    const extended = actualTarHeaders(nodeTar).filter(
      ({ header }) =>
        header.subarray(345, 476).includes(0) &&
        header.subarray(476, 500).some((byte) => byte !== 0),
    );
    assert.equal(extended.length, 88);
    assert.equal(extended[0]?.offset, 0);
    assert.equal(extended[1]?.offset, 512);
    for (const { header } of extended) {
      assert.ok(header.subarray(257, 263).equals(Buffer.from("ustar\0")));
      assert.ok(header.subarray(263, 265).equals(Buffer.from("00")));
      const prefix = header.subarray(345, 476),
        end = prefix.indexOf(0);
      assert.ok(end >= 0);
      assert.ok(prefix.subarray(end).every((byte) => byte === 0));
      assert.match(header.subarray(476, 488).toString("latin1"), /^[0-7]{11}\0$/);
      assert.match(header.subarray(488, 500).toString("latin1"), /^[0-7]{11}\0$/);
    }
    for (const offset of [0, 512]) {
      const header = nodeTar.subarray(offset, offset + 512);
      assert.equal(header.subarray(476, 488).toString("latin1"), "15223371221\0");
      assert.equal(header.subarray(488, 500).toString("latin1"), "15223371221\0");
      const name = header.subarray(0, 100);
      assert.equal(
        name.subarray(0, name.indexOf(0)).toString("utf8"),
        offset === 0 ? "node v24.13/" : "node v24.13/LICENSE",
      );
    }
  });

  await t.test(
    "changing the actual archive still requires compressed SHA and SRI authentication",
    () => {
      const malformed = Buffer.from(nodeTar);
      malformed[476] = 0x38;
      checksum(malformed.subarray(0, 512));
      const changed = gzipSync(malformed);
      const bytes = {
        ...packet.bytes,
        archives: { ...packet.bytes.archives, [nodeCoordinate]: changed },
      };
      assert.throws(() => run({ bytes, bindings }), /sha256 mismatch/);
      assert.throws(
        () =>
          run({
            bytes,
            bindings: {
              ...bindings,
              archives: {
                ...bindings.archives,
                [nodeCoordinate]: { ...nodePin, sha256: digest(changed) },
              },
            },
          }),
        /SRI mismatch/,
      );
    },
  );

  await registerMalformedArchiveCases(t, nodeTar, nodePin);
  assert.deepEqual(Buffer.from(result.original.bytes), original);
  assert.deepEqual(Buffer.from(result.source.bytes), source);
  assert.equal(digest(nodeCompressed), nodePin.sha256);
});

test("recursive declarations, scalar distinctions, own fields and immutable snapshots", () => {
  const packet = makePacket({ source: lock + 'extension:\n  list: [true, null, 3, ""]\n' });
  const original = Buffer.from(packet.bytes.original);
  const result = run(packet),
    tree = result.archives[key]?.manifest;
  assert.ok(tree);
  assert.deepEqual(tree.array, ["text", 7, false, null]);
  assert.equal(tree.empty, "");
  assert.equal(tree.nil, null);
  assert.ok(!Object.hasOwn(tree, "missing") && Object.hasOwn(tree, "__proto__"));
  assert.equal(Object.getPrototypeOf(tree), null);
  assert.equal(JSON.stringify(tree.extensions), '{"unknown":[{}]}');
  assert.equal(JSON.stringify(result.source.tree.extension), '{"list":[true,null,3,""]}');
  assert.ok(
    Object.isFrozen(tree) && Object.isFrozen(tree.array) && Object.isFrozen(result.original.bytes),
  );
  const caller = packet.bytes.original;
  assert.ok(caller instanceof Uint8Array);
  caller.fill(0);
  assert.deepEqual(Buffer.from(result.original.bytes), original);
  assert.equal(Reflect.set(tree, "version", "2.0.0"), false);
});
test("USTAR prefix contributes to the effective manifest path", () =>
  assert.doesNotThrow(() =>
    run(makePacket({ tar: tar([{ name: "package.json", prefix: "package", body: manifest }]) })),
  ));
test("full-width POSIX prefixes retain their effective names", () => {
  const stem = "package/" + "p".repeat(145);
  assert.doesNotThrow(() =>
    run(
      makePacket({
        tar: tar([
          { name: "README", prefix: stem + "/z" },
          { name: "package/package.json", body: manifest },
        ]),
      }),
    ),
  );
  assert.throws(
    () =>
      run(
        makePacket({
          tar: tar([
            { name: "README", prefix: stem + "/z" },
            { name: "z/README", prefix: stem },
            { name: "package/package.json", body: manifest },
          ]),
        }),
      ),
    /duplicate tar name/,
  );
});
test("compressed hash corruption rejects before archive inspection", () => {
  const packet = makePacket(),
    bytes = packet.bytes.archives[key];
  assert.ok(bytes);
  const corrupt = Buffer.from(bytes);
  corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] ?? 0) ^ 1;
  assert.throws(
    () => run({ ...packet, bytes: { ...packet.bytes, archives: { [key]: corrupt } } }),
    /sha256 mismatch/,
  );
});
test("SRI authentication, same-coordinate agreement and actual-lock independence", () => {
  const wrong = "sha512-" + createHash("sha512").update("different").digest("base64");
  assert.throws(() => run(makePacket({ sri: wrong })), /SRI mismatch/);
  assert.throws(
    () =>
      run(
        makePacket({
          source: "packages:\n  demo@1.0.0:\n    resolution:\n      integrity: " + wrong + "\n",
        }),
      ),
    /integrity disagreement/,
  );
  assert.doesNotThrow(() =>
    run(
      makePacket({
        actual: "packages:\n  demo@1.0.0:\n    resolution:\n      integrity: " + wrong + "\n",
      }),
    ),
  );
});
test("coordinate, manifest and selection bindings are exact; legacy labels are distinct", () => {
  const bad = Buffer.from('{"name":"other","version":"1.0.0"}');
  assert.throws(() => run(makePacket({ manifest: bad })), /manifest coordinate/);
  const packet = makePacket(),
    pin = packet.bindings.archives[key];
  assert.ok(pin);
  assert.throws(
    () =>
      run({
        ...packet,
        bindings: {
          ...packet.bindings,
          archives: { [key]: { ...pin, manifestSha256: "0".repeat(64) } },
        },
      }),
    /sha256 mismatch/,
  );
  assert.throws(
    () => run({ ...packet, bindings: { ...packet.bindings, archives: {} } }),
    /archive binding keys/,
  );
  const o = JSON.parse(Buffer.from(packet.bytes.original).toString("utf8")) as Record<
    string,
    unknown
  >;
  o.packageManager = "pnpm@11.18.0";
  assert.throws(() => run(makePacket({ original: JSON.stringify(o) })), /original package manager/);
  o.packageManager = "pnpm@11.20.0";
  o.packageCount = 0;
  o.coordinates = [];
  o.pnpmLock = { packages: {}, snapshots: {} };
  assert.throws(
    () =>
      run(
        makePacket({
          original: JSON.stringify(o),
          actual: "packages:\n  demo@1.0.0:\n    resolution:\n      integrity: ignored\n",
        }),
      ),
    /missing provenance resolution/,
  );
});

test("envelope counts the lock closure and validates claims without selected archives", () => {
  const o = run(makePacket()).original.tree,
    closure = o.pnpmLock as JsonObject;
  const packages = closure.packages as JsonObject,
    snapshots = closure.snapshots as JsonObject;
  assert.ok(Array.isArray(o.coordinates));
  const validatedCoordinates = o.coordinates;
  const row = validatedCoordinates[0] as JsonObject;
  assert.ok(row);
  const entry = packages[key];
  assert.ok(entry);
  const larger = {
    ...o,
    packageCount: 2,
    pnpmLock: {
      ...closure,
      packages: { ...packages, "extra@1.0.0": entry },
      snapshots: { ...snapshots, "extra@1.0.0": {} },
    },
  };
  assert.doesNotThrow(() => admitOriginalClosure(larger));
  for (const packageCount of [1, 3, -1, 2.5, "2"]) {
    assert.throws(
      () => admitOriginalClosure({ ...larger, packageCount }),
      /original package count/,
    );
  }
  assert.throws(
    () => admitOriginalClosure({ ...larger, pnpmLock: { ...larger.pnpmLock, snapshots } }),
    /original package count/,
  );
  assert.throws(
    () => admitOriginalClosure({ ...larger, pnpmLock: { ...larger.pnpmLock, packages } }),
    /original package count/,
  );
  assert.throws(
    () =>
      admitOriginalClosure({
        ...larger,
        coordinates: [...validatedCoordinates, ...validatedCoordinates],
      }),
    /duplicate coordinate/,
  );
  assert.throws(
    () => admitOriginalClosure({ ...larger, coordinates: [{ ...row, integrity: "different" }] }),
    /coordinate integrity disagreement/,
  );
  assert.throws(
    () => admitOriginalClosure({ ...larger, coordinates: [{ ...row, name: "missing" }] }),
    /coordinate integrity disagreement/,
  );
});

const tarCases: readonly [string, readonly Entry[], RegExp][] = [
  [
    "duplicate",
    [
      { name: "package/package.json", body: manifest },
      { name: "package/package.json", body: manifest },
    ],
    /duplicate tar name/,
  ],
  [
    "missing",
    [{ name: "package/README", body: Buffer.from("license retained") }],
    /missing manifest/,
  ],
  ["link", [{ name: "package/package.json", kind: "2" }], /tar member type/],
  ["traversal", [{ name: "package/../package.json", body: manifest }], /tar path/],
  ["absolute", [{ name: "/package/package.json", body: manifest }], /tar path/],
  ["dot", [{ name: "package/./package.json", body: manifest }], /tar path/],
  [
    "ambiguous root",
    [
      { name: "other/package.json", body: manifest },
      { name: "package/package.json", body: manifest },
    ],
    /archive root/,
  ],
  ["PAX", [{ name: "package/package.json", kind: "x" }], /tar member type/],
  ["GNU", [{ name: "package/package.json", body: manifest, magic: "ustar " }], /tar dialect/],
  ["directory manifest", [{ name: "package/package.json", kind: "5" }], /manifest regular/],
];
for (const [label, entries, error] of tarCases) {
  test("rejects " + label, () =>
    assert.throws(() => run(makePacket({ tar: tar(entries) })), error),
  );
}
test("checksum, base256, padding and end markers", () => {
  const base = tar([{ name: "package/package.json", body: manifest }]);
  const checksumBad = Buffer.from(base);
  checksumBad[100] = 49;
  assert.throws(() => run(makePacket({ tar: checksumBad })), /tar checksum/);
  const binary = Buffer.from(base);
  binary[124] = 128;
  checksum(binary.subarray(0, 512));
  assert.throws(() => run(makePacket({ tar: binary })), /base256/);
  const padding = Buffer.from(base);
  padding[512 + manifest.length] = 1;
  assert.throws(() => run(makePacket({ tar: padding })), /tar padding/);
  assert.throws(() => run(makePacket({ tar: base.subarray(0, base.length - 512) })), /tar end/);
});
test("duplicate JSON rejects recursively in documents and manifests", () => {
  assert.throws(() => run(makePacket({ original: '{"x":{"a":1,"a":2}}' })), /duplicate JSON key/);
  const duplicate = Buffer.from('{"name":"demo","version":"1.0.0","x":{"a":1,"a":2}}');
  assert.throws(() => run(makePacket({ manifest: duplicate })), /duplicate JSON key/);
});
for (const source of [
  "packages: {}\nx:\n  a: 1\n  a: 2\n",
  "packages: {}\nx: !unsupported value\n",
  "packages: {}\nx: &anchor {a: 1}\ny: *anchor\n",
  "packages: {}\nx: .nan\n",
  "packages: {}\nx: !!binary SGk=\n",
]) {
  test("YAML rejects " + source.trim(), () => assert.throws(() => run(makePacket({ source }))));
}
test("UTF8 and graph, depth, node, string and compressed bounds", () => {
  const packet = makePacket(),
    invalid = Buffer.from([0xc3, 0x28]);
  assert.throws(
    () =>
      run({
        bytes: { ...packet.bytes, original: invalid },
        bindings: { ...packet.bindings, originalClosureSha256: digest(invalid) },
      }),
    TypeError,
  );
  assert.throws(
    () =>
      run({ ...packet, bytes: { ...packet.bytes, original: Buffer.alloc(4 * 1024 * 1024 + 1) } }),
    /graph byte bound/,
  );
  const large = Buffer.alloc(3 * 1024 * 1024);
  assert.throws(
    () =>
      run({ ...packet, bytes: { ...packet.bytes, original: large, source: large, actual: large } }),
    /global graph byte bound/,
  );
  assert.throws(
    () => run(makePacket({ original: '{"x":'.repeat(66) + "null" + "}".repeat(66) })),
    /depth bound/,
  );
  assert.throws(
    () => run(makePacket({ original: '{"x":"' + "x".repeat(256 * 1024 + 1) + '"}' })),
    /string bound/,
  );
  assert.throws(
    () =>
      run(makePacket({ original: '{"x":[' + Array<string>(100_001).fill("0").join(",") + "]}" })),
    /tree bound/,
  );
  const deep =
    Array.from({ length: 70 }, (_, index) => " ".repeat(index * 2) + "x:").join("\n") +
    "\n" +
    " ".repeat(140) +
    "x: true\n";
  assert.throws(() => run(makePacket({ source: deep })), /(tree|YAML syntax) bound/);
  assert.throws(
    () =>
      run({
        ...packet,
        bytes: { ...packet.bytes, archives: { [key]: Buffer.alloc(8 * 1024 * 1024 + 1) } },
      }),
    /compressed byte bound/,
  );
});
test("unpacked, member and manifest bounds", () => {
  const oversized = Buffer.alloc(512 * 1024 + 1, 32);
  assert.throws(() => run(makePacket({ manifest: oversized })), /manifest byte bound/);
  const members = Array.from({ length: 8193 }, (_, index) => ({ name: "package/f" + index }));
  assert.throws(() => run(makePacket({ tar: tar(members) })), /tar member bound/);
  assert.throws(() => run(makePacket({ tar: Buffer.alloc(32 * 1024 * 1024 + 512) })), {
    code: "ERR_BUFFER_TOO_LARGE",
  });
});
