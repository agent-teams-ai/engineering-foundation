import assert from "node:assert/strict";
import test from "node:test";

import type { PublicApiSnapshot } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/public-api.js";
import type {
  GrowthAuthorityFixturePorts,
  DraftGrant,
  MutableFixture,
} from "./support/growth-authority-test-ports.ts";
function setSnapshot(value: DraftGrant, branch: string, snapshot: unknown): void {
  Reflect.set(value.released[0].evidence, branch, snapshot);
}
type SnapshotFixturePorts = GrowthAuthorityFixturePorts & {
  authoritySnapshot(this: void): MutableFixture<PublicApiSnapshot>;
};
const snapshotLocations = ["root", "entrypoints", "entrypoint", "items", "item"];
function snapshotAt(
  authoritySnapshot: SnapshotFixturePorts["authoritySnapshot"],
  location: string,
  wrap: (target: object) => unknown,
): unknown {
  const item = {
    canonicalReference: "A",
    kind: "Function",
    parentKind: "EntryPoint",
    signature: "A",
  };
  const entrypoint: { exportPath: string; items: unknown } = {
    exportPath: ".",
    items: location === "item" ? [wrap(item)] : [item],
  };
  if (location === "items") {
    const items = entrypoint.items;
    assert.ok(items !== null && typeof items === "object");
    entrypoint.items = wrap(items);
  }
  const value: { entrypoints: unknown } = authoritySnapshot();
  value.entrypoints = location === "entrypoint" ? [wrap(entrypoint)] : [entrypoint];
  if (location === "entrypoints") {
    const entrypoints = value.entrypoints;
    assert.ok(entrypoints !== null && typeof entrypoints === "object");
    value.entrypoints = wrap(entrypoints);
  }
  return location === "root" ? wrap(value) : value;
}
function snapshotInvariant(error: unknown) {
  return (
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "GrowthObservationInvariantError" &&
    "reason" in error &&
    error.reason === "growth-authority-release-snapshot-invalid"
  );
}

function registerReleasedSnapshotCase1(fixtures: SnapshotFixturePorts) {
  const {
    request,
    grant,
    releasedPackage,
    sealEvidence,
    validateGrowthAuthorityGrant,
    fingerprint,
    now,
    authoritySnapshot,
  } = fixtures;
  void test("released typed and artifact snapshots reject malformed shapes and accessors with one invariant", () => {
    let getterCalls = 0;
    const malformed = [
      () => null,
      () => 1,
      () => "snapshot",
      () => [],
      () => {
        const value = authoritySnapshot();
        Object.defineProperty(value, "packageVersion", {
          enumerable: true,
          get() {
            getterCalls += 1;
            throw new TypeError("snapshot getter executed");
          },
        });
        return value;
      },
    ];
    for (const branch of ["typed", "artifact"]) {
      for (const makeMalformed of malformed) {
        const req = request(),
          value = grant(req);
        releasedPackage(value, req);
        sealEvidence(value, req);
        setSnapshot(value, branch, makeMalformed());
        assert.throws(
          () => validateGrowthAuthorityGrant(value, req, fingerprint, now),
          snapshotInvariant,
          branch,
        );
      }
    }
    assert.equal(getterCalls, 0);
  });
}

function registerReleasedSnapshotCase2(fixtures: SnapshotFixturePorts) {
  const {
    request,
    grant,
    releasedPackage,
    sealEvidence,
    validateGrowthAuthorityGrant,
    fingerprint,
    now,
    authoritySnapshot,
  } = fixtures;
  void test("released typed and artifact snapshots reject proxies before every reflective trap", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const branch of ["typed", "artifact"]) {
      for (const location of snapshotLocations) {
        let trapCalls = 0;
        const hostile = snapshotAt(
          authoritySnapshot,
          location,
          (target) =>
            new Proxy(target, {
              get() {
                trapCalls += 1;
                const opaqueFailure: unknown = revoked.proxy;
                throw opaqueFailure;
              },
              getOwnPropertyDescriptor() {
                trapCalls += 1;
                const opaqueFailure: unknown = revoked.proxy;
                throw opaqueFailure;
              },
              getPrototypeOf() {
                trapCalls += 1;
                const opaqueFailure: unknown = revoked.proxy;
                throw opaqueFailure;
              },
              ownKeys() {
                trapCalls += 1;
                const opaqueFailure: unknown = revoked.proxy;
                throw opaqueFailure;
              },
            }),
        );
        const req = request(),
          value = grant(req);
        releasedPackage(value, req);
        sealEvidence(value, req);
        setSnapshot(value, branch, hostile);
        assert.throws(
          () => validateGrowthAuthorityGrant(value, req, fingerprint, now),
          snapshotInvariant,
          `${branch}:${location}`,
        );
        assert.equal(trapCalls, 0, `${branch}:${location}`);
      }
    }
  });
}

function registerReleasedSnapshotCase3(fixtures: SnapshotFixturePorts) {
  const {
    request,
    grant,
    releasedPackage,
    sealEvidence,
    validateGrowthAuthorityGrant,
    fingerprint,
    now,
    authoritySnapshot,
  } = fixtures;
  void test("released typed and artifact snapshots reject revoked proxies with the stable invariant", () => {
    for (const branch of ["typed", "artifact"]) {
      for (const location of snapshotLocations) {
        const hostile = snapshotAt(authoritySnapshot, location, (target) => {
          const revocable = Proxy.revocable(target, {});
          revocable.revoke();
          return revocable.proxy;
        });
        const req = request(),
          value = grant(req);
        releasedPackage(value, req);
        sealEvidence(value, req);
        setSnapshot(value, branch, hostile);
        assert.throws(
          () => validateGrowthAuthorityGrant(value, req, fingerprint, now),
          snapshotInvariant,
          `${branch}:${location}`,
        );
      }
    }
  });
}

function registerReleasedSnapshotCase4(fixtures: SnapshotFixturePorts) {
  const {
    request,
    grant,
    releasedPackage,
    sealEvidence,
    validateGrowthAuthorityGrant,
    fingerprint,
    now,
    authoritySnapshot,
  } = fixtures;
  void test("released typed and artifact signatures match the schema boundaries exactly", () => {
    for (const branch of ["typed", "artifact"]) {
      for (const length of [0, 4096, 4097, 10_000, 10_001]) {
        const req = request(),
          value = grant(req);
        releasedPackage(value, req);
        sealEvidence(value, req);
        setSnapshot(
          value,
          branch,
          snapshotAt(authoritySnapshot, "item", (item) => ({
            ...item,
            signature: "x".repeat(length),
          })),
        );
        if (length <= 10_000) {
          assert.doesNotThrow(
            () => validateGrowthAuthorityGrant(value, req, fingerprint, now),
            `${branch}:${length}`,
          );
        } else {
          assert.throws(
            () => validateGrowthAuthorityGrant(value, req, fingerprint, now),
            snapshotInvariant,
            `${branch}:${length}`,
          );
        }
      }
    }
  });
}

export function registerReleasedSnapshotCases(fixtures: SnapshotFixturePorts): void {
  registerReleasedSnapshotCase1(fixtures);
  registerReleasedSnapshotCase2(fixtures);
  registerReleasedSnapshotCase3(fixtures);
  registerReleasedSnapshotCase4(fixtures);
}
