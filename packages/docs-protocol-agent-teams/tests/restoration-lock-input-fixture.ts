import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
const { admitRestorationLockInputs } = (await import(
  new URL("../dist/qualification/adapters/outbound/restoration-lock-inputs.js", import.meta.url)
    .href
)) as typeof import("../src/qualification/adapters/outbound/restoration-lock-inputs.js");
type RestorationInputBytes = Parameters<typeof admitRestorationLockInputs>[0];
type RestorationInputBindings = Parameters<typeof admitRestorationLockInputs>[1];
export type ArchiveInputBinding = RestorationInputBindings["archives"][string];
export type JsonObject = ReturnType<typeof admitRestorationLockInputs>["original"]["tree"];

export const key = "demo@1.0.0";
export const manifest = Buffer.from(
  '{"name":"demo","version":"1.0.0","array":["text",7,false,null],"empty":"","nil":null,"extensions":{"unknown":[{}]},"__proto__":{"safe":true}}',
);
export const lock = 'lockfileVersion: "9.0"\npackages: {}\n';
export type Packet = { bytes: RestorationInputBytes; bindings: RestorationInputBindings };
export interface Entry {
  name: string;
  body?: Buffer;
  prefix?: string;
  kind?: string;
  magic?: string;
}
export function checksum(header: Buffer): void {
  header.fill(32, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
}
export function tar(entries: readonly Entry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512),
      body = entry.body ?? Buffer.alloc(0);
    header.write(entry.name, 0, "utf8");
    header.write("0000644\0", 100, "ascii");
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
    header.write(entry.kind ?? "0", 156, "ascii");
    if (entry.kind === "2") {
      header.write("target", 157, "ascii");
    }
    header.write(entry.magic ?? "ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    if (entry.prefix) {
      header.write(entry.prefix, 345, "utf8");
    }
    checksum(header);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
export function digest(bytes: Readonly<Uint8Array>): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function makePacket(
  options: {
    tar?: Buffer;
    manifest?: Buffer;
    original?: string;
    source?: string;
    actual?: string;
    sri?: string;
  } = {},
): Packet {
  const compressed = gzipSync(
    options.tar ?? tar([{ name: "package/package.json", body: options.manifest ?? manifest }]),
  );
  const integrity =
    options.sri ?? "sha512-" + createHash("sha512").update(compressed).digest("base64");
  const original = Buffer.from(
    options.original ??
      JSON.stringify({
        domain: "agent-teams.docs-runtime-closure/v2",
        schemaVersion: 2,
        packageManager: "pnpm@11.20.0",
        packageCount: 1,
        coordinates: [{ name: "demo", version: "1.0.0", role: "direct", integrity }],
        managedEdges: [],
        pnpmLock: { packages: { [key]: { resolution: { integrity } } }, snapshots: { [key]: {} } },
      }),
  );
  const source = Buffer.from(options.source ?? lock),
    actual = Buffer.from(options.actual ?? lock);
  return {
    bytes: { original, source, actual, archives: { [key]: compressed } },
    bindings: {
      originalClosureSha256: digest(original),
      sourceLockSha256: digest(source),
      actualLockSha256: digest(actual),
      sourceLockBlob: createHash("sha1")
        .update(`blob ${source.length}\0`)
        .update(source)
        .digest("hex"),
      archives: {
        [key]: {
          sha256: digest(compressed),
          manifestSha256: digest(options.manifest ?? manifest),
          manifestPath: "package/package.json",
        },
      },
    },
  } satisfies Packet;
}
export function run(packet: Packet) {
  return admitRestorationLockInputs(packet.bytes, packet.bindings);
}

export function actualTarHeaders(data: Buffer): readonly { offset: number; header: Buffer }[] {
  assert.equal(data.length % 512, 0);
  const headers: { offset: number; header: Buffer }[] = [];
  let offset = 0;
  while (offset < data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      assert.ok(data.length - offset >= 1024);
      assert.ok(data.subarray(offset).every((byte) => byte === 0));
      return headers;
    }
    const sizeField = header.subarray(124, 136).toString("latin1");
    assert.match(sizeField, /^ *[0-7]*[\0 ]*$/);
    const digits = sizeField.replace(/[\0 ]/g, "");
    const size = digits === "" ? 0 : Number.parseInt(digits, 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0);
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    assert.ok(next <= data.length);
    headers.push({ offset, header });
    offset = next;
  }
  assert.fail("missing actual tar end");
}

// Malformed-archive tests get fresh documents and matching authentication
// bindings so rejection must reach tar admission. Retained fixture pins stay intact.
function nodeVariantPacket(compressed: Buffer, pin: ArchiveInputBinding): Packet {
  const coordinate = "@types/node@24.13.3";
  const integrity = "sha512-" + createHash("sha512").update(compressed).digest("base64");
  const original = Buffer.from(
    JSON.stringify({
      domain: "agent-teams.docs-runtime-closure/v2",
      schemaVersion: 2,
      packageManager: "pnpm@11.20.0",
      packageCount: 1,
      coordinates: [{ name: "@types/node", version: "24.13.3", role: "transitive", integrity }],
      managedEdges: [],
      pnpmLock: {
        packages: { [coordinate]: { resolution: { integrity } } },
        snapshots: { [coordinate]: {} },
      },
    }),
  );
  const source = Buffer.from(
    'lockfileVersion: "9.0"\npackages:\n  "@types/node@24.13.3":\n    resolution:\n      integrity: ' +
      integrity +
      "\n",
  );
  const actual = Buffer.from(lock);
  return {
    bytes: { original, source, actual, archives: { [coordinate]: compressed } },
    bindings: {
      originalClosureSha256: digest(original),
      sourceLockSha256: digest(source),
      actualLockSha256: digest(actual),
      sourceLockBlob: createHash("sha1")
        .update(`blob ${source.length}\0`)
        .update(source)
        .digest("hex"),
      archives: { [coordinate]: { ...pin, sha256: digest(compressed) } },
    },
  };
}

