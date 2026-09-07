import type { DocumentationLocalReferencesPolicy } from "../../../application/model/documentation-local-references.js";
import { parseCapabilityConfig } from "./parse-capability-config.js";

export interface DocumentationConfigurationDependencies {
  readonly readYaml: (consumerRoot: string, configPath: string, phase: string, signal?: AbortSignal) => Promise<unknown>;
  readonly assertSchema: (schemaId: "documentation-local-references/v1", input: unknown, phase: string) => Promise<void>;
}

export async function loadCapabilityConfig(
  dependencies: DocumentationConfigurationDependencies,
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal
): Promise<DocumentationLocalReferencesPolicy> {
  const input = await dependencies.readYaml(
    consumerRoot,
    configPath,
    "documentation-local-references-config",
    signal
  );
  await dependencies.assertSchema(
    "documentation-local-references/v1",
    input,
    "documentation-local-references-config"
  );
  return parseCapabilityConfig(input);
}
