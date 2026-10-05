import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { admitRestorationLockInputs } from '../../../packages/docs-protocol-agent-teams/dist/qualification/adapters/outbound/restoration-lock-inputs.js';
import type { ArchiveInputBinding, JsonObject, RestorationInputBindings, RestorationInputBytes } from '../../../packages/docs-protocol-agent-teams/dist/qualification/application/model/restoration-lock-inputs.js';

const key = 'demo@1.0.0';
const manifest = Buffer.from('{"name":"demo","version":"1.0.0","array":["text",7,false,null],"empty":"","nil":null,"extensions":{"unknown":[{}]},"__proto__":{"safe":true}}');
const lock = 'lockfileVersion: "9.0"\npackages: {}\n';
type Packet = { bytes: RestorationInputBytes; bindings: RestorationInputBindings };
interface Entry { name: string; body?: Buffer; prefix?: string; kind?: string; magic?: string; }
function checksum(header: Buffer): void {
  header.fill(32, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
}
function tar(entries: readonly Entry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512), body = entry.body ?? Buffer.alloc(0);
    header.write(entry.name, 0, 'utf8');
    header.write('0000644\0', 100, 'ascii');
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    header.write(entry.kind ?? '0', 156, 'ascii');
    if (entry.kind === '2') {header.write('target', 157, 'ascii');}
    header.write(entry.magic ?? 'ustar\0', 257, 'ascii'); header.write('00', 263, 'ascii');
    if (entry.prefix) {header.write(entry.prefix, 345, 'utf8');}
    checksum(header);
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
function digest(bytes: Readonly<Uint8Array>): string { return createHash('sha256').update(bytes).digest('hex'); }
function makePacket(options: { tar?: Buffer; manifest?: Buffer; original?: string; source?: string; actual?: string; sri?: string } = {}): Packet {
  const compressed = gzipSync(options.tar ?? tar([{ name: 'package/package.json', body: options.manifest ?? manifest }]));
  const integrity = options.sri ?? 'sha512-' + createHash('sha512').update(compressed).digest('base64');
  const original = Buffer.from(options.original ?? JSON.stringify({
    domain: 'agent-teams.docs-runtime-closure/v2', schemaVersion: 2, packageManager: 'pnpm@11.20.0', packageCount: 1,
    coordinates: [{ name: 'demo', version: '1.0.0', role: 'direct', integrity }], managedEdges: [],
    pnpmLock: { packages: { [key]: { resolution: { integrity } } }, snapshots: { [key]: {} } },
  }));
  const source = Buffer.from(options.source ?? lock), actual = Buffer.from(options.actual ?? lock);
  return {
    bytes: { original, source, actual, archives: { [key]: compressed } },
    bindings: {
      originalClosureSha256: digest(original), sourceLockSha256: digest(source), actualLockSha256: digest(actual),
      sourceLockBlob: createHash('sha1').update(`blob ${source.length}\0`).update(source).digest('hex'),
      archives: { [key]: { sha256: digest(compressed), manifestSha256: digest(options.manifest ?? manifest), manifestPath: 'package/package.json' } },
    },
  } satisfies Packet;
}
function run(packet: Packet) { return admitRestorationLockInputs(packet.bytes, packet.bindings); }

function actualTarHeaders(data: Buffer): readonly { offset: number; header: Buffer }[] {
  assert.equal(data.length % 512, 0);
  const headers: { offset: number; header: Buffer }[] = [];
  let offset = 0;
  while (offset < data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      assert.ok(data.length - offset >= 1024);
      assert.ok(data.subarray(offset).every(byte => byte === 0));
      return headers;
    }
    const sizeField = header.subarray(124, 136).toString('latin1');
    assert.match(sizeField, /^ *[0-7]*[\0 ]*$/);
    const digits = sizeField.replace(/[\0 ]/g, '');
    const size = digits === '' ? 0 : Number.parseInt(digits, 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0);
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    assert.ok(next <= data.length);
    headers.push({ offset, header });
    offset = next;
  }
  assert.fail('missing actual tar end');
}

