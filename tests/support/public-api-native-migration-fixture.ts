import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeChangeFingerprint } from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/crypto/node-change-fingerprint.js";
import type { promotePublicApiBaselines } from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/use-cases/promote-public-api-baselines.js";
import {
  evaluatePublicApiCompatibility,
  classifyPublicApiChange,
} from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/evaluate-public-api-compatibility.js";
import {
  foundationReport,
  capabilityReport,
} from "../../packages/engineering-foundation/dist/features/validation-reporting/api.js";
import type {
  PublicApiCompatibilityPolicy,
  PublicApiSnapshot,
} from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/public-api.js";
import type { PublicApiRepository } from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/ports/public-api-repository.js";
import type { FoundationCheckReport } from "../../packages/engineering-foundation/dist/features/validation-reporting/api.js";
import {
  migrationBytes,
  migrationDigest,
  type NativeMigrationReview,
  type NativeMigrationObservation,
} from "../../scripts/public-api-native-migration.ts";
import {
  nativeMigrationPackageNames,
  nativeMigrationToolDifference,
} from "../../scripts/public-api-native-migration-observation.ts";

export type Dependencies = Parameters<typeof promotePublicApiBaselines>[1];
const fingerprint = new NodeChangeFingerprint();
export function fixture() {
  const policy: PublicApiCompatibilityPolicy = {
    schemaVersion: 1,
    acceptedDecisionBaselinePath: "architecture/decisions/accepted-decisions.json",
    changesetDirectory: ".changeset",
    packages: nativeMigrationPackageNames.map((packageName) => {
      const local = packageName.split("/").at(-1)!;
      return {
        packageName,
        packageRoot: `packages/${local}`,
        manifestPath: `packages/${local}/package.json`,
        tsconfigPath: `packages/${local}/tsconfig.json`,
        releasedBaselinePath: `architecture/public-api/${local}.json`,
        approvedBreakingChanges: [],
        entrypoints: [
          { exportPath: ".", declarationEntryPoint: `packages/${local}/dist/index.d.ts` },
        ],
        nonTypeExports: [],
      };
    }),
  };
  const packages = policy.packages.map((p) => {
    const baseline: PublicApiSnapshot = {
      schemaVersion: 1,
      packageName: p.packageName,
      packageVersion: "1.0.0",
      extractorVersion: "7.58.12",
      entrypoints: [
        {
          exportPath: ".",
          items: [
            {
              canonicalReference: `${p.packageName}!Value:type`,
              kind: "TypeAlias",
              parentReference: `${p.packageName}!`,
              parentKind: "EntryPoint",
              signature: "export type Value = string;",
            },
          ],
        },
      ],
    };
    const nativeReleased: PublicApiSnapshot = {
      ...baseline,
      extractorVersion: "typescript-native/7.0.2",
    };
    return {
      packageName: p.packageName,
      baselineDigest: migrationDigest(migrationBytes(baseline)),
      archiveDigest: migrationDigest(Buffer.from(p.packageName)),
      archiveIntegrity: fingerprint.sha512Integrity(p.packageName),
      configDigest: migrationDigest(Buffer.from("{}")),
      releasedInputsDigest: migrationDigest(Buffer.from(`inputs:${p.packageName}`)),
      nativeReleasedDigest: migrationDigest(migrationBytes(nativeReleased)),
      baseline,
      nativeReleased,
      nativeCandidate: structuredClone(nativeReleased),
    };
  });
  const toolDiff = nativeMigrationToolDifference(packages);
  const observation: NativeMigrationObservation = {
    kind: "foundation:public-api-native-migration:observation:1",
    policyDigest: migrationDigest(migrationBytes(policy)),
    toolchainIdentity: "fixture-native7",
    packages,
    toolDiff,
    toolDiffDigest: migrationDigest(migrationBytes(toolDiff)),
    typedDiagnostics: [],
    artifactDiagnostics: [],
  };
  const review: NativeMigrationReview = {
    kind: "foundation:public-api-native-migration:review:1",
    from: "7.58.12",
    to: "typescript-native/7.0.2",
    baselineSourceCommit: "a".repeat(40),
    policyDigest: observation.policyDigest,
    toolDiffDigest: observation.toolDiffDigest,
    packages: packages.map((p, index) => ({
      packageName: p.packageName,
      baselinePath: policy.packages[index]!.releasedBaselinePath,
      baselineDigest: p.baselineDigest,
      archiveDigest: p.archiveDigest,
      archiveIntegrity: p.archiveIntegrity,
      configDigest: p.configDigest,
      releasedInputsDigest: p.releasedInputsDigest,
      nativeReleasedDigest: p.nativeReleasedDigest,
    })),
  };
  return { policy, observation, review };
}

