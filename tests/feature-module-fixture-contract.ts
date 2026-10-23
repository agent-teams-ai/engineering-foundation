export interface Boundary {
  id: string;
  roots: string[];
  entrypoints: string[];
  allow: {
    boundaries: string[];
    packages: string[];
    builtins: string[];
    runtimeReferences: string[];
  };
}
export interface ModuleFixture {
  id: string;
  packageName: string;
  root: string;
  sourceRoot: string;
  role: string;
  preferredFeatureRoot: string;
  testRoots?: string[];
  publicEntrypoints: string[];
  moduleAssembly: string[];
  generatedRoots: { root: string; generator: string; sources: string[] }[];
  exceptions: {
    path: string;
    decision?: string;
    owner?: string;
    rationale?: string;
    reviewTrigger?: string;
  }[];
  features: {
    id: string;
    role: string;
    testRoots: string[];
    layers: { role: string; roots: string[] }[];
  }[];
}
export interface FeatureFixture {
  repositoryRoot: string;
  sourceRoot: string;
  profile: {
    standard: { id: string; version: string; path: string; digest: string };
    modules: ModuleFixture[];
    [key: string]: unknown;
  };
  sourcePolicy: { boundaries: Boundary[]; governedRoots: string[]; [key: string]: unknown };
  write: (path: string, content: string) => Promise<void>;
  check: (packages?: { name: string; root: string }[]) => Promise<{
    problems: { code: string; message: string; [key: string]: unknown }[];
    [key: string]: unknown;
  }>;
}