// Malformed-archive tests get fresh documents and matching authentication
// bindings so rejection must reach tar admission. Retained fixture pins stay intact.
function nodeVariantPacket(compressed: Buffer, pin: ArchiveInputBinding): Packet {
  const coordinate = '@types/node@24.13.3';
  const integrity = 'sha512-' + createHash('sha512').update(compressed).digest('base64');
  const original = Buffer.from(JSON.stringify({
    domain: 'agent-teams.docs-runtime-closure/v2', schemaVersion: 2,
    packageManager: 'pnpm@11.20.0', packageCount: 1,
    coordinates: [{ name: '@types/node', version: '24.13.3', role: 'transitive', integrity }],
    managedEdges: [],
    pnpmLock: {
      packages: { [coordinate]: { resolution: { integrity } } },
      snapshots: { [coordinate]: {} },
    },
  }));
  const source = Buffer.from('lockfileVersion: "9.0"\npackages:\n  "@types/node@24.13.3":\n    resolution:\n      integrity: ' + integrity + '\n');
  const actual = Buffer.from(lock);
  return {
    bytes: { original, source, actual, archives: { [coordinate]: compressed } },
    bindings: {
      originalClosureSha256: digest(original), sourceLockSha256: digest(source),
      actualLockSha256: digest(actual),
      sourceLockBlob: createHash('sha1').update(`blob ${source.length}\0`).update(source).digest('hex'),
      archives: { [coordinate]: { ...pin, sha256: digest(compressed) } },
    },
  };
}

