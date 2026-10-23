import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { GrowthExportTarget } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/growth-workspace.js";
import type {
  GrowthEvidence,
  GrowthObservationExecution,
} from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/growth-observation.js";
interface MatrixSurface {
  shape: string;
  exportPath?: string;
  target?: GrowthExportTarget;
}
export interface MatrixRepository {
  repository: string;
  packages: {
    packageName: string;
    version: string;
    manifestPath: string;
    surface: MatrixSurface[];
  }[];
}
function isDataRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function dataRecord(value: unknown): Record<string, unknown> {
  assert.ok(isDataRecord(value));
  return value;
}
function string(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}
function exportTarget(value: unknown): GrowthExportTarget {
  if (value === null || typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return (value as unknown[]).map(exportTarget);
  }
  const record = dataRecord(value);
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, exportTarget(item)]));
}
export function readGrowthSurfaceMatrix() {
  const parsed: unknown = JSON.parse(
    readFileSync(
      new URL("../docs/reference/sdk-growth-c0/surface-matrix.json", import.meta.url),
      "utf8",
    ),
  );
  const root = dataRecord(parsed);
  assert.ok(Array.isArray(root.repositories));
  return {
    repositories: (root.repositories as unknown[]).map((raw): MatrixRepository => {
      const repository = dataRecord(raw);
      assert.equal(typeof repository.repository, "string");
      assert.ok(Array.isArray(repository.packages));
      return {
        repository: string(repository.repository),
        packages: (repository.packages as unknown[]).map((rawPackage) => {
          const pkg = dataRecord(rawPackage);
          assert.equal(typeof pkg.packageName, "string");
          assert.equal(typeof pkg.version, "string");
          assert.equal(typeof pkg.manifestPath, "string");
          assert.ok(Array.isArray(pkg.surface));
          return {
            packageName: string(pkg.packageName),
            version: string(pkg.version),
            manifestPath: string(pkg.manifestPath),
            surface: (pkg.surface as unknown[]).map((rawSurface) => {
              const row = dataRecord(rawSurface);
              assert.equal(typeof row.shape, "string");
              if (row.exportPath === undefined) {
                return { shape: string(row.shape) };
              }
              assert.equal(typeof row.exportPath, "string");
              return {
                shape: string(row.shape),
                exportPath: string(row.exportPath),
                ...(row.target === undefined ? {} : { target: exportTarget(row.target) }),
              };
            }),
          };
        }),
      };
    }),
  };
}
export function available<T>(evidence: GrowthEvidence<T>): T {
  assert.equal(evidence.status, "available");
  return evidence.value;
}
export const growthTypedEntries = (result: GrowthObservationExecution) =>
  available(result.surface).entries.filter((row) => row.coordinate.subject.kind === "typed");
export function required<T>(value: T | undefined): T {
  assert.notEqual(value, undefined);
  return value!;
}
