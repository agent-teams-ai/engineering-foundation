import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runCommand, runNpmCommand } from "./pack-test-support.mjs";
import {
  archiveIdentity,
  canonicalCustody,
  digest,
  installedFiles,
  jsonRecord,
  jsonString,
} from "./packed-sdk-growth-authority-fixture-values.ts";
import type { FixtureInput } from "./packed-sdk-growth-authority-fixture-values.ts";
import type {
  GrowthAuthorityMetadataRoot,
  GrowthAuthorityPackedEvidence,
  GrowthCoverage,
  GrowthDigest,
  GrowthSurfaceObservation,
} from "../packages/engineering-foundation/dist/sdk-growth-authority.js";
/** A deliberately closed test observer: exact known bytes prove this fixture's
 * one declaration, one runtime export, no imports/bins, and one data member.
 * It never executes package code and makes no general archive-support claim. */
export async function observeClosedFixture(
  observation: GrowthSurfaceObservation,
  archivePath: string,
): Promise<GrowthSurfaceObservation> {
  const extracted = await mkdtemp(join(dirname(archivePath), "closed-observer-"));
  await runCommand("tar", ["-xzf", archivePath, "-C", extracted], extracted);
  const files = await installedFiles(join(extracted, "package"));
  const contents = new Map(
    files.map((row) => [row.path, Buffer.from(row.contentHex, "hex").toString("utf8")]),
  );
  const manifest = jsonRecord(JSON.parse(jsonString(contents.get("package.json"))));
  assert.ok(["1.0.0", "1.1.0"].includes(jsonString(manifest.version)));
  const added = jsonString(manifest.version) === "1.1.0";
  assert.deepEqual(
    files.map((row) => row.path),
    [
      ...(added ? ["dist/data/extra.txt"] : []),
      "dist/data/fixture.txt",
      "dist/index.d.ts",
      "dist/index.js",
      "package.json",
    ],
  );
  assert.equal(
    contents.get("dist/index.js"),
    "export function stable(value) { return value; }\n" +
      (added ? "export function added(value) { return value; }\n" : ""),
  );
  assert.equal(
    contents.get("dist/index.d.ts"),
    "export declare function stable(value: string): string;\n" +
      (added ? "export declare function added(value: string): string;\n" : ""),
  );
  assert.equal(contents.get("dist/data/fixture.txt"), "disposable packed artifact\n");
  if (added) {
    assert.equal(contents.get("dist/data/extra.txt"), "additional disposable artifact\n");
  }
  assert.equal(manifest.bin, undefined);
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(manifest.exports, {
    ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    "./data/*": "./dist/data/*",
  });
  const entries = observation.entries.filter((row) => row.coordinate.packageName === manifest.name);
  for (const [exportPath, target] of Object.entries(
    manifest.exports as Record<string, string | Record<string, string>>,
  )) {
    const tree =
      typeof target === "string"
        ? { kind: "target", target }
        : {
            kind: "conditions",
            entries: Object.entries(target).map(([condition, value]) => ({
              condition,
              value: { kind: "target", target: value },
            })),
          };
    const branch = entries.find(
      (row) =>
        row.coordinate.exportPath === exportPath && row.coordinate.subject.kind === "export-branch",
    );
    assert.deepEqual(
      branch?.value,
      { state: "present", digest: digest(tree) },
      "Archive export order must match its own observation.",
    );
  }
  assert.equal(
    entries.filter((row) => row.coordinate.subject.kind === "typed").length,
    added ? 2 : 1,
  );
  assert.equal(
    entries.filter((row) => row.coordinate.subject.kind === "wildcard-member").length,
    added ? 2 : 1,
  );
  assert.equal(observation.coverage.filter((row) => row.packageName === manifest.name).length, 1);
  return {
    ...observation,
    coverage: observation.coverage.map((row) =>
      row.packageName !== manifest.name
        ? row
        : {
            ...row,
            dimensions: row.dimensions.map((dimension) => ({
              dimension: dimension.dimension,
              status: dimension.dimension === "decision" ? "unavailable" : "complete",
              reasons: [
                dimension.dimension === "decision"
                  ? "s1-decision-evidence-unavailable"
                  : "closed-fixture-byte-observation",
              ],
            })),
          },
    ),
  };
}

export async function selectFixtureObservation(
  input: FixtureInput,
  observation: GrowthSurfaceObservation,
  archivePath: string,
): Promise<GrowthSurfaceObservation> {
  return input.positivePromotion === true
    ? observeClosedFixture(observation, archivePath)
    : observation;
}

