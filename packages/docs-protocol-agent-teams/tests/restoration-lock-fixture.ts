import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseDocument, type Document } from "yaml";
import {
  type ManagedRestorationArchiveBindingV1,
  type ManagedRestorationLockV1Request,
  type ManagedRestorationLockV1Result,
} from "../dist/qualification/index.js";
interface Fixture {
  readonly schemaVersion: 1;
  readonly original: { readonly file: string; readonly sha256: string };
  readonly source: { readonly file: string; readonly sha256: string; readonly gitBlob: string };
  readonly actual: { readonly file: string; readonly sha256: string };
  readonly archives: readonly (ManagedRestorationArchiveBindingV1 & {
    readonly coordinate: string;
    readonly file: string;
    readonly integrity: string;
  })[];
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function assertFixture(value: unknown): asserts value is Fixture {
  assert.ok(record(value));
  assert.equal(value.schemaVersion, 1);
  for (const field of ["original", "source", "actual"]) {
    const row = value[field];
    assert.ok(record(row));
    assert.ok(typeof row.file === "string" && typeof row.sha256 === "string");
    if (field === "source") {
      assert.ok(typeof row.gitBlob === "string");
    }
  }
  assert.ok(Array.isArray(value.archives));
  assert.equal(value.archives.length, 12);
  for (const row of value.archives) {
    assert.ok(record(row));
    for (const field of [
      "coordinate",
      "file",
      "integrity",
      "sha256",
      "manifestSha256",
      "manifestPath",
    ]) {
      assert.ok(typeof row[field] === "string");
    }
  }
}
export function digest(bytes: Readonly<Uint8Array>): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map((item: unknown) => canonical(item)).join(",") + "]";
  }
  if (record(value)) {
    return (
      "{" +
      Object.keys(value)
        .toSorted()
        .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
        .join(",") +
      "}"
    );
  }
  assert.ok(
    value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value)),
  );
  const encoded = JSON.stringify(value);
  assert.ok(typeof encoded === "string");
  return encoded;
}
export async function retained(): Promise<ManagedRestorationLockV1Request> {
  const root = new URL("./fixtures/restoration-lock-v1/", import.meta.url);
  const fixture: unknown = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
  assertFixture(fixture);
  assert.equal(
    fixture.original.sha256,
    "87cb5e3495848f453c1ac0e4dc8caa7d66828f0cab270cefd46d73dee2ea341a",
  );
  assert.equal(
    fixture.source.sha256,
    "83a30e0d504b90ded54cfbf1b1c7a7bcdd4d78950876cf0d7dd352983c628916",
  );
  assert.equal(fixture.source.gitBlob, "56b39f74f7c0e4e311b970aea1ea719caac61358");
  assert.equal(
    fixture.actual.sha256,
    "d35092ff74098bfdf9a95cb9a5534ff7ee0aa828e9a5eba9e4114baf167c3332",
  );
  const [original, source, actual] = await Promise.all(
    [fixture.original, fixture.source, fixture.actual].map((row) =>
      readFile(new URL(row.file, root)),
    ),
  );
  assert.ok(original && source && actual);
  assert.equal(digest(actual), fixture.actual.sha256);
  const archives = await Promise.all(
    fixture.archives.map(
      async (row) => [row.coordinate, await readFile(new URL(row.file, root))] as const,
    ),
  );
  return {
    schemaVersion: 1,
    originalClosureBytes: original,
    sourceLockBytes: source,
    actualLockBytes: actual,
    archiveBytes: Object.fromEntries(archives),
    selection: {
      originalClosureSha256: fixture.original.sha256,
      sourceLockSha256: fixture.source.sha256,
      sourceLockBlob: fixture.source.gitBlob,
      archives: Object.fromEntries(
        fixture.archives.map((row) => [
          row.coordinate,
          {
            sha256: row.sha256,
            manifestSha256: row.manifestSha256,
            manifestPath: row.manifestPath,
          },
        ]),
      ),
    },
  };
}
export function editActual(
  request: ManagedRestorationLockV1Request,
  edit: (document: Document) => void,
): ManagedRestorationLockV1Request {
  const document = parseDocument(Buffer.from(request.actualLockBytes).toString("utf8"));
  edit(document);
  return { ...request, actualLockBytes: Buffer.from(document.toString()) };
}
export function withSource(
  request: ManagedRestorationLockV1Request,
  source: Buffer,
): ManagedRestorationLockV1Request {
  return {
    ...request,
    sourceLockBytes: source,
    selection: {
      ...request.selection,
      sourceLockSha256: digest(source),
      sourceLockBlob: createHash("sha1")
        .update(`blob ${source.length}\0`)
        .update(source)
        .digest("hex"),
    },
  };
}
export function accepted(result: ManagedRestorationLockV1Result) {
  assert.equal(result.conformance, "conformant", JSON.stringify(result.diagnostics));
  assert.ok(result.conformance === "conformant");
  return result;
}
export const contextOracle = [
  "@agent-teams/engineering-foundation@1.4.0",
  "@microsoft/api-extractor@7.58.12",
  "@microsoft/api-extractor-model@7.33.10",
  "@rushstack/node-core-library@5.23.3",
  "@rushstack/problem-matcher@0.2.1",
  "@rushstack/terminal@0.24.2",
  "@rushstack/ts-command-line@5.3.12",
]
  .map((id) => id + "(@types/node@24.13.3)")
  .toSorted();