interface Fixture {
  schemaVersion: 1;
  original: { file: string; sha256: string };
  source: { file: string; sha256: string; gitBlob: string };
  actual: { file: string; sha256: string };
  archives: readonly (ArchiveInputBinding & {
    coordinate: string;
    file: string;
    integrity: string;
  })[];
}
export async function retainedInputPacket() {
  const root = new URL("./fixtures/restoration-lock-v1/", import.meta.url);
  const fixture = JSON.parse(await readFile(new URL("manifest.json", root), "utf8")) as Fixture;
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.archives.length, 12);
  const bindings: RestorationInputBindings = {
    originalClosureSha256: "87cb5e3495848f453c1ac0e4dc8caa7d66828f0cab270cefd46d73dee2ea341a",
    sourceLockSha256: "83a30e0d504b90ded54cfbf1b1c7a7bcdd4d78950876cf0d7dd352983c628916",
    sourceLockBlob: "56b39f74f7c0e4e311b970aea1ea719caac61358",
    actualLockSha256: "d35092ff74098bfdf9a95cb9a5534ff7ee0aa828e9a5eba9e4114baf167c3332",
    archives: Object.fromEntries(
      fixture.archives.map((row) => [
        row.coordinate,
        { sha256: row.sha256, manifestSha256: row.manifestSha256, manifestPath: row.manifestPath },
      ]),
    ),
  };
  assert.equal(fixture.original.sha256, bindings.originalClosureSha256);
  assert.equal(fixture.source.sha256, bindings.sourceLockSha256);
  assert.equal(fixture.source.gitBlob, bindings.sourceLockBlob);
  assert.equal(fixture.actual.sha256, bindings.actualLockSha256);
  const [original, source, actual] = await Promise.all(
    [fixture.original, fixture.source, fixture.actual].map((row) =>
      readFile(new URL(row.file, root)),
    ),
  );
  assert.ok(original && source && actual);
  const archiveEntries = await Promise.all(
    fixture.archives.map(
      async (row) => [row.coordinate, await readFile(new URL(row.file, root))] as const,
    ),
  );
  const packet: Packet = {
    bytes: { original, source, actual, archives: Object.fromEntries(archiveEntries) },
    bindings,
  };
  return { fixture, bindings, original, source, actual, archiveEntries, packet };
}

export async function registerMalformedArchiveCases(
  t: import("node:test").TestContext,
  nodeTar: Buffer,
  nodePin: ArchiveInputBinding,
): Promise<void> {
  await t.test(
    "malformed actual-header variants reject after matching authentication bindings",
    async (variants) => {
      const cases: readonly {
        label: string;
        offset: number;
        value: number;
        error: RegExp;
        repairChecksum: boolean;
      }[] = [
        {
          label: "non-octal atime",
          offset: 476,
          value: 0x38,
          error: /tar octal/,
          repairChecksum: true,
        },
        {
          label: "non-octal ctime",
          offset: 488,
          value: 0x38,
          error: /tar octal/,
          repairChecksum: true,
        },
        {
          label: "base256 atime",
          offset: 476,
          value: 0x80,
          error: /base256 tar number/,
          repairChecksum: true,
        },
        {
          label: "digits after atime NUL",
          offset: 477,
          value: 0,
          error: /tar octal/,
          repairChecksum: true,
        },
        {
          label: "digits after ctime NUL",
          offset: 489,
          value: 0,
          error: /tar octal/,
          repairChecksum: true,
        },
        {
          label: "atime lacks canonical NUL terminator",
          offset: 487,
          value: 32,
          error: /tar extended time/,
          repairChecksum: true,
        },
        {
          label: "ctime lacks canonical NUL terminator",
          offset: 499,
          value: 32,
          error: /tar extended time/,
          repairChecksum: true,
        },
        {
          label: "garbage inside 131-byte prefix padding",
          offset: 475,
          value: 0x31,
          error: /tar string padding/,
          repairChecksum: true,
        },
        {
          label: "time mutation without checksum repair",
          offset: 488,
          value: 0x32,
          error: /tar checksum/,
          repairChecksum: false,
        },
      ];
      for (const variant of cases) {
        await variants.test(variant.label, () => {
          const malformed = Buffer.from(nodeTar);
          malformed[variant.offset] = variant.value;
          if (variant.repairChecksum) {
            checksum(malformed.subarray(0, 512));
          }
          assert.throws(() => run(nodeVariantPacket(gzipSync(malformed), nodePin)), variant.error);
        });
      }
    },
  );
}