export async function metadataRootEvidence(
  input: FixtureInput,
): Promise<GrowthAuthorityMetadataRoot> {
  const capture = async (observation: GrowthSurfaceObservation) => {
    const read = async (path: string): Promise<string> => {
      const result: unknown = await runCommand(
        "git",
        ["show", `${observation.sourceCommit}:${path}`],
        input.repositoryRoot,
      );
      return jsonString(jsonRecord(result).stdout);
    };
    return {
      source: { commit: observation.sourceCommit, tree: observation.sourceTree },
      manifestBytes: await read("package.json"),
      workspaceBytes: await read("pnpm-workspace.yaml"),
      classificationBytes: await read("architecture/metadata-root.json"),
    };
  };
  const evidence: GrowthAuthorityMetadataRoot["evidence"] = {
    kind: "non-release-metadata-root",
    packageName: "sdk-fixture-root",
    rootPath: ".",
    manifestPath: "package.json",
    classificationPath: "architecture/metadata-root.json",
    historyDigest: digest("packed-history"),
    base: await capture(input.trustedBase),
    candidate: await capture(input.candidateObservation),
  };
  const evidenceDigest = digest({ domain: "foundation:sdk-growth:metadata-root:1", evidence });
  return {
    evidence,
    evidenceDigest,
    ownerEvidence: {
      decisionId: "ROOT-1",
      ownerRef: "fixture/sdk-owner",
      decisionDigest: evidenceDigest,
      authenticatedSubjectId: "packed-root-owner",
      authorizationEvidenceDigest: digest("packed-root-authorization"),
      approvalEvidenceDigest: digest("packed-root-approval"),
      sourceBindingDigest: digest("unbound"),
    },
  };
}

export function qualifyMetadataCoverage(
  observation: GrowthSurfaceObservation,
  root: GrowthAuthorityMetadataRoot,
): GrowthSurfaceObservation {
  assert.equal(
    observation.coverage.filter((row) => row.packageName === root.evidence.packageName).length,
    1,
  );
  return {
    ...observation,
    coverage: observation.coverage.map((row) =>
      row.packageName !== root.evidence.packageName
        ? row
        : {
            ...row,
            dimensions: row.dimensions.map((dimension) => ({
              dimension: dimension.dimension,
              status: dimension.dimension === "decision" ? "unavailable" : "complete",
              reasons: [
                dimension.dimension === "decision"
                  ? "s1-decision-evidence-unavailable"
                  : "qualified-non-release-metadata-root",
              ],
            })),
          },
    ),
  };
}

export function expectedReportCoverage(
  base: GrowthSurfaceObservation,
  candidate: GrowthSurfaceObservation,
  admitted: boolean,
): readonly GrowthCoverage[] {
  const rank = { complete: 0, limited: 1, unsupported: 2, unavailable: 3 };
  return candidate.coverage.map((row) => ({
    ...row,
    dimensions: row.dimensions.map((dimension) => {
      if (dimension.dimension === "decision") {
        return {
          dimension: "decision",
          status: admitted ? "complete" : "unavailable",
          reasons: [
            admitted
              ? "growth-decision-set-evaluated"
              : "growth-owner-and-run-authority-unverified",
          ],
        };
      }
      const before = base.coverage
        .find((previous) => previous.packageName === row.packageName)
        ?.dimensions.find((previous) => previous.dimension === dimension.dimension);
      assert.ok(before);
      return {
        dimension: dimension.dimension,
        status: rank[before.status] > rank[dimension.status] ? before.status : dimension.status,
        reasons: [
          ...before.reasons.map((reason) => `trusted-base:${reason}`),
          ...dimension.reasons.map((reason) => `candidate:${reason}`),
        ].toSorted(),
      };
    }),
  }));
}

export async function packedEvidence(
  archivePath: string,
  observation: GrowthSurfaceObservation,
  packageName: string,
  installations: Map<GrowthDigest, string>,
): Promise<GrowthAuthorityPackedEvidence> {
  observation = {
    ...observation,
    entries: observation.entries.filter((row) => row.coordinate.packageName === packageName),
    coverage: observation.coverage.filter((row) => row.packageName === packageName),
  };
  assert.equal(observation.coverage.length, 1);
  const bytes = await readFile(archivePath),
    transportArchive = archiveIdentity(bytes);
  const root = await mkdtemp(join(dirname(archivePath), "installed-custody-"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "packed-custody", private: true }),
  );
  await runNpmCommand(
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--cache",
      join(root, "npm-cache"),
      archivePath,
    ],
    root,
  );
  const installedRoot = join(root, "node_modules", packageName);
  const manifest = jsonRecord(
    JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8")),
  );
  if (manifest.name !== packageName) {
    throw new Error("Installed archive package identity mismatch.");
  }
  const lock = jsonRecord(JSON.parse(await readFile(join(root, "package-lock.json"), "utf8")));
  if (
    jsonRecord(jsonRecord(lock.packages)[`node_modules/${packageName}`]).integrity !==
    transportArchive.archiveIntegrity
  ) {
    throw new Error("Installed archive integrity mismatch.");
  }
  const source = { commit: observation.sourceCommit, tree: observation.sourceTree };
  const observationDigest = digest({
    domain: "foundation:sdk-growth:observation:1",
    payload: observation,
  });
  const extracted = await mkdtemp(join(dirname(archivePath), "archive-custody-"));
  await runCommand("tar", ["-xzf", archivePath, "-C", extracted], extracted);
  const custodyEvidence = canonicalCustody(await installedFiles(join(extracted, "package")));
  const { archiveDigest, archiveIntegrity } = custodyEvidence;
  installations.set(archiveDigest, installedRoot);
  const installedDistribution = {
    packageName,
    packageVersion: jsonString(manifest.version),
    source,
    archiveDigest,
    archiveIntegrity,
    observationDigest,
  };
  return {
    ...installedDistribution,
    observation,
    coverage: observation.coverage[0],
    custodyEvidence,
    custodyEvidenceDigest: digest({
      domain: "foundation:sdk-growth:custody:1",
      payload: custodyEvidence,
    }),
    installedDistribution,
  };
}