interface Fixture {
  schemaVersion: 1;
  original: { file: string; sha256: string };
  source: { file: string; sha256: string; gitBlob: string };
  actual: { file: string; sha256: string };
  archives: readonly (ArchiveInputBinding & { coordinate: string; file: string; integrity: string })[];
}
test('retained three pinned documents and twelve actual SRI archives', async t => {
  const root = new URL('../../../packages/docs-protocol-agent-teams/tests/fixtures/restoration-lock-v1/', import.meta.url);
  const fixture = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8')) as Fixture;
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.archives.length, 12);
  const bindings: RestorationInputBindings = {
    originalClosureSha256: '87cb5e3495848f453c1ac0e4dc8caa7d66828f0cab270cefd46d73dee2ea341a',
    sourceLockSha256: '83a30e0d504b90ded54cfbf1b1c7a7bcdd4d78950876cf0d7dd352983c628916',
    sourceLockBlob: '56b39f74f7c0e4e311b970aea1ea719caac61358',
    actualLockSha256: 'd35092ff74098bfdf9a95cb9a5534ff7ee0aa828e9a5eba9e4114baf167c3332',
    archives: Object.fromEntries(fixture.archives.map(row => [row.coordinate, { sha256: row.sha256, manifestSha256: row.manifestSha256, manifestPath: row.manifestPath }])),
  };
  assert.equal(fixture.original.sha256, bindings.originalClosureSha256);
  assert.equal(fixture.source.sha256, bindings.sourceLockSha256);
  assert.equal(fixture.source.gitBlob, bindings.sourceLockBlob);
  assert.equal(fixture.actual.sha256, bindings.actualLockSha256);
  const [original, source, actual] = await Promise.all([fixture.original, fixture.source, fixture.actual].map(row => readFile(new URL(row.file, root))));
  assert.ok(original && source && actual);
  const archiveEntries = await Promise.all(fixture.archives.map(async row => [row.coordinate, await readFile(new URL(row.file, root))] as const));
  const packet: Packet = { bytes: { original, source, actual, archives: Object.fromEntries(archiveEntries) }, bindings };
  const result = run(packet);
  const o = result.original.tree, closure = o.pnpmLock as JsonObject;
  assert.equal(o.packageCount, 83);
  assert.ok(Array.isArray(o.coordinates)); assert.equal(o.coordinates.length, 5);
  assert.equal(Object.keys(closure.packages as JsonObject).length, 83);
  assert.equal(Object.keys(closure.snapshots as JsonObject).length, 83);
  for (const value of o.coordinates) {
    const row = value as JsonObject, entry = (closure.packages as JsonObject)[`${row.name}@${row.version}`] as JsonObject;
    assert.equal((entry.resolution as JsonObject).integrity, row.integrity);
  }
  assert.equal(Object.keys(result.archives).length, 12);
  for (const row of fixture.archives) {
    const archive = result.archives[row.coordinate]; assert.ok(archive);
    assert.equal(archive.integrity, row.integrity);
    assert.equal(`${archive.manifest.name}@${archive.manifest.version}`, row.coordinate);
  }
  assert.deepEqual(Buffer.from(result.original.bytes), original);
  assert.deepEqual(Buffer.from(result.source.bytes), source);
  assert.deepEqual(Buffer.from(result.actual.bytes), actual);

  const nodeCoordinate = '@types/node@24.13.3';
  const nodeRow = fixture.archives.find(row => row.coordinate === nodeCoordinate);
  const nodeEntry = archiveEntries.find(([coordinate]) => coordinate === nodeCoordinate);
  const nodePin = bindings.archives[nodeCoordinate];
  assert.ok(nodeRow && nodeEntry && nodePin);
  const nodeCompressed = nodeEntry[1];
  const nodeTar = gunzipSync(nodeCompressed, { maxOutputLength: 32 * 1024 * 1024 });

  await t.test('authenticated actual node archive has the observed star-layout time fields', () => {
    assert.equal(digest(nodeCompressed), nodePin.sha256);
    assert.equal('sha512-' + createHash('sha512').update(nodeCompressed).digest('base64'), nodeRow.integrity);
    const extended = actualTarHeaders(nodeTar).filter(({ header }) =>
      header.subarray(345, 476).includes(0) && header.subarray(476, 500).some(byte => byte !== 0));
    assert.equal(extended.length, 88);
    assert.equal(extended[0]?.offset, 0);
    assert.equal(extended[1]?.offset, 512);
    for (const { header } of extended) {
      assert.ok(header.subarray(257, 263).equals(Buffer.from('ustar\0')));
      assert.ok(header.subarray(263, 265).equals(Buffer.from('00')));
      const prefix = header.subarray(345, 476), end = prefix.indexOf(0);
      assert.ok(end >= 0);
      assert.ok(prefix.subarray(end).every(byte => byte === 0));
      assert.match(header.subarray(476, 488).toString('latin1'), /^[0-7]{11}\0$/);
      assert.match(header.subarray(488, 500).toString('latin1'), /^[0-7]{11}\0$/);
    }
    for (const offset of [0, 512]) {
      const header = nodeTar.subarray(offset, offset + 512);
      assert.equal(header.subarray(476, 488).toString('latin1'), '15223371221\0');
      assert.equal(header.subarray(488, 500).toString('latin1'), '15223371221\0');
      const name = header.subarray(0, 100);
      assert.equal(name.subarray(0, name.indexOf(0)).toString('utf8'),
        offset === 0 ? 'node v24.13/' : 'node v24.13/LICENSE');
    }
  });

  await t.test('changing the actual archive still requires compressed SHA and SRI authentication', () => {
    const malformed = Buffer.from(nodeTar);
    malformed[476] = 0x38;
    checksum(malformed.subarray(0, 512));
    const changed = gzipSync(malformed);
    const bytes = { ...packet.bytes, archives: { ...packet.bytes.archives, [nodeCoordinate]: changed } };
    assert.throws(() => run({ bytes, bindings }), /sha256 mismatch/);
    assert.throws(() => run({ bytes, bindings: {
      ...bindings,
      archives: { ...bindings.archives, [nodeCoordinate]: { ...nodePin, sha256: digest(changed) } },
    } }), /SRI mismatch/);
  });

  await t.test('malformed actual-header variants reject after matching authentication bindings', async variants => {
    const cases: readonly {
      label: string; offset: number; value: number; error: RegExp; repairChecksum: boolean;
    }[] = [
      { label: 'non-octal atime', offset: 476, value: 0x38, error: /tar octal/, repairChecksum: true },
      { label: 'non-octal ctime', offset: 488, value: 0x38, error: /tar octal/, repairChecksum: true },
      { label: 'base256 atime', offset: 476, value: 0x80, error: /base256 tar number/, repairChecksum: true },
      { label: 'digits after atime NUL', offset: 477, value: 0, error: /tar octal/, repairChecksum: true },
      { label: 'digits after ctime NUL', offset: 489, value: 0, error: /tar octal/, repairChecksum: true },
      { label: 'atime lacks canonical NUL terminator', offset: 487, value: 32, error: /tar extended time/, repairChecksum: true },
      { label: 'ctime lacks canonical NUL terminator', offset: 499, value: 32, error: /tar extended time/, repairChecksum: true },
      { label: 'garbage inside 131-byte prefix padding', offset: 475, value: 0x31, error: /tar string padding/, repairChecksum: true },
      { label: 'time mutation without checksum repair', offset: 488, value: 0x32, error: /tar checksum/, repairChecksum: false },
    ];
    for (const variant of cases) {
      await variants.test(variant.label, () => {
        const malformed = Buffer.from(nodeTar);
        malformed[variant.offset] = variant.value;
        if (variant.repairChecksum) {checksum(malformed.subarray(0, 512));}
        assert.throws(() => run(nodeVariantPacket(gzipSync(malformed), nodePin)), variant.error);
      });
    }
  });
  assert.deepEqual(Buffer.from(result.original.bytes), original);
  assert.deepEqual(Buffer.from(result.source.bytes), source);
  assert.equal(digest(nodeCompressed), nodePin.sha256);
});

