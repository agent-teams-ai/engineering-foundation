import type { DocumentationLocalReferencesPolicy } from "../../../application/model/documentation-local-references.js";
import { parseCapabilityConfig } from "./parse-capability-config.js";

export interface DocumentationConfigurationDependencies {
  readonly readYaml: (
    consumerRoot: string,
    configPath: string,
    phase: string,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  readonly assertSchema: (
    schemaId: "documentation-local-references/v1" | "documentation-local-references/v2",
    input: unknown,
    phase: string,
  ) => Promise<void>;
}

export async function loadCapabilityConfig(
  dependencies: DocumentationConfigurationDependencies,
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal,
  observeSchemaVersion?: (version: 1 | 2) => void,
): Promise<DocumentationLocalReferencesPolicy> {
  const input = await dependencies.readYaml(
    consumerRoot,
    configPath,
    "documentation-local-references-config",
    signal,
  );
  const version =
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    "schemaVersion" in input &&
    input.schemaVersion === 2
      ? 2
      : 1;
  observeSchemaVersion?.(version);
  await dependencies.assertSchema(
    version === 2 ? "documentation-local-references/v2" : "documentation-local-references/v1",
    input,
    "documentation-local-references-config",
  );
  return parseCapabilityConfig(input);
}
