import type {
  QualityCoverageObservation,
  QualityCoverageSession,
} from "../../../packages/engineering-foundation/dist/features/quality-coverage/api.js";

/** Pure policy fixture: filesystem and tool use are explicit test failures. */
export function qualitySessionFixture(
  observation: QualityCoverageObservation,
  overrides: Partial<QualityCoverageSession> = {},
): QualityCoverageSession {
  return {
    consumerRoot: "/disposable consumer",
    observation,
    profile: {
      schemaVersion: 5,
      budgetMs: 120000,
      topologyPath: "topology.json",
      toolchainConfigPath: "toolchain.json",
      sourcePolicyPath: "source.yaml",
      suppressionPolicyPath: "suppressions.yaml",
      lintConfigPath: "lint.json",
      compilerProjects: ["tsconfig.json"],
      scripts: { fast: "check:fast", full: "check", scope: "quality:scope", typed: "lint:typed" },
    },
    topology: {
      schemaVersion: 1,
      censusRoots: [],
      packageRoots: ["."],
      sourceRoots: [],
      testRoots: [],
      excludedRoots: [],
      toolingFiles: [],
    },
    authority: { workspaceManifestPath: "pnpm-workspace.yaml", boundaries: [] },
    dependencies: [],
    readFile: () => Promise.reject(new Error("Pure session fixture cannot read files.")),
    readToolFile: () => Promise.reject(new Error("Pure session fixture cannot read tools.")),
    readBridgeAdmissions: () => Promise.resolve(),
    verify: () => Promise.resolve(),
    remainingMs: () => 120000,
    ...overrides,
  };
}