test('recursive declarations, scalar distinctions, own fields and immutable snapshots', () => {
  const packet = makePacket({ source: lock + 'extension:\n  list: [true, null, 3, ""]\n' });
  const original = Buffer.from(packet.bytes.original);
  const result = run(packet), tree = result.archives[key]?.manifest; assert.ok(tree);
  assert.deepEqual(tree.array, ['text', 7, false, null]);
  assert.equal(tree.empty, ''); assert.equal(tree.nil, null);
  assert.ok(!Object.hasOwn(tree, 'missing') && Object.hasOwn(tree, '__proto__'));
  assert.equal(Object.getPrototypeOf(tree), null);
  assert.equal(JSON.stringify(tree.extensions), '{"unknown":[{}]}');
  assert.equal(JSON.stringify(result.source.tree.extension), '{"list":[true,null,3,""]}');
  assert.ok(Object.isFrozen(tree) && Object.isFrozen(tree.array) && Object.isFrozen(result.original.bytes));
  const caller = packet.bytes.original; assert.ok(caller instanceof Uint8Array); caller.fill(0);
  assert.deepEqual(Buffer.from(result.original.bytes), original);
  assert.equal(Reflect.set(tree, 'version', '2.0.0'), false);
});
test('USTAR prefix contributes to the effective manifest path', () => assert.doesNotThrow(() => run(makePacket({ tar: tar([{ name: 'package.json', prefix: 'package', body: manifest }]) }))));
test('full-width POSIX prefixes retain their effective names', () => {
  const stem = 'package/' + 'p'.repeat(145);
  assert.doesNotThrow(() => run(makePacket({ tar: tar([
    { name: 'README', prefix: stem + '/z' },
    { name: 'package/package.json', body: manifest },
  ]) })));
  assert.throws(() => run(makePacket({ tar: tar([
    { name: 'README', prefix: stem + '/z' },
    { name: 'z/README', prefix: stem },
    { name: 'package/package.json', body: manifest },
  ]) })), /duplicate tar name/);
});
test('compressed hash corruption rejects before archive inspection', () => {
  const packet = makePacket(), bytes = packet.bytes.archives[key]; assert.ok(bytes);
  const corrupt = Buffer.from(bytes); corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] ?? 0) ^ 1;
  assert.throws(() => run({ ...packet, bytes: { ...packet.bytes, archives: { [key]: corrupt } } }), /sha256 mismatch/);
});
test('SRI authentication, same-coordinate agreement and actual-lock independence', () => {
  const wrong = 'sha512-' + createHash('sha512').update('different').digest('base64');
  assert.throws(() => run(makePacket({ sri: wrong })), /SRI mismatch/);
  assert.throws(() => run(makePacket({ source: 'packages:\n  demo@1.0.0:\n    resolution:\n      integrity: ' + wrong + '\n' })), /integrity disagreement/);
  assert.doesNotThrow(() => run(makePacket({ actual: 'packages:\n  demo@1.0.0:\n    resolution:\n      integrity: ' + wrong + '\n' })));
});
test('coordinate, manifest and selection bindings are exact; legacy labels are distinct', () => {
  const bad = Buffer.from('{"name":"other","version":"1.0.0"}');
  assert.throws(() => run(makePacket({ manifest: bad })), /manifest coordinate/);
  const packet = makePacket(), pin = packet.bindings.archives[key]; assert.ok(pin);
  assert.throws(() => run({ ...packet, bindings: { ...packet.bindings, archives: { [key]: { ...pin, manifestSha256: '0'.repeat(64) } } } }), /sha256 mismatch/);
  assert.throws(() => run({ ...packet, bindings: { ...packet.bindings, archives: {} } }), /archive binding keys/);
  const o = JSON.parse(Buffer.from(packet.bytes.original).toString('utf8')) as Record<string, unknown>;
  o.packageManager = 'pnpm@11.18.0';
  assert.throws(() => run(makePacket({ original: JSON.stringify(o) })), /original package manager/);
  o.packageManager = 'pnpm@11.20.0'; o.packageCount = 0; o.coordinates = [];
  o.pnpmLock = { packages: {}, snapshots: {} };
  assert.throws(() => run(makePacket({ original: JSON.stringify(o), actual: 'packages:\n  demo@1.0.0:\n    resolution:\n      integrity: ignored\n' })), /missing provenance resolution/);
});

