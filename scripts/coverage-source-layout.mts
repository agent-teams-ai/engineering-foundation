import type { Buffer } from "node:buffer";

// Type-only contracts for the existing JavaScript coverage transport. Runtime
// workers must not import this module and initialize Node's TypeScript loader.
export interface CoverageSourceMapData {
  file?: unknown;
  sourceRoot?: unknown;
  sources?: unknown;
}

export interface CoverageCacheEntry {
  url?: unknown;
  data?: CoverageSourceMapData | null;
}

export interface CoverageReport {
  result: Array<{ url?: unknown }>;
  "source-map-cache"?: Record<string, CoverageCacheEntry | null> | null;
}

export interface CoverageTestSource {
  sourceRoot: string;
  testPath: string;
}

export type CoverageTestIdentifier = (report: CoverageReport, filename: string) => CoverageTestSource;
export type CoverageProjector = (value: unknown) => unknown;

export interface ValidatedCoverageArtifact {
  evidence: {
    shard: { id: string };
    rawFiles: Array<{ path: string; sha256: string; size: number }>;
  };
  sourceRoot: string;
  validatedFiles: ReadonlyArray<{ bytes: Buffer; name: string }>;
}

export interface ValidatedCoverage {
  artifacts: readonly ValidatedCoverageArtifact[];
}
