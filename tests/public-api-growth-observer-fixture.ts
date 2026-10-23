import assert from "node:assert/strict";
import { required } from "./public-api-growth-matrix-fixture.ts";
import type { MatrixRepository } from "./public-api-growth-matrix-fixture.ts";
import type { MutableFixture } from "./support/growth-authority-test-ports.ts";
import type { GrowthExportTarget } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/growth-workspace.js";
import type { GrowthCompatibilitySubject } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/retain-growth-compatibility.js";
import type { PublicApiSnapshot } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/public-api.js";
import type { ChangeFingerprint } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/ports/change-fingerprint.js";
import { createGrowthObservation } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/use-cases/observe-sdk-growth.js";
import { observedPackageExports } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/validate-package-export-coverage.js";
function requiredStringTarget(
  pkg: {
    exportSurface: { entries: readonly { subpath: string; target?: GrowthExportTarget }[] };
  },
  exportPath: string,
): string {
  const target = required(
    pkg.exportSurface.entries.find((entry) => entry.subpath === exportPath),
  ).target;
  assert.ok(typeof target === "string");
  return target;
}

function matrixWorkspace(repository: MatrixRepository) {
  const packages: {
    name: string;
    rootPath: string;
    manifestPath: string;
    moduleType: "module";
    exportSurface: {
      explicit: boolean;
      entries: {
        subpath: string;
        target: GrowthExportTarget | undefined;
        availability: string;
      }[];
    };
  }[] = repository.packages.map((pkg) => ({
    name: pkg.packageName,
    manifestPath: pkg.manifestPath,
    rootPath: pkg.manifestPath.includes("/")
      ? pkg.manifestPath.slice(0, pkg.manifestPath.lastIndexOf("/"))
      : ".",
    moduleType: "module",
    dependencies: [],
    bundledDependencies: [],
    exportSurface: {
      explicit: !pkg.surface.some((row) => row.shape === "no-exports"),
      entries: pkg.surface
        .filter((row) => row.exportPath !== undefined)
        .map((row) => ({
          subpath: required(row.exportPath),
          target: row.target,
          availability: "available",
        })),
    },
  }));
  const subjects: MutableFixture<GrowthCompatibilitySubject>[] = packages
    .filter((pkg) => pkg.exportSurface.explicit)
    .map((pkg) => {
      const observed = observedPackageExports({
        manifest: {
          exports: Object.fromEntries(
            pkg.exportSurface.entries.map((row) => [row.subpath, row.target]),
          ),
        },
        policy: { packageName: pkg.name, packageRoot: pkg.rootPath },
      });
      return {
        packageVersion: required(repository.packages.find((row) => row.packageName === pkg.name))
          .version,
        policy: {
          packageName: pkg.name,
          packageRoot: pkg.rootPath,
          manifestPath: pkg.manifestPath,
          tsconfigPath: "tsconfig.json",
          releasedBaselinePath: "unused.json",
          approvedBreakingChanges: [],
          entrypoints: observed
            .filter((row) => row.kind === "typed")
            .map((row) => ({
              exportPath: row.exportPath,
              declarationEntryPoint: required(row.declarationEntryPoint),
            })),
          nonTypeExports: observed
            .filter((row) => row.kind !== "typed")
            .map((row) => {
              assert.ok(row.kind !== "typed");
              return { exportPath: row.exportPath, kind: row.kind };
            }),
        },
      };
    });
  return { packages, subjects };
}
export function createMatrixObservationFixture(
  repository: MatrixRepository,
  fingerprint: ChangeFingerprint,
  digest: `sha256:${string}`,
) {
  const { packages, subjects } = matrixWorkspace(repository);
  const calls: { workspace: number; typed: string[]; artifact: string[] } = {
    workspace: 0,
    typed: [],
    artifact: [],
  };
  const dependencies: {
    workspace: Parameters<typeof createGrowthObservation>[1]["workspace"];
    typed: {
      extract(
        ...args: Parameters<Parameters<typeof createGrowthObservation>[1]["typed"]["extract"]>
      ): Promise<MutableFixture<PublicApiSnapshot>>;
    };
    artifact: Parameters<typeof createGrowthObservation>[1]["artifact"];
    fingerprint: Parameters<typeof createGrowthObservation>[1]["fingerprint"];
  } = {
    fingerprint,
    workspace: {
      async read() {
        calls.workspace++;
        return { packages, catalogs: [] };
      },
    },
    typed: {
      async extract(_root, policy, packageVersion): Promise<MutableFixture<PublicApiSnapshot>> {
        calls.typed.push(policy.packageName);
        return {
          schemaVersion: 1,
          packageName: policy.packageName,
          packageVersion,
          extractorVersion: "pinned",
          entrypoints: policy.entrypoints.map((entry) => ({
            exportPath: entry.exportPath,
            items: [
              {
                canonicalReference: "opaque!same-reference",
                kind: "Function",
                parentKind: "EntryPoint",
                signature: "export declare function fixture(): void;",
              },
            ],
          })),
        };
      },
    },
    artifact: {
      async inspect(_root, policies) {
        return policies.map((policy) => {
          calls.artifact.push(policy.packageName);
          const pkg = required(packages.find((row) => row.name === policy.packageName));
          const wildcardExports = policy.nonTypeExports
            .filter((row) => row.kind === "wildcard")
            .map((row) => ({
              exportPath: row.exportPath,
              targetPattern: requiredStringTarget(pkg, row.exportPath).slice(2),
              members: [
                requiredStringTarget(pkg, row.exportPath)
                  .slice(2)
                  .replaceAll("*", "fixture.schema.json"),
              ],
            }));
          return {
            schemaVersion: 1,
            packageName: policy.packageName,
            packageVersion: required(
              subjects.find((row) => row.policy.packageName === policy.packageName),
            ).packageVersion,
            status: "release-candidate",
            wildcardExports,
            jsonSchemas: wildcardExports.flatMap((row) =>
              row.members.map((path) => ({
                path,
                id: `https://fixture/${path}`,
                digest,
                discriminators: {},
              })),
            ),
          };
        });
      },
    },
  };
  return {
    packages,
    subjects,
    calls,
    dependencies,
    port() {
      return createGrowthObservation(
        { consumerRoot: "/unused", workspaceManifestPath: "pnpm-workspace.yaml", subjects },
        dependencies,
      );
    },
  };
}