const foundation = "@agent-teams/engineering-foundation@1.4.0(@types/node@24.13.3)";
export const core = "@rushstack/node-core-library@5.23.3(@types/node@24.13.3)";
const terminal = "@rushstack/terminal@0.24.2(@types/node@24.13.3)";

export const mutations: readonly [string, (document: Document) => void][] = [
  [
    "wrong types",
    (d) => d.setIn(["snapshots", core, "optionalDependencies", "@types/node"], "24.19.1"),
  ],
  [
    "hard node edge",
    (d) => {
      d.deleteIn(["snapshots", core, "optionalDependencies"]);
      d.setIn(["snapshots", core, "dependencies", "@types/node"], "24.13.3");
    },
  ],
  [
    "wrong undici",
    (d) => d.setIn(["snapshots", "@types/node@24.13.3", "dependencies", "undici-types"], "7.18.3"),
  ],
  [
    "doubled suffix",
    (d) =>
      d.setIn(
        ["snapshots", foundation, "dependencies", "@microsoft/api-extractor"],
        "7.58.12(@types/node@24.13.3)(@types/node@24.13.3)",
      ),
  ],
  [
    "suffix outside C",
    (d) =>
      d.setIn(
        ["snapshots", "@agent-teams/docs-protocol@0.6.0", "dependencies", "minisearch"],
        "7.2.0(@types/node@24.13.3)",
      ),
  ],
  [
    "missing ancestor suffix",
    (d) =>
      d.setIn(
        ["snapshots", foundation, "dependencies", "@microsoft/api-extractor-model"],
        "7.33.10",
      ),
  ],
  ["dual node snapshot", (d) => d.setIn(["snapshots", "@rushstack/terminal@0.24.2"], {})],
  [
    "dual formats snapshot",
    (d) =>
      d.setIn(["snapshots", "ajv-formats@3.0.1(ajv@8.20.0)"], {
        optionalDependencies: { ajv: "8.20.0" },
      }),
  ],
  [
    "collision replacement",
    (d) => {
      d.deleteIn(["snapshots", terminal]);
      d.setIn(["snapshots", "@rushstack/terminal@0.24.2"], {});
    },
  ],
  [
    "dangling edge",
    (d) => d.setIn(["snapshots", terminal, "dependencies", "supports-color"], "999.0.0"),
  ],
  [
    "third borrowed edge",
    (d) => d.setIn(["snapshots", foundation, "dependencies", "@noble/hashes"], "2.4.0"),
  ],
  ["foreign field", (d) => d.setIn(["packages", "@noble/hashes@2.4.0", "engines", "node"], ">=26")],
  [
    "foreign mode",
    (d) => d.setIn(["packages", "@oxlint/binding-darwin-arm64@1.80.0", "cpu"], ["x64"]),
  ],
  ["shared yaml", (d) => d.setIn(["packages", "yaml@2.9.0", "hasBin"], false)],
  [
    "stale Source coordinate",
    (d) => {
      d.setIn(["packages", "@agent-teams/repository-mutation@0.2.2"], {
        resolution: { integrity: "stale" },
      });
      d.setIn(["snapshots", "@agent-teams/repository-mutation@0.2.2"], {});
    },
  ],
  [
    "formats wrong AJV",
    (d) => d.setIn(["snapshots", "ajv-formats@3.0.1", "dependencies", "ajv"], "8.18.0"),
  ],
  [
    "formats optional AJV",
    (d) => {
      d.deleteIn(["snapshots", "ajv-formats@3.0.1", "dependencies"]);
      d.setIn(["snapshots", "ajv-formats@3.0.1", "optionalDependencies"], { ajv: "8.20.0" });
    },
  ],
  [
    "formats peer metadata",
    (d) =>
      d.setIn(["packages", "ajv-formats@3.0.1", "peerDependenciesMeta"], {
        ajv: { optional: true },
      }),
  ],
  [
    "draft04 peer",
    (d) =>
      d.setIn(
        ["snapshots", "ajv-draft-04@1.0.0(ajv@8.20.0)", "optionalDependencies", "ajv"],
        "8.18.0",
      ),
  ],
  ["parent missing AJV", (d) => d.deleteIn(["snapshots", core, "dependencies", "ajv"])],
  ["duplicate AJV context", (d) => d.setIn(["snapshots", "ajv@8.20.0(ajv@8.18.0)"], {})],
  [
    "tsdoc AJV collapsed",
    (d) =>
      d.setIn(["snapshots", "@microsoft/tsdoc-config@0.18.2", "dependencies", "ajv"], "8.20.0"),
  ],
  [
    "removed AJV818",
    (d) => {
      d.deleteIn(["packages", "ajv@8.18.0"]);
      d.deleteIn(["snapshots", "ajv@8.18.0"]);
    },
  ],
  [
    "SRI changed",
    (d) => d.setIn(["packages", "ajv@8.20.0", "resolution", "integrity"], "sha512-changed"),
  ],
  ["catalog changed", (d) => d.setIn(["catalogs", "default", "@types/node", "version"], "24.19.1")],
  ["options changed", (d) => d.setIn(["settings", "autoInstallPeers"], true)],
  [
    "foreign importer changed",
    (d) =>
      d.setIn(
        ["importers", "packages/contexts/supply", "dependencies", "yaml", "specifier"],
        "2.9.0",
      ),
  ],
  [
    "managed importer changed",
    (d) =>
      d.setIn(
        ["importers", ".", "devDependencies", "@agent-teams/docs-protocol", "specifier"],
        "^0.6.0",
      ),
  ],
  [
    "managed root section moved",
    (d) => {
      d.deleteIn(["importers", ".", "devDependencies", "@agent-teams/docs-protocol"]);
      d.setIn(["importers", ".", "dependencies", "@agent-teams/docs-protocol"], {
        specifier: "0.6.0",
        version: "0.6.0",
      });
    },
  ],
  [
    "unknown nested field",
    (d) =>
      d.setIn(["packages", "ajv@8.20.0", "resolution", "extension"], { nested: [null, false] }),
  ],
  ["numeric coercion", (d) => d.setIn(["lockfileVersion"], 9)],
  [
    "absent to null",
    (d) => d.setIn(["snapshots", "@agent-teams/repository-mutation@0.2.0", "dependencies"], null),
  ],
  [
    "absent to empty",
    (d) => d.setIn(["snapshots", "@agent-teams/repository-mutation@0.2.0", "dependencies"], {}),
  ],
  ["empty to scalar", (d) => d.setIn(["snapshots", "@agent-teams/repository-mutation@0.2.0"], "")],
];