test('envelope counts the lock closure and validates claims without selected archives', () => {
  const o = run(makePacket()).original.tree, closure = o.pnpmLock as JsonObject;
  const packages = closure.packages as JsonObject, snapshots = closure.snapshots as JsonObject;
  assert.ok(Array.isArray(o.coordinates));
  const validatedCoordinates = o.coordinates;
  const row = validatedCoordinates[0] as JsonObject; assert.ok(row);
  const entry = packages[key]; assert.ok(entry);
  const larger = { ...o, packageCount: 2, pnpmLock: { ...closure,
    packages: { ...packages, 'extra@1.0.0': entry },
    snapshots: { ...snapshots, 'extra@1.0.0': {} } } };
  const admit = (original: JsonObject) => {
    const packet = makePacket({ original: JSON.stringify(original) });
    return run({ bytes: { ...packet.bytes, archives: {} }, bindings: { ...packet.bindings, archives: {} } });
  };
  assert.doesNotThrow(() => admit(larger));
  for (const packageCount of [1, 3, -1, 2.5, '2']) {
    assert.throws(() => admit({ ...larger, packageCount }), /original package count/);
  }
  assert.throws(() => admit({ ...larger, pnpmLock: { ...larger.pnpmLock, snapshots } }), /original package count/);
  assert.throws(() => admit({ ...larger, pnpmLock: { ...larger.pnpmLock, packages } }), /original package count/);
  assert.throws(() => admit({ ...larger, coordinates: [...validatedCoordinates, ...validatedCoordinates] }), /duplicate coordinate/);
  assert.throws(() => admit({ ...larger, coordinates: [{ ...row, integrity: 'different' }] }), /coordinate integrity disagreement/);
  assert.throws(() => admit({ ...larger, coordinates: [{ ...row, name: 'missing' }] }), /coordinate integrity disagreement/);
});