export async function ordinaryReport(
  f: ReturnType<typeof fixture>,
): Promise<FoundationCheckReport> {
  const diagnostics: ReturnType<typeof evaluatePublicApiCompatibility>[number][] = [];
  for (const [index, p] of f.policy.packages.entries()) {
    diagnostics.push(
      ...evaluatePublicApiCompatibility({
        policy: p,
        released: f.observation.packages[index]!.baseline,
        current: f.observation.packages[index]!.nativeCandidate,
        change: await classifyPublicApiChange(
          f.observation.packages[index]!.baseline,
          f.observation.packages[index]!.nativeCandidate,
          fingerprint,
        ),
        releaseEvidence: { packageName: p.packageName, packageVersion: "1.0.0" },
        acceptedDecision: undefined,
      }),
    );
  }
  return foundationReport({
    foundationVersion: "1.8.0",
    coverage: "full",
    capabilities: [
      capabilityReport({
        capabilityId: "architecture.source-dependencies",
        capabilityConfigSchemaVersion: 2,
      }),
      capabilityReport({
        capabilityId: "package.public-api-compatibility",
        capabilityConfigSchemaVersion: 1,
        diagnostics,
      }),
    ],
  });
}
export const expectedCapabilities = [
  { capabilityId: "architecture.source-dependencies", capabilityConfigSchemaVersion: 2 },
  { capabilityId: "package.public-api-compatibility", capabilityConfigSchemaVersion: 1 },
];

export async function withPromotionFixture(
  action: (
    f: ReturnType<typeof fixture> & {
      root: string;
      typed: Dependencies;
      artifacts: Dependencies;
      writes: string[];
      failNext: { packageName?: string };
    },
  ) => Promise<void>,
) {
  const f = fixture();
  const root = await mkdtemp(join(tmpdir(), "native-api-migration-"));
  const cached = new Map<string, Buffer>();
  const writes: string[] = [];
  const failNext: { packageName?: string } = {};
  for (const p of f.policy.packages) {
    await mkdir(dirname(join(root, p.releasedBaselinePath)), { recursive: true });
    await writeFile(
      join(root, p.releasedBaselinePath),
      migrationBytes(f.observation.packages.find((x) => x.packageName === p.packageName)!.baseline),
    );
  }
  const repository: PublicApiRepository = {
    readReleasedBaseline: async (_root, p) => {
      const b = await readFile(join(root, p.releasedBaselinePath));
      cached.set(p.packageName, b);
      return JSON.parse(b.toString("utf8")) as PublicApiSnapshot;
    },
    readReleaseEvidence: async (_root, _changesets, p) => ({
      packageName: p.packageName,
      packageVersion: f.observation.packages.find((x) => x.packageName === p.packageName)!
        .nativeCandidate.packageVersion,
      declaredBump: "major",
    }),
    describeReleasedBaselineWrite: async (_root, p, snapshot) => ({
      destination: p.releasedBaselinePath,
      operation: "replace",
      preimageDigest: migrationDigest(cached.get(p.packageName)!),
      proposedDigest: migrationDigest(migrationBytes(snapshot)),
    }),
    writeReleasedBaseline: async (_root, p, snapshot) => {
      if (failNext.packageName === p.packageName) {
        delete failNext.packageName;
        throw new Error("simulated process interruption");
      }
      assert.deepEqual(
        await readFile(join(root, p.releasedBaselinePath)),
        cached.get(p.packageName),
        "writer retains actual cached physical preimage",
      );
      await writeFile(join(root, p.releasedBaselinePath), migrationBytes(snapshot));
      writes.push(p.packageName);
    },
  };
  const typed: Dependencies = {
    repository,
    fingerprint,
    acceptedDecisionEvidence: {
      readAcceptedDecisionEvidence: async () => ({
        acceptedDecisionIds: [],
        acceptedDecisionPaths: [],
      }),
    },
    extractor: {
      extract: async (_root, p) =>
        f.observation.packages.find((x) => x.packageName === p.packageName)!.nativeCandidate,
    },
  };
  const artifact = (name: string): PublicApiSnapshot => ({
    schemaVersion: 1,
    packageName: name,
    packageVersion: f.observation.packages.find((x) => x.packageName === name)!.nativeCandidate
      .packageVersion,
    extractorVersion: "package-artifact-inventory/1",
    entrypoints: [{ exportPath: ".", items: [] }],
  });
  const artifacts: Dependencies = {
    ...typed,
    repository: {
      ...repository,
      readReleasedBaseline: async (_root, p) => artifact(p.packageName),
      writeReleasedBaseline: async () => {
        throw new Error("unchanged artifact surface must not write");
      },
    },
    extractor: { extract: async (_root, p) => artifact(p.packageName) },
  };
  try {
    await action({ ...f, root, typed, artifacts, writes, failNext });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
