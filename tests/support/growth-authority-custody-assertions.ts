import assert from "node:assert/strict";

import type { GrowthAuthorityFixturePorts } from "./growth-authority-test-ports.ts";
import {
  growthAuthorityRequestDigest,
  growthAuthorityGrantDigest,
} from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/validate-growth-authority.js";
import { normalizeGrowthObservation } from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/normalize-growth-observation.js";

export function assertClosedGrantRequest(fixtures: GrowthAuthorityFixturePorts) {
  const { request, grant, validateGrowthAuthorityGrant, fingerprint, now } = fixtures;

  const req = request(),
    value = validateGrowthAuthorityGrant(grant(req), req, fingerprint, now);
  assert.equal(value.requestDigest, growthAuthorityRequestDigest(req, fingerprint));
  assert.equal(
    growthAuthorityGrantDigest(structuredClone(value), fingerprint),
    growthAuthorityGrantDigest(value, fingerprint),
  );
}

export function assertLinearPackageMembership(fixtures: GrowthAuthorityFixturePorts) {
  const { d, observation } = fixtures;

  const measured = [100, 200, 400].map((size) => {
    let reads = 0;
    const countPackageName = {
      get(target: object, property: string | symbol, receiver: unknown): unknown {
        if (property === "packageName") {
          reads += 1;
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return value;
      },
    };
    const surface = observation("unused");
    surface.coverage = Array.from({ length: size }, (_, index) => {
      const packageName = `fixture-${String(index).padStart(4, "0")}`;
      return new Proxy<ReturnType<typeof observation>["coverage"][number]>(
        observation(packageName).coverage[0],
        countPackageName,
      );
    });
    surface.entries = Array.from({ length: size }, (_, index) => {
      const packageName = `fixture-${String(index).padStart(4, "0")}`;
      return {
        coordinate: new Proxy<ReturnType<typeof observation>["entries"][number]["coordinate"]>(
          {
            packageName,
            exportPath: ".",
            resolutionBranch: [],
            subject: { kind: "package" },
          },
          countPackageName,
        ),
        value: { state: "present", digest: d("a") },
      };
    });
    assert.equal(normalizeGrowthObservation(surface).entries.length, size);
    return { size, reads };
  });
  assert.ok(
    measured.every(({ size, reads }) => reads <= size * 6),
    JSON.stringify(measured),
  );
  assert.deepEqual(
    measured.map(({ size, reads }) => reads / size),
    [5, 5, 5],
  );
}

export function assertDistinctArchiveIdentity(fixtures: GrowthAuthorityFixturePorts) {
  const {
    request,
    grant,
    validateGrowthAuthorityGrant,
    fingerprint,
    now,
    observation,
    packed,
    initialPackage,
    sealEvidence,
  } = fixtures;

  const req = request(),
    value = grant(req);
  initialPackage(value, req, "fixture", "archive-one");
  sealEvidence(value, req);
  const first = validateGrowthAuthorityGrant(value, req, fingerprint, now);
  const changed = structuredClone(value);
  changed.candidates[0] = packed("fixture", "0.0.0", observation("fixture"), "archive-two");
  assert.throws(
    () => validateGrowthAuthorityGrant(changed, req, fingerprint, now),
    /evidence-manifest-mismatch/,
  );
  const changedRequest = structuredClone(req);
  sealEvidence(changed, changedRequest);
  const second = validateGrowthAuthorityGrant(changed, changedRequest, fingerprint, now);
  assert.notEqual(first.candidates[0].archiveDigest, second.candidates[0].archiveDigest);
  assert.equal(first.candidates[0].observationDigest, second.candidates[0].observationDigest);
}

export function assertForgedArchiveCustody(fixtures: GrowthAuthorityFixturePorts) {
  const {
    request,
    grant,
    validateGrowthAuthorityGrant,
    fingerprint,
    now,
    d,
    initialPackage,
    releasedPackage,
    sealEvidence,
  } = fixtures;

  for (const kind of ["released", "initial"]) {
    const req = request(),
      value = grant(req);
    if (kind === "released") {
      releasedPackage(value, req);
    } else {
      initialPackage(value, req);
    }
    sealEvidence(value, req);
    value.candidates[0].installedDistribution.archiveDigest = d("f");
    assert.throws(
      () => validateGrowthAuthorityGrant(value, req, fingerprint, now),
      /growth-authority-installed-distribution-mismatch/,
    );
  }
}

export function assertCustodyManifestBinding(fixtures: GrowthAuthorityFixturePorts) {
  const {
    request,
    grant,
    validateGrowthAuthorityGrant,
    fingerprint,
    now,
    d,
    initialPackage,
    sealEvidence,
  } = fixtures;

  const req = request(),
    value = grant(req);
  initialPackage(value, req, "fixture", "archive-one");
  sealEvidence(value, req);
  assert.doesNotThrow(() => validateGrowthAuthorityGrant(value, req, fingerprint, now));
  const inventoryMismatch = structuredClone(value);
  inventoryMismatch.candidates[0].custodyEvidence.installedFiles[0].digest = d("f");
  assert.throws(
    () => validateGrowthAuthorityGrant(inventoryMismatch, req, fingerprint, now),
    /growth-authority-custody-manifest-mismatch/,
  );
  const archiveSubstitution = structuredClone(value);
  archiveSubstitution.candidates[0].custodyEvidence.archiveDigest =
    archiveSubstitution.candidates[0].archiveDigest === d("f") ? d("e") : d("f");
  assert.throws(
    () => validateGrowthAuthorityGrant(archiveSubstitution, req, fingerprint, now),
    /growth-authority-(?:custody-inventory|archive-digest)-mismatch/,
  );
}

export function assertCanonicalCustodyPaths(fixtures: GrowthAuthorityFixturePorts) {
  const {
    request,
    grant,
    validateGrowthAuthorityGrant,
    fingerprint,
    now,
    d,
    initialPackage,
    sealEvidence,
  } = fixtures;

  const req = request(),
    value = grant(req);
  initialPackage(value, req, "fixture", "archive-one");
  sealEvidence(value, req);
  const duplicate = structuredClone(value);
  duplicate.candidates[0].custodyEvidence.installedFiles.push({
    path: "package.json",
    digest: d("1"),
  });
  duplicate.candidates[0].custodyEvidence.archiveManifest.push({
    path: "package.json",
    digest: d("1"),
  });
  assert.throws(
    () => validateGrowthAuthorityGrant(duplicate, req, fingerprint, now),
    /custody-duplicate-path/,
  );
  const ambiguous = structuredClone(value);
  ambiguous.candidates[0].custodyEvidence.installedFiles[0].path = "./package.json";
  assert.throws(
    () => validateGrowthAuthorityGrant(ambiguous, req, fingerprint, now),
    /path-invalid/,
  );
}

export function assertReleasedArchiveIdentity(fixtures: GrowthAuthorityFixturePorts) {
  const {
    request,
    grant,
    validateGrowthAuthorityGrant,
    fingerprint,
    now,
    releasedPackage,
    sealEvidence,
  } = fixtures;

  const req = request(),
    value = grant(req);
  releasedPackage(value, req);
  sealEvidence(value, req);
  assert.doesNotThrow(() => validateGrowthAuthorityGrant(value, req, fingerprint, now));
  const forged = structuredClone(value);
  forged.archives[0] = structuredClone(forged.candidates[0]);
  assert.throws(
    () => validateGrowthAuthorityGrant(forged, req, fingerprint, now),
    /growth-authority-(?:archive-version|archive-observation)-mismatch/,
  );
}

export function assertPackedCollectionUniqueness(fixtures: GrowthAuthorityFixturePorts) {
  const {
    request,
    grant,
    validateGrowthAuthorityGrant,
    fingerprint,
    now,
    initialPackage,
    sealEvidence,
  } = fixtures;

  const duplicateRequest = request(),
    duplicate = grant(duplicateRequest);
  initialPackage(duplicate, duplicateRequest);
  duplicate.candidates.push(structuredClone(duplicate.candidates[0]));
  duplicate.requestDigest = growthAuthorityRequestDigest(duplicateRequest, fingerprint);
  assert.throws(
    () => validateGrowthAuthorityGrant(duplicate, duplicateRequest, fingerprint, now),
    /growth-authority-candidate-duplicate/,
  );

  const req = request(),
    value = grant(req);
  for (let index = 0; index < 1_000; index += 1) {
    initialPackage(value, req, `fixture-${index}`);
  }
  req.contextSelectors.released = req.contextSelectors.released.toSorted((a, b) =>
    a.packageName.localeCompare(b.packageName),
  );
  value.released = value.released.toSorted((a, b) => a.packageName.localeCompare(b.packageName));
  value.candidates = value.candidates.toSorted((a, b) =>
    a.packageName.localeCompare(b.packageName),
  );
  sealEvidence(value, req);
  assert.equal(validateGrowthAuthorityGrant(value, req, fingerprint, now).candidates.length, 1_000);
}

export function assertMalformedAuthorityCollections(fixtures: GrowthAuthorityFixturePorts): void {
  const { request, grant, validateGrowthAuthorityGrant, fingerprint, now } = fixtures;

  for (const field of ["released", "ownerEvidence", "archives", "candidates"]) {
    for (const malformed of [null, 1, "row", true]) {
      const req = request(),
        value = grant(req);
      Reflect.set(value, field, [malformed]);
      assert.throws(
        () => validateGrowthAuthorityGrant(value, req, fingerprint, now),
        (error) =>
          error !== null &&
          typeof error === "object" &&
          "name" in error &&
          error.name === "GrowthObservationInvariantError" &&
          "reason" in error &&
          typeof error.reason === "string",
        `${field}:${String(malformed)}`,
      );
    }
  }
}