const tarCases: readonly [string, readonly Entry[], RegExp][] = [
  ['duplicate', [{ name: 'package/package.json', body: manifest }, { name: 'package/package.json', body: manifest }], /duplicate tar name/],
  ['missing', [{ name: 'package/README', body: Buffer.from('license retained') }], /missing manifest/],
  ['link', [{ name: 'package/package.json', kind: '2' }], /tar member type/],
  ['traversal', [{ name: 'package/../package.json', body: manifest }], /tar path/],
  ['absolute', [{ name: '/package/package.json', body: manifest }], /tar path/],
  ['dot', [{ name: 'package/./package.json', body: manifest }], /tar path/],
  ['ambiguous root', [{ name: 'other/package.json', body: manifest }, { name: 'package/package.json', body: manifest }], /archive root/],
  ['PAX', [{ name: 'package/package.json', kind: 'x' }], /tar member type/],
  ['GNU', [{ name: 'package/package.json', body: manifest, magic: 'ustar ' }], /tar dialect/],
  ['directory manifest', [{ name: 'package/package.json', kind: '5' }], /manifest regular/],
];
for (const [label, entries, error] of tarCases) {test('rejects ' + label, () => assert.throws(() => run(makePacket({ tar: tar(entries) })), error));}
test('checksum, base256, padding and end markers', () => {
  const base = tar([{ name: 'package/package.json', body: manifest }]);
  const checksumBad = Buffer.from(base); checksumBad[100] = 49;
  assert.throws(() => run(makePacket({ tar: checksumBad })), /tar checksum/);
  const binary = Buffer.from(base); binary[124] = 128; checksum(binary.subarray(0, 512));
  assert.throws(() => run(makePacket({ tar: binary })), /base256/);
  const padding = Buffer.from(base); padding[512 + manifest.length] = 1;
  assert.throws(() => run(makePacket({ tar: padding })), /tar padding/);
  assert.throws(() => run(makePacket({ tar: base.subarray(0, base.length - 512) })), /tar end/);
});
test('duplicate JSON rejects recursively in documents and manifests', () => {
  assert.throws(() => run(makePacket({ original: '{"x":{"a":1,"a":2}}' })), /duplicate JSON key/);
  const duplicate = Buffer.from('{"name":"demo","version":"1.0.0","x":{"a":1,"a":2}}');
  assert.throws(() => run(makePacket({ manifest: duplicate })), /duplicate JSON key/);
});
for (const source of [
  'packages: {}\nx:\n  a: 1\n  a: 2\n',
  'packages: {}\nx: !unsupported value\n',
  'packages: {}\nx: &anchor {a: 1}\ny: *anchor\n',
  'packages: {}\nx: .nan\n',
  'packages: {}\nx: !!binary SGk=\n',
]) {test('YAML rejects ' + source.trim(), () => assert.throws(() => run(makePacket({ source }))));}
test('UTF8 and graph, depth, node, string and compressed bounds', () => {
  const packet = makePacket(), invalid = Buffer.from([0xc3, 0x28]);
  assert.throws(() => run({ bytes: { ...packet.bytes, original: invalid }, bindings: { ...packet.bindings, originalClosureSha256: digest(invalid) } }), TypeError);
  assert.throws(() => run({ ...packet, bytes: { ...packet.bytes, original: Buffer.alloc(4 * 1024 * 1024 + 1) } }), /graph byte bound/);
  const large = Buffer.alloc(3 * 1024 * 1024);
  assert.throws(() => run({ ...packet, bytes: { ...packet.bytes, original: large, source: large, actual: large } }), /global graph byte bound/);
  assert.throws(() => run(makePacket({ original: '{"x":'.repeat(66) + 'null' + '}'.repeat(66) })), /depth bound/);
  assert.throws(() => run(makePacket({ original: '{"x":"' + 'x'.repeat(256 * 1024 + 1) + '"}' })), /string bound/);
  assert.throws(() => run(makePacket({ original: '{"x":[' + Array<string>(100_001).fill('0').join(',') + ']}' })), /tree bound/);
  const deep = Array.from({ length: 70 }, (_, index) => ' '.repeat(index * 2) + 'x:').join('\n') + '\n' + ' '.repeat(140) + 'x: true\n';
  assert.throws(() => run(makePacket({ source: deep })), /(tree|YAML syntax) bound/);
  assert.throws(() => run({ ...packet, bytes: { ...packet.bytes, archives: { [key]: Buffer.alloc(8 * 1024 * 1024 + 1) } } }), /compressed byte bound/);
});
test('unpacked, member and manifest bounds', () => {
  const oversized = Buffer.alloc(512 * 1024 + 1, 32);
  assert.throws(() => run(makePacket({ manifest: oversized })), /manifest byte bound/);
  const members = Array.from({ length: 8193 }, (_, index) => ({ name: 'package/f' + index }));
  assert.throws(() => run(makePacket({ tar: tar(members) })), /tar member bound/);
  assert.throws(() => run(makePacket({ tar: Buffer.alloc(32 * 1024 * 1024 + 512) })), { code: 'ERR_BUFFER_TOO_LARGE' });
});
