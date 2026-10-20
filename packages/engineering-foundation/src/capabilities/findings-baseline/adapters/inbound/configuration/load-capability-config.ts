import { assertConfigRepositoryRelativePath, inputFailure } from "../../../application/configuration-input.js";
import type { FindingsBaselinePolicy } from "../../../application/model.js";

export interface FindingsBaselineConfigurationDependencies {
  readonly readYaml: (consumerRoot: string, configPath: string, phase: string, signal?: AbortSignal) => Promise<unknown>;
  readonly assertSchema: (schemaId: "quality-findings-baseline/v1", input: unknown, phase: string) => Promise<void>;
}

const PHASE = "findings-baseline-config";

function repositoryPath(path: string): string {
  assertConfigRepositoryRelativePath(path, PHASE);
  return path;
}

/** The JSON Schema fixes the shape; this adds the repository-relative path rules the schema cannot express. */
function mapPolicy(input: unknown): FindingsBaselinePolicy {
  const { baselinePath, oxlint } = input as { baselinePath: string; oxlint: { configPath: string; roots: string[]; measuredRules?: string[] } };
  const measuredRules = oxlint.measuredRules ?? [];
  if (new Set(measuredRules).size !== measuredRules.length) { inputFailure("FINDINGS_BASELINE_CONFIG_INVALID", "oxlint.measuredRules must not repeat a rule.", PHASE); }
  return Object.freeze({
    baselinePath: repositoryPath(baselinePath),
    oxlint: Object.freeze({
      configPath: repositoryPath(oxlint.configPath),
      roots: Object.freeze(oxlint.roots.map(repositoryPath)),
      measuredRules: Object.freeze([...measuredRules])
    })
  });
}

export async function loadCapabilityConfig(
  dependencies: FindingsBaselineConfigurationDependencies,
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal
): Promise<FindingsBaselinePolicy> {
  const input = await dependencies.readYaml(consumerRoot, configPath, PHASE, signal);
  await dependencies.assertSchema("quality-findings-baseline/v1", input, PHASE);
  return mapPolicy(input);
}
